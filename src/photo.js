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
const FILM = 5;                      // one frame per brief — every shot counts
const SEASON_CYCLE = ['verano', 'otono', 'invierno', 'primavera'];
const SEASON_LABEL = { verano: 'Summer', otono: 'Autumn', invierno: 'Winter', primavera: 'Spring' };
const SPECIES_NAME = { oak: 'oak', ash: 'ash', aspen: 'aspen', pine: 'pine' };
const SIZE_NAME = { l: 'large', m: 'medium', s: 'small' };
const VIEW = 0.72;                   // half-extent of the viewfinder box in NDC
const HINT_AFTER = 40;               // seconds without a shot before the compass shows

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
  if (shot.count) return `${['', 'one', 'two', 'three', 'four'][shot.count]} ${plural(sp)} in one frame`;
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

// Plateau of 1 between lo..hi, linear falloff to 0 at lo0 / hi0. Fed the
// projected radius in half-viewport-heights.
function band(r, lo0, lo, hi, hi0) {
  if (r <= lo0 || r >= hi0) return 0;
  if (r < lo) return (r - lo0) / (lo - lo0);
  if (r > hi) return (hi0 - r) / (hi0 - hi);
  return 1;
}

// Grade from points (0–1000 per photo).
function grade(pts) {
  if (pts >= 880) return 'S';
  if (pts >= 720) return 'A';
  if (pts >= 520) return 'B';
  if (pts >= 300) return 'C';
  return 'D';
}
function plural(sp) { return sp === 'ash' ? 'ashes' : `${SPECIES_NAME[sp]}s`; }

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

// Two soft notes when the season turns.
function seasonChime() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime;
    const note = (t, f, dur) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
    };
    note(t0, 523.25, 0.5); note(t0 + 0.18, 783.99, 0.7);
  } catch (_) { /* silent */ }
}

// ── The mode ─────────────────────────────────────────────────────────────────
export function buildPhotoHunt({
  camera, renderer, world, templates, seed, mobile,
  startSeason = 'verano', onSeason, onExit, renderDistance = 28,
}) {
  const shots = buildShotList(seed, templates);
  const album = [];                    // { url, shot, grade, pts, notes, season }
  let total = 0;
  let trans = null;                    // season transition in flight: { t0, switched }
  let idx = 0;
  let film = FILM;
  let seasonIdx = Math.max(0, SEASON_CYCLE.indexOf(startSeason));
  let wantsCapture = false;
  let busy = false;                    // review card up, ignore the shutter
  let finished = false;
  let elapsed = 0;
  let lastShotAt = performance.now();
  let lastCompassAt = 0;
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
    .ph-fade { position: fixed; inset: 0; z-index: 34; background: #06120f; opacity: 0; pointer-events: none; }
    .ph-season { position: fixed; inset: 0; z-index: 35; display: flex; flex-direction: column; align-items: center; justify-content: center;
                 gap: 6px; opacity: 0; transition: opacity .25s ease; pointer-events: none; }
    .ph-season.show { opacity: 1; }
    .ph-season .big { font-size: 34px; font-weight: 700; letter-spacing: .32em; text-indent: .32em; color: #fff;
                      text-shadow: 0 0 18px rgba(143,230,255,.6), 0 2px 0 #0a2740; }
    .ph-season .small { font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: #9ad27a; }
    .ph-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .ph-chip { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 6px;
               border: 1px solid #2b5e93; color: #93b2cc; background: rgba(8,20,44,0.6); }
    .ph-chip.hit { color: #9ad27a; border-color: #4f8a3a; }
    .ph-chip.miss { color: #c98a8a; border-color: #7a3a3a; }
    .ph-pts { font-size: 12px; color: #ffd866; margin-left: 8px; }
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
    .ph-grade.S { color: #ffd866; } .ph-grade.A { color: #9ad27a; } .ph-grade.B { color: #8fe6ff; } .ph-grade.C { color: #cfd5dc; } .ph-grade.D { color: #8a97a5; }
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
    <div class="ph-box ph-film"><div class="k">Score</div><div class="v"></div></div>
    <div class="ph-fade"></div>
    <div class="ph-season"><div class="big"></div><div class="small"></div></div>
    <div class="ph-box ph-compass"></div>
    <div class="ph-box ph-msg"></div>
    <div class="ph-box ph-review"><img alt=""><div class="row"><span class="cap"></span><span><span class="ph-pts"></span> <span class="ph-grade"></span></span></div><div class="ph-chips"></div></div>
    <div class="ph-hint"></div>
  `;
  document.body.appendChild(root);
  const flashEl = root.querySelector('.ph-flash');
  let flashT = 0;
  const taskN = root.querySelector('.ph-task .n');
  const taskV = root.querySelector('.ph-task .v');
  const taskS = root.querySelector('.ph-task .s');
  const filmV = root.querySelector('.ph-film .v');
  const fadeEl = root.querySelector('.ph-fade');
  const seasonEl = root.querySelector('.ph-season');
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
    filmV.textContent = String(total);
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

  // Every photo with a tree in it counts. Composition earns up to 500, the
  // brief up to 400 as a bonus, the scene up to 100. Nothing here can fail
  // except an empty frame.
  function evaluate(shot) {
    const near = world.getNearbyTrees(camera.position.x, camera.position.z, 60);
    const all = [], inFrame = [];
    for (const t of near) {
      const p = project(t);
      if (!p || p.dist < 1.0) continue;
      all.push(p);
      // In frame = the trunk column is inside the box horizontally and the
      // tree's vertical span overlaps it. A tall tree right in front of you
      // has its centre above the box; it's still very much in the picture.
      const top = p.y + p.r, bottom = p.y - p.r;
      p.inBox = Math.abs(p.x) <= VIEW + p.tw && top >= -VIEW && bottom <= VIEW;
      if (p.inBox) inFrame.push(p);
    }
    if (!inFrame.length) return { ok: false, reason: 'nothing in frame' };

    const clearOf = (p) => {
      let clear = 1;
      for (const o of all) {
        if (o === p || o.dist >= p.dist - 0.8) continue;
        if (Math.abs(o.x - p.x) < o.tw * 2.2 && Math.abs(o.y - p.y) < o.r) clear *= 0.7;
      }
      return Math.max(0.4, clear);
    };
    const compose = (p) => {
      const sizeFit = band(p.r, 0.05, 0.18, 1.8, 3.4);
      const overlap = Math.min(p.y + p.r, VIEW) - Math.max(p.y - p.r, -VIEW);
      const presence = Math.max(0, Math.min(1, overlap / (2 * VIEW)));
      const centre = 1 - Math.min(1, Math.abs(p.x) / VIEW) * 0.6;
      return (0.7 * sizeFit * centre + 0.3 * presence) * clearOf(p);
    };
    for (const p of inFrame) p.comp = compose(p);

    // Brief bonus. The hero is the tree the brief asked for if one is in
    // frame, otherwise the best-composed tree.
    const notes = [];
    let brief = 0;
    let hero = inFrame.reduce((a, b) => (b.comp > a.comp ? b : a));
    if (shot.count) {
      const subj = inFrame.filter(p => matches(shot, p.tree, p.tpl)).sort((a, b) => b.comp - a.comp);
      const n = Math.min(subj.length, shot.count);
      notes.push({ label: `${n}/${shot.count} ${plural(shot.species)}`, hit: n >= shot.count });
      brief += 300 * (n / shot.count);
      if (n >= shot.count) {
        const g = subj.slice(0, shot.count);
        const cx = g.reduce((a, p) => a + p.x, 0) / g.length;
        const spread = Math.max(...g.map(p => Math.abs(p.x - cx)));
        const spaced = spread > 0.12;
        notes.push({ label: spaced ? 'spread out' : 'bunched', hit: spaced });
        if (spaced) brief += 100;
        hero = g[0];
      }
    } else {
      const subj = inFrame.filter(p => matches(shot, p.tree, p.tpl)).sort((a, b) => b.comp - a.comp)[0];
      const what = shot.giant ? 'giant' : (shot.species ? SPECIES_NAME[shot.species] : 'tree');
      if (shot.size) notes.push({ label: `${SIZE_NAME[shot.size]} ${what}`, hit: !!subj });
      else notes.push({ label: what, hit: !!subj });
      if (subj) {
        hero = subj;
        brief += shot.giant ? 250 : 150;
        if (shot.framing === 'close') {
          const hit = subj.r >= 0.6;
          notes.push({ label: 'up close', hit });
          brief += hit ? 150 : Math.round(150 * Math.min(1, subj.r / 0.6) * 0.3);
        } else if (shot.framing === 'wide') {
          const f = subj.dist / renderDistance;
          const hit = f >= 0.45 && subj.r >= 0.05;
          notes.push({ label: 'from a distance', hit });
          brief += hit ? 150 : Math.round(150 * Math.min(1, f / 0.45) * 0.3);
        } else if (shot.giant) {
          const hit = subj.r <= 4.0;
          notes.push({ label: 'whole', hit });
          brief += hit ? 150 : 50;
        } else {
          brief += 150;                                    // no framing asked — species alone earns it
        }
      }
    }

    // Scene bonus: variety and rarities in the frame.
    const species = new Set(inFrame.map(p => p.tpl.id.split('-')[0]));
    let scene = Math.min(75, (species.size - 1) * 25);
    if (inFrame.some(p => p.tree.giant)) scene += 25;
    if (species.size > 1) notes.push({ label: `${species.size} species`, hit: true });

    const comp = Math.round(500 * hero.comp);
    const pts = Math.max(0, Math.min(1000, comp + Math.round(brief) + scene));
    return { ok: true, pts, grade: grade(pts), notes, hero };
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
    const shot = shots[idx];
    const result = evaluate(shot);
    shutterSound();
    flashT = 0.3;
    hint.style.opacity = '0';          // you've found the shutter; the hint's done its job
    lastShotAt = performance.now();
    compass.classList.remove('show');
    if (!result.ok) { flashMsg(result.reason); return; }   // an empty frame costs nothing

    film--;
    let url = null;
    try { url = renderer.domElement.toDataURL('image/png'); } catch (_) { /* tainted canvas, no thumb */ }
    total += result.pts;
    album.push({ url, shot, grade: result.grade, pts: result.pts, notes: result.notes, season: SEASON_CYCLE[seasonIdx] });
    paint();
    busy = true;
    showReview(url, describe(shot), result);
    setTimeout(() => { review.classList.remove('show'); trans = { t0: performance.now(), switched: false }; }, 1900);
  }

  // The season turns behind a cut to black, PS1 style: fade out, swap the
  // palette while nothing is visible, hold a title card, fade back in.
  // Driven off the wall clock in update() so it paces the same at any fps.
  function tickTransition(now) {
    const e = (now - trans.t0) / 1000;
    if (e < 0.4) { fadeEl.style.opacity = String(e / 0.4); return; }
    if (!trans.switched) {
      trans.switched = true;
      fadeEl.style.opacity = '1';
      idx++;
      seasonIdx = (seasonIdx + 1) % SEASON_CYCLE.length;
      onSeason?.(SEASON_CYCLE[seasonIdx]);
      seasonChime();
      const done = idx >= shots.length;
      seasonEl.querySelector('.big').textContent = SEASON_LABEL[SEASON_CYCLE[seasonIdx]].toUpperCase();
      seasonEl.querySelector('.small').textContent = done ? 'a full year' : `shot ${idx + 1} of ${SHOTS}`;
      seasonEl.classList.add('show');
      return;
    }
    if (e < 1.6) return;                                   // hold the card
    seasonEl.classList.remove('show');                     // every step past here is idempotent —
    if (e < 1.9) return;                                   // frames can be sparse, nothing may be skipped
    if (e < 2.5) { fadeEl.style.opacity = String(1 - (e - 1.9) / 0.6); return; }
    seasonEl.classList.remove('show');
    fadeEl.style.opacity = '0';
    trans = null;
    busy = false;
    if (idx >= shots.length) finish('done');
    else paint();
  }

  function showReview(url, cap, result) {
    const img = review.querySelector('img');
    if (url) img.src = url; else img.removeAttribute('src');
    review.querySelector('.cap').textContent = cap;
    review.querySelector('.ph-pts').textContent = `+${result.pts}`;
    const g = review.querySelector('.ph-grade');
    g.textContent = result.grade; g.className = 'ph-grade ' + result.grade;
    review.querySelector('.ph-chips').innerHTML = result.notes
      .map(n => `<span class="ph-chip ${n.hit ? 'hit' : 'miss'}">${n.label}</span>`).join('');
    review.classList.add('show');
  }

  // ── Compass hint: after a while without a shot, point toward the subject ──
  function updateCompass() {
    if ((performance.now() - lastShotAt) / 1000 < HINT_AFTER || busy || finished) return;
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
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    try { document.exitPointerLock?.(); } catch (_) { /* ignore */ }

    endEl = document.createElement('div');
    endEl.className = 'ph ph-end';
    const cells = shots.map((s, i) => {
      const a = album[i];
      if (!a) return `<div class="p miss">${describe(s)}</div>`;
      return `<div class="p"><img src="${a.url || ''}" alt=""><div class="row"><span class="cap">${describe(s)}<br>${SEASON_LABEL[a.season]} · ${a.pts} pts</span><span class="ph-grade ${a.grade}">${a.grade}</span></div></div>`;
    }).join('');
    endEl.innerHTML = `
      <div class="ph-box card">
        <h2>ROLL COMPLETE</h2>
        <div class="sub">${album.length} photos · ${mm}:${ss} · ${grade(total / Math.max(1, album.length))} roll</div>
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
        g.fillText(`${a.pts} · ${a.grade}`, x + w, y + h + 22); g.textAlign = 'left';
      });
      g.fillStyle = '#8fe6ff'; g.font = '600 13px "Chakra Petch", monospace';
      g.fillText(`PS1 FOREST · PHOTO HUNT · ${total} PTS`, pad, c.height - 14);
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
    const now = performance.now();
    if (trans) { tickTransition(now); return; }
    if (now - lastCompassAt > 1000) { lastCompassAt = now; updateCompass(); }   // once a second
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
