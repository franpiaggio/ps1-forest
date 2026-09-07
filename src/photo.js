// Photo mode. Eight frames, no brief: take your photo. The camera looks at what
// you framed and pays for what it finds — a close-up, the canopy, the sun
// through the trees, a grove of one species, a giant, falling leaves — and
// pays less for something it has already seen on this roll, so the frames
// want to be different pictures. Every two photos the scene turns.
//
// Nothing here is a 3D model. Subjects are the trees the world already
// streams; the camera is a DOM overlay; a photo is the PS1 buffer read
// straight off the canvas after the composer draws. What the camera "sees"
// comes from geometry it already knows: each tree's projected size and
// position, the camera's pitch, the angle to the sun, the current season.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const PER_SCENE = 2;                 // photos per scene before it turns
const SEASON_CYCLE = ['verano', 'otono', 'invierno', 'primavera'];
const SHOTS = PER_SCENE * SEASON_CYCLE.length;
const SEASON_LABEL = { verano: 'Summer', otono: 'Autumn', invierno: 'Winter', primavera: 'Spring' };
const VIEW = 0.72;                   // half-extent of the viewfinder box in NDC
const IDLE_NUDGE = 30;               // seconds without a shot before the nudges start
const REPEAT_PAY = 0.4;              // a tag already on the roll pays this fraction
const NUDGES = ['look up', 'get closer', 'face the light', 'find a clearing', 'look for the big one', 'get down in the grass', 'step back'];

// Plateau of 1 between lo..hi, linear falloff to 0 at lo0 / hi0.
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

function download(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

// ── Sounds — synthesised, no samples ─────────────────────────────────────────
let actx = null;
function ctx() { return (actx = actx || new (window.AudioContext || window.webkitAudioContext)()); }
function shutterSound() {
  try {
    const a = ctx(), t0 = a.currentTime;
    const click = (t, f, dur, gain) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur);
    };
    click(t0, 1800, 0.03, 0.12);
    click(t0 + 0.045, 900, 0.05, 0.10);
  } catch (_) { /* no audio, no problem */ }
}
function sceneChime() {
  try {
    const a = ctx(), t0 = a.currentTime;
    const note = (t, f, dur) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur);
    };
    note(t0, 523.25, 0.5); note(t0 + 0.18, 783.99, 0.7);
  } catch (_) { /* silent */ }
}

// ── The mode ─────────────────────────────────────────────────────────────────
export function buildPhotoHunt({
  camera, renderer, world, templates, mobile, sunDir,
  startSeason = 'verano', onSeason, onExit, renderDistance = 28,
}) {
  const album = [];                    // { url, tags, caption, pts, grade, season }
  const seen = new Set();              // tags already paid for on this roll
  let idx = 0;                         // frames taken
  let total = 0;
  let seasonIdx = Math.max(0, SEASON_CYCLE.indexOf(startSeason));
  let wantsCapture = false;
  let busy = false;                    // review card up or scene turning: shutter ignored
  let finished = false;
  let trans = null;                    // scene transition in flight: { t0, switched }
  let lastShotAt = performance.now();
  let lastNudgeAt = 0;
  let nudgeIdx = 0;
  const startedAt = performance.now();
  const sceneNo = () => Math.floor(idx / PER_SCENE) + 1;

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
    .ph-task { position: fixed; top: 64px; left: 12px; z-index: 31; padding: 10px 14px; min-width: 200px; }
    .ph-task .k { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: #8fe6ff; opacity: .85; }
    .ph-task .v { font-size: 17px; font-weight: 600; margin-top: 2px; line-height: 1.2; }
    .ph-task .s { margin-top: 8px; font-size: 11px; letter-spacing: .12em; color: #93b2cc; text-transform: uppercase; }
    .ph-score { position: fixed; top: 64px; right: 12px; z-index: 31; padding: 8px 12px; text-align: right; }
    .ph-score .k { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: #8fe6ff; opacity: .85; }
    .ph-score .v { font-size: 22px; font-weight: 700; letter-spacing: .08em; font-variant-numeric: tabular-nums; }
    .ph-hint { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 31; text-align: center;
               font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #8fe6ff;
               text-shadow: 0 1px 4px rgba(0,0,0,.9); pointer-events: none; transition: opacity 1s ease; }
    .ph-nudge { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: 31; padding: 6px 12px;
                font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #ffd866; opacity: 0;
                transition: opacity .6s ease; pointer-events: none; white-space: nowrap; }
    .ph-nudge.show { opacity: 1; }
    .ph-msg { position: fixed; left: 50%; top: 58%; transform: translateX(-50%); z-index: 31; padding: 8px 14px;
              font-size: 14px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #ffd866;
              opacity: 0; transition: opacity .25s ease; pointer-events: none; white-space: nowrap; }
    .ph-msg.show { opacity: 1; }
    .ph-review { position: fixed; right: 12px; bottom: 12px; z-index: 32; width: 250px; padding: 8px 8px 10px;
                 transform: translateY(24px); opacity: 0; transition: all .28s cubic-bezier(.2,.8,.2,1); }
    .ph-review.show { transform: none; opacity: 1; }
    .ph-review img { display: block; width: 100%; image-rendering: pixelated; border: 1px solid rgba(120,180,230,0.35); }
    .ph-review .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; }
    .ph-review .cap { font-size: 12px; color: #eaf3ff; font-weight: 600; }
    .ph-pts { font-size: 12px; color: #ffd866; margin-right: 6px; }
    .ph-grade { font-size: 26px; font-weight: 700; line-height: 1; text-shadow: 0 0 10px rgba(143,230,255,.5); }
    .ph-grade.S { color: #ffd866; } .ph-grade.A { color: #9ad27a; } .ph-grade.B { color: #8fe6ff; } .ph-grade.C { color: #cfd5dc; } .ph-grade.D { color: #8a97a5; }
    .ph-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .ph-chip { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; padding: 2px 6px;
               border: 1px solid #4f8a3a; color: #9ad27a; background: rgba(8,20,44,0.6); }
    .ph-chip b { font-weight: 600; color: #ffd866; margin-left: 4px; }
    .ph-chip.seen { color: #7e8b99; border-color: #33465a; }
    .ph-chip.seen b { color: #93b2cc; }
    .ph-fade { position: fixed; inset: 0; z-index: 34; background: #06120f; opacity: 0; pointer-events: none; }
    .ph-scene { position: fixed; inset: 0; z-index: 35; display: flex; flex-direction: column; align-items: center; justify-content: center;
                gap: 6px; opacity: 0; transition: opacity .25s ease; pointer-events: none; }
    .ph-scene.show { opacity: 1; }
    .ph-scene .big { font-size: 34px; font-weight: 700; letter-spacing: .32em; text-indent: .32em; color: #fff;
                     text-shadow: 0 0 18px rgba(143,230,255,.6), 0 2px 0 #0a2740; }
    .ph-scene .small { font-size: 11px; letter-spacing: .26em; text-transform: uppercase; color: #9ad27a; }
    .ph-shutter { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 33; width: 74px; height: 74px;
                  border-radius: 50%; border: 3px solid #eaf3ff; background: rgba(255,212,130,0.92); cursor: pointer;
                  box-shadow: 0 0 0 4px rgba(12,30,64,0.7), 0 6px 18px rgba(0,0,0,.6); }
    .ph-shutter:active { transform: translateX(-50%) scale(.94); }
    .ph-end { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
              background: rgba(6,18,15,0.82); padding: 16px; overflow: auto; }
    .ph-end .card { width: 100%; max-width: 680px; max-height: 100%; overflow: auto; padding: 18px 18px 14px; }
    .ph-end h2 { margin: 0; font-size: 22px; letter-spacing: .1em; text-align: center; text-shadow: 0 0 12px rgba(143,230,255,.55); }
    .ph-end .sub { margin: 4px 0 14px; text-align: center; font-size: 11px; letter-spacing: .22em; text-transform: uppercase; color: #9ad27a; }
    .ph-end .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .ph-end .p { position: relative; background: rgba(8,20,44,0.6); border: 1px solid #2b5e93; padding: 6px; }
    .ph-end .p img { display: block; width: 100%; image-rendering: pixelated; }
    .ph-end .p .row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 6px; }
    .ph-end .p .cap { font-size: 10px; color: #93b2cc; line-height: 1.25; }
    .ph-end .p .cap b { color: #eaf3ff; font-weight: 600; }
    .ph-end .p .ph-grade { font-size: 18px; }
    .ph-end .p .dl { position: absolute; top: 10px; right: 10px; padding: 3px 7px; font: inherit; font-size: 10px; font-weight: 600;
                     letter-spacing: .1em; text-transform: uppercase; cursor: pointer; color: #eaf3ff;
                     background: rgba(12,30,64,0.85); border: 1px solid #6fb6e8; opacity: 0; transition: opacity .15s ease; }
    .ph-end .p:hover .dl, .ph-end .p .dl:focus-visible { opacity: 1; }
    @media (hover: none) { .ph-end .p .dl { opacity: 1; } }
    .ph-end .tot { display: flex; justify-content: space-between; margin: 14px 0 10px; font-size: 13px; letter-spacing: .08em; }
    .ph-end .tot b { font-size: 18px; color: #ffd866; }
    .ph-end .btns { display: flex; gap: 8px; }
    .ph-end .btns button { flex: 1; padding: 11px; cursor: pointer; font: inherit; font-size: 14px; font-weight: 600;
                           letter-spacing: .08em; color: #eaf3ff; background: rgba(8,20,44,0.6); border: 1px solid #2b5e93; }
    .ph-end .btns button:hover { border-color: #6fb6e8; color: #fff; }
    .ph-end .btns button.pri { color: #06121f; background: linear-gradient(180deg, #ffe27a, #f3c645); border-color: #fff3c0; }
    body.ui-hidden .ph-ui { display: none !important; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ph ph-ui';
  root.innerHTML = `
    <div class="ph-flash"></div>
    <div class="ph-vf"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><i class="dot"></i></div>
    <div class="ph-box ph-task"><div class="k">Frame <span class="n"></span> of ${SHOTS}</div><div class="v">take your photo</div><div class="s"></div></div>
    <div class="ph-box ph-score"><div class="k">Score</div><div class="v"></div></div>
    <div class="ph-box ph-nudge"></div>
    <div class="ph-box ph-msg"></div>
    <div class="ph-box ph-review"><img alt=""><div class="row"><span class="cap"></span><span><span class="ph-pts"></span><span class="ph-grade"></span></span></div><div class="ph-chips"></div></div>
    <div class="ph-fade"></div>
    <div class="ph-scene"><div class="big"></div><div class="small"></div></div>
    <div class="ph-hint"></div>
  `;
  document.body.appendChild(root);
  const flashEl = root.querySelector('.ph-flash');
  let flashT = 0;
  const taskN = root.querySelector('.ph-task .n');
  const taskS = root.querySelector('.ph-task .s');
  const scoreV = root.querySelector('.ph-score .v');
  const nudge = root.querySelector('.ph-nudge');
  const msg = root.querySelector('.ph-msg');
  const review = root.querySelector('.ph-review');
  const fadeEl = root.querySelector('.ph-fade');
  const sceneEl = root.querySelector('.ph-scene');
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
    taskN.textContent = String(Math.min(SHOTS, idx + 1));
    taskS.textContent = `scene ${Math.min(SEASON_CYCLE.length, sceneNo())} of ${SEASON_CYCLE.length}`;
    scoreV.textContent = String(total);
  }
  paint();

  let msgTimer = null;
  function flashMsg(text) {
    msg.textContent = text;
    msg.classList.add('show');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => msg.classList.remove('show'), 1400);
  }

  // ── What the camera sees ──
  const _v = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  function project(tree) {
    const tpl = templates[tree.templateIdx];
    const h = tpl.height * tree.scale;
    const gy = terrainHeight(tree.x, tree.z);
    _v.set(tree.x, gy + h * 0.5, tree.z);
    const dx = tree.x - camera.position.x, dz = tree.z - camera.position.z;
    const dist = Math.hypot(dx, dz);
    if (dx * _fwd.x + dz * _fwd.z <= 0) return null;                // behind the camera
    _v.project(camera);
    if (_v.z > 1) return null;
    // Projected radius in half-viewport-heights and trunk half-width in NDC x.
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * Math.max(0.1, dist);
    const r = (h * 0.5) / halfH;
    const tw = (tpl.trunkRadius * tree.scale) / (halfH * camera.aspect);
    return { tree, tpl, x: _v.x, y: _v.y, r, tw, dist, h };
  }

  // Returns { ok, pts, grade, tags:[{label, pts, seen}], caption } or { ok:false, reason }.
  function look() {
    camera.getWorldDirection(_fwd);
    const pitch = Math.asin(THREE.MathUtils.clamp(_fwd.y, -1, 1)) * 180 / Math.PI;   // + looks up
    const toSun = sunDir ? Math.acos(THREE.MathUtils.clamp(_fwd.dot(sunDir), -1, 1)) * 180 / Math.PI : 180;

    const near = world.getNearbyTrees(camera.position.x, camera.position.z, 60);
    const all = [], inFrame = [];
    for (const t of near) {
      const p = project(t);
      if (!p || p.dist < 0.8) continue;
      all.push(p);
      // In frame = trunk column inside the box horizontally, vertical span
      // overlapping it. A tall tree right in front has its centre above the
      // box and is still very much the picture.
      p.inBox = Math.abs(p.x) <= VIEW + p.tw && p.y + p.r >= -VIEW && p.y - p.r <= VIEW;
      if (p.inBox) inFrame.push(p);
    }
    const trees = inFrame.filter(p => p.tpl.category === 'tree');
    const bushes = inFrame.filter(p => p.tpl.category === 'bush');

    // Composition of the hero tree: size, horizontal placement, trunks across it.
    const clearOf = (p) => {
      let clear = 1;
      for (const o of all) {
        if (o === p || o.dist >= p.dist - 0.8) continue;
        if (Math.abs(o.x - p.x) < o.tw * 2.2 && Math.abs(o.y - p.y) < o.r) clear *= 0.7;
      }
      return Math.max(0.4, clear);
    };
    for (const p of trees) {
      const sizeFit = band(p.r, 0.05, 0.18, 1.8, 3.4);
      const centre = 1 - Math.min(1, Math.abs(p.x) / VIEW) * 0.6;
      p.comp = sizeFit * centre * clearOf(p);
    }
    const hero = trees.length ? trees.reduce((a, b) => (b.comp > a.comp ? b : a)) : null;

    const tags = [];
    const tag = (label, pts) => tags.push({ label, pts });

    // Base: a tree, composed.
    if (hero) tag('a tree', Math.round(300 * hero.comp));

    // Distance and angle.
    if (hero && hero.r >= 1.1 && hero.dist < 7) tag('close-up', 150);
    if (hero && hero.dist < 2.6 && Math.abs(pitch) < 18) tag('bark', 120);
    if (pitch > 35 && trees.some(p => p.r > 0.8)) tag('the canopy', 180);
    else if (pitch > 40 && !trees.some(p => p.r > 0.6)) tag('open sky', 140);
    if (pitch < -25 && (bushes.length || !hero)) tag('undergrowth', 120);
    else if (pitch < -15 && hero && hero.r > 0.5) tag('low angle', 100);

    // Light.
    if (toSun < 18) tag('into the sun', 200);
    else if (toSun < 32 && pitch > 4 && trees.length) tag('light shafts', 160);

    // Depth and company.
    if (trees.length >= 6 && hero && hero.r < 0.35) tag('the treeline', 150);
    if (trees.length >= 3 && trees.filter(p => p.dist > renderDistance * 0.6).length >= 2 && hero && hero.r < 0.6) tag('into the fog', 90);
    const bySpecies = {};
    for (const p of trees) { const sp = p.tpl.id.split('-')[0]; bySpecies[sp] = (bySpecies[sp] || 0) + 1; }
    const speciesN = Object.keys(bySpecies).length;
    const grove = Object.entries(bySpecies).find(([, n]) => n >= 3);
    if (grove) tag(`a grove of ${grove[0] === 'ash' ? 'ashes' : grove[0] + 's'}`, 150);
    if (speciesN >= 3) tag('mixed woods', 100);
    if (trees.some(p => p.tree.giant)) tag('an ancient', 250);
    if (bushes.length >= 2 && hero && hero.dist < 12) tag('understory', 60);

    // Weather.
    const season = SEASON_CYCLE[seasonIdx];
    if (pitch > -12) {
      if (season === 'otono') tag('falling leaves', 80);
      if (season === 'invierno') tag('snowfall', 80);
      if (season === 'primavera') tag('petals', 80);
    }

    // Placement.
    if (hero) {
      const ax = Math.abs(hero.x);
      if (ax >= 0.25 && ax <= 0.45) tag('rule of thirds', 60);
      else if (ax < 0.08 && hero.r > 0.4) tag('dead centre', 40);
    }

    if (!tags.length) return { ok: false, reason: 'nothing here' };

    // A repeat pays less. "a tree" is the base and always pays.
    let pts = 0;
    for (const t of tags) {
      t.seen = t.label !== 'a tree' && seen.has(t.label);
      if (t.seen) t.pts = Math.round(t.pts * REPEAT_PAY);
      pts += t.pts;
    }
    pts = Math.max(0, Math.min(1000, pts));
    const named = tags.filter(t => t.label !== 'a tree').sort((a, b) => b.pts - a.pts);
    const caption = (named[0]?.label || 'a tree') + (named[1] ? ` · ${named[1].label}` : '');
    return { ok: true, pts, grade: grade(pts), tags, caption };
  }

  // ── Shooting ──
  function shoot() {
    if (finished || busy || wantsCapture) return;
    wantsCapture = true;               // main loop calls capture() after the composer draws
  }

  function capture() {
    if (!wantsCapture) return;
    wantsCapture = false;
    const result = look();
    shutterSound();
    flashT = 0.3;
    hint.style.opacity = '0';
    lastShotAt = performance.now();
    nudge.classList.remove('show');
    if (!result.ok) { flashMsg(result.reason); return; }   // an empty frame costs nothing

    let url = null;
    try { url = renderer.domElement.toDataURL('image/png'); } catch (_) { /* tainted canvas, no thumb */ }
    for (const t of result.tags) seen.add(t.label);
    total += result.pts;
    album.push({ url, tags: result.tags, caption: result.caption, pts: result.pts, grade: result.grade, season: SEASON_CYCLE[seasonIdx] });
    busy = true;
    showReview(url, result);
    setTimeout(() => {
      review.classList.remove('show');
      if (album.length % PER_SCENE === 0) {
        trans = { t0: performance.now(), switched: false };   // the scene turns (idx advances there)
      } else {
        idx++;
        busy = false;
        paint();
      }
    }, 2100);
    paint();
  }

  function showReview(url, result) {
    const img = review.querySelector('img');
    if (url) img.src = url; else img.removeAttribute('src');
    review.querySelector('.cap').textContent = result.caption;
    review.querySelector('.ph-pts').textContent = `+${result.pts}`;
    const g = review.querySelector('.ph-grade');
    g.textContent = result.grade; g.className = 'ph-grade ' + result.grade;
    review.querySelector('.ph-chips').innerHTML = result.tags
      .map(t => `<span class="ph-chip${t.seen ? ' seen' : ''}">${t.label}<b>+${t.pts}</b></span>`).join('');
    review.classList.add('show');
  }

  // The scene turns behind a cut to black, PS1 style: fade out, swap the
  // palette while nothing is visible, hold a title card, fade back in. Paced
  // off the wall clock and idempotent per step, so sparse frames can't skip
  // anything.
  function tickTransition(now) {
    const e = (now - trans.t0) / 1000;
    if (e < 0.4) { fadeEl.style.opacity = String(e / 0.4); return; }
    if (!trans.switched) {
      trans.switched = true;
      fadeEl.style.opacity = '1';
      idx++;
      const done = idx >= SHOTS;
      if (!done) {
        seasonIdx = (seasonIdx + 1) % SEASON_CYCLE.length;
        onSeason?.(SEASON_CYCLE[seasonIdx]);
      }
      sceneChime();
      sceneEl.querySelector('.big').textContent = done ? 'END OF ROLL' : 'NEXT SCENE';
      sceneEl.querySelector('.small').textContent = done ? `${SHOTS} frames` : `scene ${sceneNo()} of ${SEASON_CYCLE.length}`;
      sceneEl.classList.add('show');
      return;
    }
    if (e < 1.6) return;
    sceneEl.classList.remove('show');
    if (e < 1.9) return;
    if (e < 2.5) { fadeEl.style.opacity = String(1 - (e - 1.9) / 0.6); return; }
    fadeEl.style.opacity = '0';
    trans = null;
    busy = false;
    if (idx >= SHOTS) finish();
    else paint();
  }

  // ── Nudges: after a while without a shot, one quiet suggestion at a time ──
  function updateNudge(now) {
    if ((now - lastShotAt) / 1000 < IDLE_NUDGE || busy || finished) return;
    if (now - lastNudgeAt < 7000) return;
    lastNudgeAt = now;
    nudge.textContent = NUDGES[nudgeIdx++ % NUDGES.length];
    nudge.classList.add('show');
  }

  // ── End screen ──
  let endEl = null;
  const fileName = (a, i) => `ps1-forest-${String(i + 1).padStart(2, '0')}-${a.caption.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}.png`;
  function finish() {
    if (finished) return;
    finished = true;
    const elapsed = (performance.now() - startedAt) / 1000;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
    try { document.exitPointerLock?.(); } catch (_) { /* ignore */ }

    endEl = document.createElement('div');
    endEl.className = 'ph ph-end';
    const cells = album.map((a, i) =>
      `<div class="p"><img src="${a.url || ''}" alt="">` +
      `<button type="button" class="dl" data-i="${i}" title="Save this photo">save</button>` +
      `<div class="row"><span class="cap"><b>${a.caption}</b><br>${SEASON_LABEL[a.season]} · ${a.pts} pts</span><span class="ph-grade ${a.grade}">${a.grade}</span></div></div>`
    ).join('');
    const distinct = new Set(album.flatMap(a => a.tags.map(t => t.label))).size;
    endEl.innerHTML = `
      <div class="ph-box card">
        <h2>END OF ROLL</h2>
        <div class="sub">${album.length} photos · ${distinct} things seen · ${mm}:${ss} · ${grade(total / Math.max(1, album.length))} roll</div>
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
    for (const b of endEl.querySelectorAll('.dl')) {
      b.addEventListener('click', () => { const a = album[+b.dataset.i]; if (a?.url) download(a.url, fileName(a, +b.dataset.i)); });
    }
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
        g.fillStyle = '#eaf3ff'; g.fillText(a.caption, x, y + h + 22);
        g.fillStyle = a.grade === 'S' ? '#ffd866' : '#8fe6ff'; g.textAlign = 'right';
        g.fillText(`${a.pts} · ${a.grade}`, x + w, y + h + 22); g.textAlign = 'left';
      });
      g.fillStyle = '#8fe6ff'; g.font = '600 13px "Chakra Petch", monospace';
      g.fillText(`PS1 FOREST · ${total} PTS`, pad, c.height - 14);
      download(c.toDataURL('image/png'), 'ps1-forest-album.png');
    });
  }

  // ── Input ──
  const onKey = (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); shoot(); }
  };
  window.addEventListener('keydown', onKey);
  // Desktop: a click on the canvas while pointer-locked is the shutter; while
  // unlocked it re-locks (handled in main), so only shoot when locked.
  const onCanvasClick = () => { if (!mobile && document.pointerLockElement) shoot(); };
  renderer.domElement.addEventListener('click', onCanvasClick);

  function update(dt) {
    if (flashT > 0) { flashT -= dt; flashEl.style.opacity = String(Math.max(0, flashT / 0.3) * 0.9); }
    if (finished) return;
    const now = performance.now();
    if (trans) { tickTransition(now); return; }
    updateNudge(now);
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
