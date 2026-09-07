// Photo hunt — the game mode. You're handed a short shot list ("a large oak, up
// close", "three aspens in one frame") and a roll of film. Find the subject in
// the fog, frame it in the viewfinder, shoot. Every accepted photo turns the
// season, so the five shots walk you through a year. The roll runs out before
// you can brute-force it.
//
// Nothing here is a 3D model. The subjects are the trees the world already
// streams; the camera is a DOM overlay; a photo is the PS1 buffer read straight
// off the canvas after the composer draws. Framing is scored, not judged: every
// candidate tree's bounding sphere is projected to screen and the shot is graded
// on size, centring and whether a nearer tree covers it.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';
import { CONFIG } from './chunk.js';

const SHOTS = 5;
const FILM = 12;
const SEASON_CYCLE = ['verano', 'otono', 'invierno', 'primavera'];
const SEASON_LABEL = { verano: 'Summer', otono: 'Autumn', invierno: 'Winter', primavera: 'Spring' };
const SPECIES_NAME = { oak: 'oak', ash: 'ash', aspen: 'aspen', pine: 'pine' };
const SIZE_NAME = { l: 'large', m: 'medium', s: 'small' };
const VIEW = 0.72;                   // half-extent of the viewfinder box in NDC
const HINT_AFTER = 40;               // seconds without a shot before the compass shows
const POINTS = { S: 300, A: 200, B: 120, C: 60 };

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Shot list ────────────────────────────────────────────────────────────────
// Built from the templates the tier actually loaded and the species the forest
// config actually spawns, so nothing on the list is impossible. Same seed, same
// list. Difficulty ramps: a warm-up, then species, then a group, then a big one.
function buildShotList(seed, templates) {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const trees = templates.filter(t => t.category === 'tree');
  const species = [...new Set(trees.map(t => t.id.split('-')[0]))]
    .filter(sp => (CONFIG.speciesWeight[sp] ?? 1) > 0.05);
  const sizesFor = sp => trees.filter(t => t.id.startsWith(sp + '-')).map(t => t.id.split('-')[1]);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  let last = null;
  const nextSpecies = () => {
    let sp = pick(species);
    if (species.length > 1) while (sp === last) sp = pick(species);
    last = sp;
    return sp;
  };

  const list = [];
  list.push({ framing: 'close' });                                    // 1 — any tree, close
  { const sp = nextSpecies(); list.push({ species: sp, framing: 'close' }); }
  { const sp = nextSpecies(); list.push({ species: sp, framing: 'wide' }); }
  { const sp = nextSpecies(); list.push({ species: sp, count: 3 }); }
  {
    const sp = nextSpecies();
    const sizes = sizesFor(sp);
    if (CONFIG.giantChance >= 0.01 && rng() < 0.5) list.push({ giant: true });
    else if (sizes.includes('l')) list.push({ species: sp, size: 'l', framing: 'close' });
    else list.push({ species: sp, size: pick(sizes), framing: 'close' });
  }
  return list.slice(0, SHOTS);
}

function describe(shot) {
  if (shot.giant) return 'a giant';
  const sp = shot.species ? SPECIES_NAME[shot.species] : null;
  if (shot.count) return `${['', 'one', 'two', 'three', 'four'][shot.count]} ${sp}s in one frame`;
  const size = shot.size ? SIZE_NAME[shot.size] + ' ' : '';
  const noun = sp ? `${size}${sp}` : (size ? `${size}tree` : null);
  const subject = noun ? `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}` : 'any tree';
  if (shot.framing === 'close') return `${subject}, up close`;
  if (shot.framing === 'wide') return `${subject}, from a distance`;
  return subject;
}

function matches(shot, tree, tpl) {
  if (tpl.category !== 'tree') return false;
  if (shot.giant) return !!tree.giant;
  const [sp, size] = tpl.id.split('-');
  if (shot.species && sp !== shot.species) return false;
  if (shot.size && size !== shot.size) return false;
  return true;
}

// Size score from the projected radius (in half-viewport-heights). Plateau of 1
// between lo..hi, linear falloff to 0 at lo0 / hi0.
function band(r, lo0, lo, hi, hi0) {
  if (r <= lo0 || r >= hi0) return 0;
  if (r < lo) return (r - lo0) / (lo - lo0);
  if (r > hi) return (hi0 - r) / (hi0 - hi);
  return 1;
}
// Bands on projected radius (close, any, giant) or on distance as a fraction of
// the fog distance (wide) — "from a distance" has to mean the same thing on a
// tier whose fog sits at 18 m as on one where it sits at 28 m.
const BANDS = {
  close: [0.25, 0.55, 1.20, 2.00],
  any:   [0.06, 0.15, 1.20, 2.00],
  giant: [0.30, 0.80, 4.00, 6.00],
};
const WIDE_BAND = [0.30, 0.50, 1.05, 1.30];

function rate(score) {
  if (score >= 0.85) return 'S';
  if (score >= 0.65) return 'A';
  if (score >= 0.45) return 'B';
  if (score >= 0.28) return 'C';
  return null;
}

// ── Shutter sound — synthesised, no sample ───────────────────────────────────
let actx = null;
function shutterSound() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    const click = (t, f, dur, gain) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
    };
    click(t0, 1800, 0.03, 0.12);
    click(t0 + 0.045, 900, 0.05, 0.10);
  } catch (_) { /* no audio, no problem */ }
}

// ── The mode ─────────────────────────────────────────────────────────────────
export function buildPhotoHunt({
  camera, renderer, world, templates, seed, mobile,
  startSeason = 'verano', onSeason, onExit, renderDistance = 28,
}) {
  const shots = buildShotList(seed, templates);
  const album = [];                    // { url, shot, grade, score }
  let idx = 0;
  let film = FILM;
  let seasonIdx = Math.max(0, SEASON_CYCLE.indexOf(startSeason));
  let wantsCapture = false;
  let busy = false;                    // review card up, ignore the shutter
  let finished = false;
  let elapsed = 0;
  let sinceLast = 0;
  const startedAt = performance.now();

  // ── DOM ──
  const style = document.createElement('style');
  style.textContent = `
    .ph { font-family: 'Chakra Petch', system-ui, sans-serif; color: #eaf3ff; user-select: none; }
    .ph-vf { position: fixed; inset: 0; pointer-events: none; z-index: 30; }
    .ph-vf .c { position: absolute; width: 34px; height: 34px; border: 2px solid rgba(143,230,255,0.85);
                filter: drop-shadow(0 0 3px rgba(0,0,0,0.9)); }
    .ph-vf .tl { top: 14%; left: 14%; border-right: 0; border-bottom: 0; }
    .ph-vf .tr { top: 14%; right: 14%; border-left: 0; border-bottom: 0; }
    .ph-vf .bl { bottom: 14%; left: 14%; border-right: 0; border-top: 0; }
    .ph-vf .br { bottom: 14%; right: 14%; border-left: 0; border-top: 0; }
    .ph-vf .dot { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
                  border: 1px solid rgba(143,230,255,0.9); }
    .ph-flash { position: fixed; inset: 0; z-index: 30; background: #fff; opacity: 0; pointer-events: none; }
    .ph-box { background: linear-gradient(180deg, rgba(20,46,96,0.85), rgba(12,30,64,0.80));
              border: 2px solid #6fb6e8; box-shadow: inset 0 0 14px rgba(60,120,180,0.28), 0 6px 24px rgba(0,0,0,0.5); }
    .ph-task { position: fixed; top: 64px; left: 12px; z-index: 31; padding: 10px 14px; min-width: 220px; max-width: 300px; }
    .ph-task .k { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: #8fe6ff; opacity: .85; }
    .ph-task .v { font-size: 17px; font-weight: 600; margin-top: 2px; line-height: 1.2; }
    .ph-task .s { margin-top: 8px; font-size: 11px; letter-spacing: .12em; color: #93b2cc; text-transform: uppercase; }
    .ph-film { position: fixed; top: 64px; right: 12px; z-index: 31; padding: 8px 12px; text-align: right; }
    .ph-film .k { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: #8fe6ff; opacity: .85; }
    .ph-film .v { font-size: 22px; font-weight: 700; letter-spacing: .08em; font-variant-numeric: tabular-nums; }
    .ph-film.low .v { color: #ffd866; animation: phblink 1s steps(2) infinite; }
    @keyframes phblink { 50% { opacity: .35 } }
    .ph-hint { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 31; text-align: center;
               font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #8fe6ff;
               text-shadow: 0 1px 4px rgba(0,0,0,.9); pointer-events: none; transition: opacity 1s ease; }
    .ph-compass { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: 31; padding: 6px 12px;
                  font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #ffd866; opacity: 0;
                  transition: opacity .6s ease; pointer-events: none; }
    .ph-compass.show { opacity: 1; }
    .ph-msg { position: fixed; left: 50%; top: 58%; transform: translateX(-50%); z-index: 31; padding: 8px 14px;
              font-size: 14px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #ffd866;
              opacity: 0; transition: opacity .25s ease; pointer-events: none; white-space: nowrap; }
    .ph-msg.show { opacity: 1; }
    .ph-review { position: fixed; right: 12px; bottom: 12px; z-index: 32; width: 236px; padding: 8px 8px 10px;
                 transform: translateY(24px); opacity: 0; transition: all .28s cubic-bezier(.2,.8,.2,1); }
    .ph-review.show { transform: none; opacity: 1; }
    .ph-review img { display: block; width: 100%; image-rendering: pixelated; border: 1px solid rgba(120,180,230,0.35); }
    .ph-review .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; }
    .ph-review .cap { font-size: 12px; color: #93b2cc; }
    .ph-grade { font-size: 26px; font-weight: 700; line-height: 1; text-shadow: 0 0 10px rgba(143,230,255,.5); }
    .ph-grade.S { color: #ffd866; } .ph-grade.A { color: #9ad27a; } .ph-grade.B { color: #8fe6ff; } .ph-grade.C { color: #cfd5dc; }
    .ph-shutter { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 33; width: 74px; height: 74px;
                  border-radius: 50%; border: 3px solid #eaf3ff; background: rgba(255,212,130,0.92); cursor: pointer;
                  box-shadow: 0 0 0 4px rgba(12,30,64,0.7), 0 6px 18px rgba(0,0,0,.6); }
    .ph-shutter:active { transform: translateX(-50%) scale(.94); }
    .ph-end { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
              background: rgba(6,18,15,0.82); padding: 16px; overflow: auto; }
    .ph-end .card { width: 100%; max-width: 620px; padding: 18px 18px 14px; }
    .ph-end h2 { margin: 0; font-size: 22px; letter-spacing: .1em; text-align: center; text-shadow: 0 0 12px rgba(143,230,255,.55); }
    .ph-end .sub { margin: 4px 0 14px; text-align: center; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #9ad27a; }
    .ph-end .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .ph-end .p { background: rgba(8,20,44,0.6); border: 1px solid #2b5e93; padding: 6px; }
    .ph-end .p img { display: block; width: 100%; image-rendering: pixelated; }
    .ph-end .p .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 6px; }
    .ph-end .p .cap { font-size: 10px; color: #93b2cc; line-height: 1.2; }
    .ph-end .p .ph-grade { font-size: 18px; }
    .ph-end .p.miss { opacity: .45; display: flex; align-items: center; justify-content: center; min-height: 110px;
                      font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #93b2cc; }
    .ph-end .tot { display: flex; justify-content: space-between; margin: 14px 0 10px; font-size: 13px; letter-spacing: .08em; }
    .ph-end .tot b { font-size: 18px; color: #ffd866; }
    .ph-end .btns { display: flex; gap: 8px; }
    .ph-end button { flex: 1; padding: 11px; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600;
                     letter-spacing: .08em; color: #eaf3ff; background: rgba(8,20,44,0.6); border: 1px solid #2b5e93; }
    .ph-end button:hover { border-color: #6fb6e8; color: #fff; }
    .ph-end button.pri { color: #06121f; background: linear-gradient(180deg, #ffe27a, #f3c645); border-color: #fff3c0; }
    body.ui-hidden .ph-ui { display: none !important; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ph ph-ui';
  root.innerHTML = `
    <div class="ph-flash"></div>
    <div class="ph-vf"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><i class="dot"></i></div>
    <div class="ph-box ph-task"><div class="k">Shot <span class="n"></span> of ${SHOTS}</div><div class="v"></div><div class="s"></div></div>
    <div class="ph-box ph-film"><div class="k">Film</div><div class="v"></div></div>
    <div class="ph-box ph-compass"></div>
    <div class="ph-box ph-msg"></div>
    <div class="ph-box ph-review"><img alt=""><div class="row"><span class="cap"></span><span class="ph-grade"></span></div></div>
    <div class="ph-hint"></div>
  `;
  document.body.appendChild(root);
  const flashEl = root.querySelector('.ph-flash');
  let flashT = 0;
  const taskN = root.querySelector('.ph-task .n');
  const taskV = root.querySelector('.ph-task .v');
  const taskS = root.querySelector('.ph-task .s');
  const filmBox = root.querySelector('.ph-film');
  const filmV = root.querySelector('.ph-film .v');
  const compass = root.querySelector('.ph-compass');
  const msg = root.querySelector('.ph-msg');
  const review = root.querySelector('.ph-review');
  const hint = root.querySelector('.ph-hint');
  hint.textContent = mobile ? 'joystick to move · drag to look · tap the shutter' : 'WASD move · shift run · space or click to shoot';
  if (mobile) hint.style.bottom = '108px';

  let shutterBtn = null;
  if (mobile) {
    shutterBtn = document.createElement('button');
    shutterBtn.type = 'button';
    shutterBtn.className = 'ph-shutter ph-ui';
    shutterBtn.setAttribute('aria-label', 'Shutter');
    shutterBtn.addEventListener('click', shoot);
    document.body.appendChild(shutterBtn);
  }

  function paint() {
    const shot = shots[idx];
    taskN.textContent = String(idx + 1);
    taskV.textContent = shot ? describe(shot) : '';
    taskS.textContent = SEASON_LABEL[SEASON_CYCLE[seasonIdx]];
    filmV.textContent = String(film).padStart(2, '0');
    filmBox.classList.toggle('low', film <= 3);
  }
  paint();

  let msgTimer = null;
  function flashMsg(text) {
    msg.textContent = text;
    msg.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => msg.classList.remove('show'), 1400);
  }

  // ── Scoring ──
  const _v = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  function project(tree) {
    const tpl = templates[tree.templateIdx];
    const h = tpl.height * tree.scale;
    const gy = terrainHeight(tree.x, tree.z);
    _v.set(tree.x, gy + h * 0.5, tree.z);
    const dx = tree.x - camera.position.x, dz = tree.z - camera.position.z;
    const dist = Math.hypot(dx, dz);
    // Behind the camera → out.
    camera.getWorldDirection(_fwd);
    if (dx * _fwd.x + dz * _fwd.z <= 0) return null;
    _v.project(camera);
    if (_v.z > 1) return null;
    // Projected radius in half-viewport-heights: the sphere's world radius over
    // the visible half-height at that depth.
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.max(0.1, dist);
    const r = (h * 0.5) / halfH;
    const tw = (tpl.trunkRadius * tree.scale) / (halfH * camera.aspect);   // trunk half-width, NDC x
    return { tree, tpl, x: _v.x, y: _v.y, r, tw, dist, h };
  }

  function evaluate(shot) {
    const near = world.getNearbyTrees(camera.position.x, camera.position.z, 60);
    const inFrame = [];
    const all = [];
    for (const t of near) {
      const p = project(t);
      if (!p) continue;
      all.push(p);
      if (Math.abs(p.x) <= VIEW && Math.abs(p.y) <= VIEW && p.dist >= 1.2) inFrame.push(p);
    }
    const subjects = inFrame.filter(p => matches(shot, p.tree, p.tpl));

    if (shot.count) {
      if (subjects.length < shot.count) {
        const anyNear = all.some(p => matches(shot, p.tree, p.tpl));
        return { ok: false, reason: subjects.length ? `only ${subjects.length} in frame` : (anyNear ? 'not in frame' : `no ${SPECIES_NAME[shot.species]}s here`) };
      }
      // Group shot: grade on how much of the box the group fills + how centred
      // the group's centre is. Take the `count` largest.
      subjects.sort((a, b) => b.r - a.r);
      const g = subjects.slice(0, shot.count);
      const cx = g.reduce((s, p) => s + p.x, 0) / g.length;
      const cy = g.reduce((s, p) => s + p.y, 0) / g.length;
      const spread = Math.max(...g.map(p => Math.hypot(p.x - cx, p.y - cy)));
      const size = band(g[0].r, 0.08, 0.2, 0.9, 1.6);
      const centre = 1 - Math.min(1, Math.hypot(cx, cy) / VIEW) * 0.5;
      const layout = spread < 0.05 ? 0.6 : 1;            // stacked behind each other reads as one tree
      const score = size * centre * layout;
      return { ok: !!rate(score), score, grade: rate(score), reason: 'too far' };
    }

    if (!subjects.length) {
      const anyNear = all.some(p => matches(shot, p.tree, p.tpl));
      return { ok: false, reason: anyNear ? 'not in frame' : 'no subject here' };
    }
    let best = null;
    for (const p of subjects) {
      const wide = shot.framing === 'wide';
      const bands = BANDS[shot.giant ? 'giant' : (shot.framing === 'close' ? 'close' : 'any')];
      const size = wide
        ? band(p.dist / renderDistance, ...WIDE_BAND) * (p.r >= 0.05 ? 1 : 0)
        : band(p.r, ...bands);
      const centre = 1 - Math.max(Math.abs(p.x), Math.abs(p.y)) / VIEW * 0.5;
      // Occlusion: a nearer trunk standing across this tree's centre line. Only
      // trunks count — canopies are lacy and shooting through them is fair game.
      let clear = 1;
      for (const o of all) {
        if (o === p || o.dist >= p.dist - 0.8) continue;
        const acrossX = Math.abs(o.x - p.x) < o.tw * 2.2;
        const acrossY = Math.abs(o.y - p.y) < o.r;
        if (acrossX && acrossY) clear *= 0.7;
      }
      const score = size * centre * Math.max(0.45, clear);
      const why = size === 0
        ? ((wide ? p.dist / renderDistance < WIDE_BAND[1] : p.r < bands[1]) ? (wide ? 'too close' : 'too far') : (wide ? 'too far' : 'too close'))
        : (clear < 0.7 ? 'blocked' : null);
      if (!best || score > best.score) best = { p, score, why };
    }
    const grade = rate(best.score);
    return { ok: !!grade, score: best.score, grade, reason: best.why || 'weak framing' };
  }

  // ── Shooting ──
  function shoot() {
    if (finished || busy || wantsCapture) return;
    if (film <= 0) return;
    wantsCapture = true;               // main loop calls capture() after the composer draws
  }

  function capture() {
    if (!wantsCapture) return;
    wantsCapture = false;
    film--;
    sinceLast = 0;
    compass.classList.remove('show');
    shutterSound();
    flashT = 0.3;
    hint.style.opacity = '0';          // you've found the shutter; the hint's done its job
    paint();

    const shot = shots[idx];
    const result = evaluate(shot);
    let url = null;
    try { url = renderer.domElement.toDataURL('image/png'); } catch (_) { /* tainted canvas, no thumb */ }

    if (result.ok) {
      album.push({ url, shot, grade: result.grade, score: result.score, season: SEASON_CYCLE[seasonIdx] });
      busy = true;
      showReview(url, describe(shot), result.grade);
      setTimeout(() => {
        review.classList.remove('show');
        idx++;
        seasonIdx = (seasonIdx + 1) % SEASON_CYCLE.length;
        onSeason?.(SEASON_CYCLE[seasonIdx]);
        busy = false;
        if (idx >= shots.length) finish('done');
        else if (film <= 0) finish('film');
        else paint();
      }, 1700);
    } else {
      flashMsg(result.reason);
      if (film <= 0) setTimeout(() => finish('film'), 900);
    }
  }

  function showReview(url, cap, grade) {
    const img = review.querySelector('img');
    if (url) img.src = url; else img.removeAttribute('src');
    review.querySelector('.cap').textContent = cap;
    const g = review.querySelector('.ph-grade');
    g.textContent = grade; g.className = 'ph-grade ' + grade;
    review.classList.add('show');
  }

  // ── Compass hint: after a while without a shot, point toward the subject ──
  function updateCompass() {
    if (sinceLast < HINT_AFTER || busy || finished) return;
    const shot = shots[idx];
    const t = world.findNearest(camera.position.x, camera.position.z, tr => matches(shot, tr, templates[tr.templateIdx]));
    if (!t) { compass.textContent = 'nothing nearby · keep walking'; compass.classList.add('show'); return; }
    const dx = t.x - camera.position.x, dz = t.z - camera.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 14) { compass.classList.remove('show'); return; }
    camera.getWorldDirection(_fwd);
    const heading = Math.atan2(_fwd.x, _fwd.z);
    const target = Math.atan2(dx, dz);
    let rel = target - heading;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    const deg = rel * 180 / Math.PI;
    const arrow = Math.abs(deg) < 22 ? '↑' : Math.abs(deg) > 158 ? '↓' : deg > 0 ? (deg > 112 ? '↙' : deg > 67 ? '←' : '↖') : (deg < -112 ? '↘' : deg < -67 ? '→' : '↗');
    compass.textContent = `${arrow}  ${Math.round(dist)} m`;
    compass.classList.add('show');
  }

  // ── End screen ──
  let endEl = null;
  function finish(why) {
    if (finished) return;
    finished = true;
    elapsed = (performance.now() - startedAt) / 1000;
    const total = album.reduce((s, a) => s + POINTS[a.grade], 0);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    try { document.exitPointerLock?.(); } catch (_) { /* ignore */ }

    endEl = document.createElement('div');
    endEl.className = 'ph ph-end';
    const cells = shots.map((s, i) => {
      const a = album[i];
      if (!a) return `<div class="p miss">${describe(s)}</div>`;
      return `<div class="p"><img src="${a.url || ''}" alt=""><div class="row"><span class="cap">${describe(s)}<br>${SEASON_LABEL[a.season]}</span><span class="ph-grade ${a.grade}">${a.grade}</span></div></div>`;
    }).join('');
    endEl.innerHTML = `
      <div class="ph-box card">
        <h2>${why === 'done' ? 'ROLL COMPLETE' : 'OUT OF FILM'}</h2>
        <div class="sub">${album.length} of ${SHOTS} shots · ${mm}:${ss}</div>
        <div class="grid">${cells}</div>
        <div class="tot"><span>Score</span><b>${total}</b></div>
        <div class="btns">
          <button type="button" class="save">Save album</button>
          <button type="button" class="menu">Menu</button>
          <button type="button" class="pri again">Again</button>
        </div>
      </div>`;
    document.body.appendChild(endEl);
    endEl.querySelector('.save').addEventListener('click', saveAlbum);
    endEl.querySelector('.menu').addEventListener('click', () => onExit?.('menu'));
    endEl.querySelector('.again').addEventListener('click', () => onExit?.('again'));
    if (!album.length) endEl.querySelector('.save').disabled = true;
  }

  // Compose the album into one PNG: a 2-column contact sheet at the buffer's
  // native pixel size, captions in the same palette.
  function saveAlbum() {
    const imgs = album.map(a => Object.assign(new Image(), { src: a.url }));
    Promise.all(imgs.map(im => new Promise(r => { im.onload = r; im.onerror = r; }))).then(() => {
      const w = imgs[0]?.naturalWidth || 426, h = imgs[0]?.naturalHeight || 320;
      const cols = 2, pad = 16, capH = 34, rows = Math.ceil(album.length / cols);
      const c = document.createElement('canvas');
      c.width = cols * w + (cols + 1) * pad;
      c.height = rows * (h + capH) + (rows + 1) * pad + 40;
      const g = c.getContext('2d');
      g.fillStyle = '#0c1e40'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = false;
      g.font = '600 16px "Chakra Petch", monospace';
      album.forEach((a, i) => {
        const x = pad + (i % cols) * (w + pad), y = pad + Math.floor(i / cols) * (h + capH + pad);
        if (imgs[i].naturalWidth) g.drawImage(imgs[i], x, y, w, h);
        g.strokeStyle = '#6fb6e8'; g.lineWidth = 2; g.strokeRect(x - 1, y - 1, w + 2, h + 2);
        g.fillStyle = '#93b2cc'; g.fillText(describe(a.shot), x, y + h + 22);
        g.fillStyle = a.grade === 'S' ? '#ffd866' : '#8fe6ff'; g.textAlign = 'right';
        g.fillText(a.grade, x + w, y + h + 22); g.textAlign = 'left';
      });
      g.fillStyle = '#8fe6ff'; g.font = '600 13px "Chakra Petch", monospace';
      g.fillText('PS1 FOREST · PHOTO HUNT', pad, c.height - 14);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = 'ps1-forest-album.png';
      document.body.appendChild(a); a.click(); a.remove();
    });
  }

  // ── Input ──
  const onKey = (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); shoot(); }
  };
  const onClick = () => { if (!mobile) shoot(); };
  window.addEventListener('keydown', onKey);
  // Desktop: a click on the canvas while pointer-locked is the shutter; while
  // unlocked it re-locks (handled in main) — so only shoot when locked.
  const onCanvasClick = () => { if (document.pointerLockElement) onClick(); };
  renderer.domElement.addEventListener('click', onCanvasClick);

  function update(dt) {
    if (flashT > 0) { flashT -= dt; flashEl.style.opacity = String(Math.max(0, flashT / 0.3) * 0.9); }
    if (finished) return;
    sinceLast += dt;
    if ((sinceLast | 0) !== ((sinceLast - dt) | 0)) updateCompass();   // once a second
  }

  function dispose() {
    window.removeEventListener('keydown', onKey);
    renderer.domElement.removeEventListener('click', onCanvasClick);
    clearTimeout(msgTimer);
    root.remove(); style.remove();
    shutterBtn?.remove();
    endEl?.remove();
  }

  return { update, capture, dispose, get wantsCapture() { return wantsCapture; }, get finished() { return finished; } };
}
