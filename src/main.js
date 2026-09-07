// Splash shows a 3-tier graphics selector plus a mode choice — "Walk" (manual
// first-person, WASD + mouse) or "Demo" (the hands-off demoscene flythrough).
// v05/v06 had dropped manual walking; v07 brought it back, the way the early
// versions offered both. The heavy boot only runs *after* a mode is picked, so
// the cost is paid in line with the chosen tier.

import * as THREE from 'three';

import { buildEnvironment }      from './environment.js';
import { buildTemplates }        from './tree-templates.js';
import { buildWorld }            from './world.js';
import { setForestConfig }       from './chunk.js';
import { buildDemo }             from './demo.js';
import { buildPlayer }           from './player.js';
import { buildGrass }            from './grass.js';
import { buildPipeline }         from './postprocessing.js';
import { buildDust }             from './dust.js';
import { enableGyro, isMobile }  from './gyro.js';
import { updateWind }            from './wind.js';
import { getPreset, detectDefaultTier } from './quality.js';
import { buildDebugGui }         from './debug-gui.js';
import { buildInspector }        from './inspector.js';
import { buildMobilePlayer, buildAutoMobileHud } from './mobile-controls.js';
import { buildSettings }        from './settings.js';
import { applySeasonToLeaf, setSeason, buildSeasonParticles } from './seasons.js';
import { applyVertexSnap, makeNearest, ps1Uniforms } from './ps1.js';
import { buildSunShafts } from './lightshafts.js';

// PS1 internal resolution — the scene renders into a small buffer that CSS
// upscales nearest-neighbour. Lower = chunkier; tasteful PS1 sits ~280–340.
let PS1_HEIGHT = 360;
let PS1_JITTER = 0.7;   // snap-grid scale: <1 = coarser grid = more wobble
function pixelSize() {
  const aspect = window.innerWidth / window.innerHeight;
  const h = Math.max(120, Math.round(PS1_HEIGHT));
  return { w: Math.max(1, Math.round(h * aspect)), h };
}
function syncSnap(ps) { ps1Uniforms.uSnap.value.set(ps.w / 2 * PS1_JITTER, ps.h / 2 * PS1_JITTER); }
// Strip the modern effects PS1 never had (godrays / bloom / DoF / SMAA / chroma).
function ps1Preset(p) {
  return { ...p, godraysEnabled: false, bloomEnabled: false, dofEnabled: false, smaaEnabled: false, chromAbEnabled: false };
}
const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'emissiveMap'];
function ps1ify(m, { snap = true } = {}) {
  if (!m) return;
  if (snap) applyVertexSnap(m);          // leaves opt out — snapping dense alpha
  for (const k of TEX_KEYS) if (m[k]) makeNearest(m[k]);   // foliage just titillates
}
import forestAudioUrl from './assets/forest.mp3';
import musicUrl from './assets/pine-drift.mp3';
import { isRecordMode, getRecordOpts, recordCanvasWithAudio } from './recorder.js';

// Record mode (URL hash `#record`) drives a demo capture for socials.
const RECORD = isRecordMode();
const REC = getRecordOpts();
let activeRecording = null;   // held so its AudioContext/dest nodes aren't GC'd

// ── Ambient forest audio ─────────────────────────────────────────────────────
// Loops in the background once a mode is chosen (the mode-button click is the
// user gesture browsers require before audio can play). Fades in, and a small
// speaker button lets you mute it.
const ambient = new Audio(forestAudioUrl);
ambient.loop = true;
ambient.preload = 'auto';
const AMBIENT_VOL = 0.5;
ambient.volume = AMBIENT_VOL;
ambient.muted = true;          // OFF by default — the 🔊 button unmutes + plays it
let ambientStarted = false;

// ── Music track ("Pine Drift") ───────────────────────────────────────────────
// OFF by default. The music button restarts it from the top each time you turn
// it on (tap again to stop). Independent of the ambient forest loop.
const music = new Audio(musicUrl);
music.loop = true;
music.preload = 'auto';
music.volume = 0.6;
let musicOn = false;
let paintMus = () => {};   // re-bound when the music button is created

function startAmbient() {
  if (ambientStarted) return;
  ambientStarted = true;
  ambient.play().then(() => {
    // Fade in over ~1.5 s so it eases in rather than cutting on.
    const t0 = performance.now();
    const fade = (now) => {
      const k = Math.min(1, (now - t0) / 1500);
      ambient.volume = AMBIENT_VOL * k;
      if (k < 1) requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
  }).catch(() => { /* autoplay blocked — the toggle can resume it */ });
}

// Autoplay the music from the top (called from the first user gesture).
function startMusic() {
  if (musicOn) return;
  musicOn = true;
  music.currentTime = 0;
  music.play().catch(() => { musicOn = false; paintMus(); });
  paintMus();
}

const AUDIO_BTN_BASE =
  'width:40px;height:40px;border-radius:8px;background:rgba(28,35,42,0.82);color:#cfd5dc;' +
  'border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(4px);cursor:pointer;' +
  'font-size:17px;line-height:1;display:flex;align-items:center;justify-content:center;';

// Round 🔊 / 🎵 buttons. Pass a `container` to drop them inline (desktop top HUD
// bar, after the other buttons); otherwise fixed bottom-right (mobile). Returns a
// remover so they can be tied to the session lifecycle.
function addAudioButtons(container = null) {
  const inBar = !!container;
  const parent = container || document.body;

  const snd = document.createElement('button');
  snd.type = 'button'; snd.classList.add('ui-toggleable');
  snd.style.cssText = inBar ? AUDIO_BTN_BASE : ('position:fixed;bottom:12px;right:12px;z-index:2147483647;' + AUDIO_BTN_BASE);
  const paintSnd = () => { snd.textContent = ambient.muted ? '🔇' : '🔊'; snd.title = ambient.muted ? 'Unmute ambience' : 'Mute ambience'; };
  snd.addEventListener('click', () => {
    ambient.muted = !ambient.muted;
    if (!ambient.muted && ambient.paused) ambient.play().catch(() => {});
    paintSnd();
  });
  paintSnd();

  const mus = document.createElement('button');
  mus.type = 'button'; mus.classList.add('ui-toggleable');
  mus.style.cssText = inBar ? AUDIO_BTN_BASE : ('position:fixed;bottom:12px;right:60px;z-index:2147483647;' + AUDIO_BTN_BASE);
  paintMus = () => { mus.textContent = '🎵'; mus.style.opacity = musicOn ? '1' : '0.45'; mus.title = musicOn ? 'Stop music' : 'Play music'; };
  mus.addEventListener('click', () => {
    musicOn = !musicOn;
    if (musicOn) { music.currentTime = 0; music.play().catch(() => { musicOn = false; paintMus(); }); }
    else { music.pause(); }
    paintMus();
  });
  paintMus();

  parent.appendChild(snd);
  parent.appendChild(mus);
  return () => { snd.remove(); mus.remove(); paintMus = () => {}; };
}

// ── Splash UI ───────────────────────────────────────────────────────────────
const overlay   = document.getElementById('overlay');
const btnFree   = document.getElementById('mode-free');
const btnDemo   = document.getElementById('mode-demo');
const btnInspect = document.getElementById('mode-inspect');
const btnStart  = document.getElementById('mode-start');
const modeBtns  = [btnFree, btnDemo, btnInspect].filter(Boolean);
let selectedMode = 'free';   // Walk pre-selected
const btnSettings = document.getElementById('open-settings');

// Pre-start forest settings (same panel on desktop & mobile). Edits CONFIG live;
// the chosen world seed is applied when a mode boots. Default seed is RANDOM per
// page load, so each visit is a fresh forest (different spawn species/layout).
// The 🎲 button in settings still rerolls it without reloading.
let chosenSeed = (Math.random() * 0x7fffffff) | 0;
let chosenSeason = 'verano';
const settings = buildSettings({
  onReseed: (s) => { chosenSeed = s; },
  onSeason: (name) => { chosenSeason = name; },
});
if (btnSettings) btnSettings.addEventListener('click', () => settings.show());
const tierBtns  = Array.from(document.querySelectorAll('.tier'));
const tierCaption = document.getElementById('tier-caption');
const TIER_CAPTIONS = {
  low:    'phones · integrated GPU',
  medium: 'most devices',
  high:   'desktop · dedicated GPU',
};
const backHint  = document.getElementById('back-hint');
const splashHint = document.getElementById('splash-hint');
const statsEl   = document.getElementById('stats');
const appEl     = document.getElementById('app');

const MOBILE = isMobile();

let selectedTier = detectDefaultTier();
syncTierUI();

function syncTierUI() {
  for (const btn of tierBtns) {
    btn.classList.toggle('active', btn.dataset.tier === selectedTier);
  }
  if (tierCaption) tierCaption.textContent = TIER_CAPTIONS[selectedTier] ?? '';
}
for (const btn of tierBtns) {
  btn.addEventListener('click', () => {
    selectedTier = btn.dataset.tier;
    syncTierUI();
  });
}

// On mobile "Walk" is driven by on-screen touch controls (joystick + drag look
// + toggleable gyro), so it's available there too.
if (MOBILE && splashHint) {
  splashHint.textContent = 'walk · joystick + drag to look';
}

// Record mode: pre-select High and turn "Demo" into the capture trigger. Clicking
// it is the user gesture audio/recording need; boot() runs the automated capture.
if (RECORD) {
  selectedTier = 'high';
  syncTierUI();
  if (btnDemo) btnDemo.textContent = `● Record demo (${REC.secs}s)`;
  if (splashHint) splashHint.textContent = `${REC.native ? 'native res' : `${REC.w}×${REC.h}`} · ${REC.secs}s · music @${REC.musicStart}s · ${REC.auto ? `auto R ${REC.rint}s` : 'press R to the beat'}`;
}

let started = false;
function chooseMode(mode) {
  if (started) return;
  started = true;
  // Audio is OFF by default in this exploratory build — the 🔊/🎵 buttons start it.
  for (const b of modeBtns) b.disabled = true;
  if (btnStart) btnStart.disabled = true;
  // Switch the splash to an opaque loading screen so no half-built scene shows
  // through while textures/shaders load. It fades out only once everything's in.
  overlay.classList.add('loading');
  // Defer one frame so the loading screen paints before the heavy boot work.
  requestAnimationFrame(() => boot(getPreset(selectedTier), mode));
}

// Fade the loading overlay away only after `readyPromise` settles AND two frames
// have rendered, so the first frame the user sees is the fully-loaded scene.
function revealWhenReady(readyPromise) {
  Promise.resolve(readyPromise).catch(() => {})
    .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    .then(() => { overlay.classList.add('hidden'); });
}
// Mode buttons are a SWITCH: clicking one only selects it (highlights), it doesn't
// boot. The Begin button starts whichever mode is selected.
function selectMode(mode) {
  selectedMode = mode;
  for (const b of modeBtns) b.classList.toggle('selected', b.dataset.mode === mode);
}
for (const b of modeBtns) b.addEventListener('click', () => selectMode(b.dataset.mode));
selectMode(selectedMode);   // Walk pre-selected
if (btnStart) btnStart.addEventListener('click', () => chooseMode(selectedMode));

// ── Return to menu (no page reload) ───────────────────────────────────────────
// Every session (boot or inspector) registers teardown callbacks here. Returning
// to the menu runs them — stopping the render loop, disposing the renderer/GPU
// context, and removing all in-scene DOM/listeners — then re-shows the splash so
// the user can pick a different tier/mode. The ambient audio keeps playing.
let activeCleanups = [];
function returnToMenu() {
  for (const fn of activeCleanups) { try { fn(); } catch (_) { /* keep tearing down */ } }
  activeCleanups = [];
  document.body.classList.remove('ui-hidden');
  overlay.classList.remove('hidden', 'loading');
  backHint.classList.remove('show');
  started = false;
  for (const b of modeBtns) b.disabled = false;
  if (btnStart) btnStart.disabled = false;
  if (statsEl) statsEl.textContent = 'initializing…';
}

// ── Boot ────────────────────────────────────────────────────────────────────
function boot(preset, mode) {
  preset = ps1Preset(preset);             // PS1: no godrays/bloom/DoF/SMAA
  if (MOBILE) {
    backHint.innerHTML = mode === 'free'
      ? 'joystick to move · drag to look · ✕ Exit to leave'
      : 'tilt phone to look · 🧭 toggles gyro · ✕ Exit to leave';
  } else if (mode === 'free') {
    backHint.innerHTML = 'WASD move · Shift run · arrows look · <kbd>Esc</kbd> for menu';
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  // PS1: render into a small fixed buffer at devicePixelRatio 1; CSS upscales it
  // nearest-neighbour (the pixelation). uSnap = half the buffer so vertices land
  // on its pixel grid.
  renderer.setPixelRatio(1);
  { const ps = pixelSize(); renderer.setSize(ps.w, ps.h, false); syncSnap(ps); }
  renderer.domElement.style.cssText = 'width:100%;height:100%;image-rendering:pixelated;';
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // NOTE: do NOT set toneMapping here — buildPipeline sets NoToneMapping and
  // adds a ToneMappingEffect inside the composer, so bloom can act on real HDR.
  // Shadows are tier-driven now: Low turns them (and godrays) off entirely, which
  // removes the whole shadow-map render pass — the biggest low-end win.
  renderer.shadowMap.enabled = preset.shadowsEnabled !== false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  appEl.appendChild(renderer.domElement);

  // First teardown step: stop the loop and drop the WebGL context so repeated
  // menu round-trips don't leak contexts (browsers cap them at ~16).
  activeCleanups.push(() => {
    renderer.setAnimationLoop(null);
    try { renderer.dispose(); renderer.forceContextLoss(); } catch (_) { /* ignore */ }
    renderer.domElement.remove();
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    72, window.innerWidth / window.innerHeight, 0.05, 250
  );
  camera.position.set(0, 1.7, 0);
  camera.lookAt(0, 1.7, -1);

  // ── Inspector mode: one centred tree + orbit camera, no world/grass/post ──
  if (mode === 'inspect') {
    const insp = buildInspector(renderer, scene, camera, preset, { onReturnToMenu: returnToMenu });
    if (insp?.dispose) activeCleanups.push(insp.dispose);
    revealWhenReady(null);     // no grass/textures to wait on, just a couple frames
    return;
  }

  const env       = buildEnvironment(scene, renderer, preset);
  // PS1-style sun shafts (flat additive billboards, not volumetric godrays).
  const shafts    = buildSunShafts(scene, env.sunDir);
  activeCleanups.push(() => shafts.dispose());
  const templates = buildTemplates({
    lowPoly: true,
    leavesCountMult: preset.leavesCountMult,
    includeIds: preset.treePresets,      // Low tier builds only a curated subset
    geomMult: preset.geomMult ?? 1.0,    // Low tier also cuts branch resolution
  });
  const world     = buildWorld(scene, templates, {
    worldSeed:      chosenSeed,
    viewChunks:     preset.viewChunks,
    treeCastShadow: preset.treeCastShadow,
    renderDistance: preset.renderDistance,
  });

  const grass = buildGrass(scene, {
    gridSide:      preset.grassGridSide,
    cellSize:      preset.grassCellSize,
    clumpHeight:   0.55,
    clumpWidth:    0.55,
    planes:        preset.grassPlanes,
    segments:      4,
    windAmp:       0.08,
    baseColor:     '#2f3f1e',
    tipColor1:     '#a6cf7e',
    tipColor2:     '#46662b',
    edgeFadeStart: preset.grassEdgeFade,
  });

  // Sun is required by the godrays pass; pass it to the pipeline.
  const post = buildPipeline(renderer, scene, camera, preset, env.sun);
  const dust = buildDust(scene, { count: preset.dustCount });

  // ── Seasons ────────────────────────────────────────────────────────────────
  // Patch the leaf materials (pines = evergreen) before compile, build the
  // falling-particle system, then apply the chosen season to everything.
  for (const t of templates) applySeasonToLeaf(t.leafMat, t.id.startsWith('pine'));
  const seasonFx = buildSeasonParticles(scene, { count: preset.dustCount > 0 ? 450 : 250 });
  // PS1: pull lights down so the LINEAR clamp doesn't blow highlights out. Called
  // after every setSeason (which resets intensities to the season's values).
  const PS1_SUN = 0.66, PS1_HEMI = 0.82;
  const ps1Exposure = () => { env.sun.intensity *= PS1_SUN; env.hemi.intensity *= PS1_HEMI; };
  setSeason(chosenSeason, { grass, env, particles: seasonFx });
  ps1Exposure();

  // ── PS1: vertex snap + nearest textures on the scene's surface materials ─────
  // (Trees, grass, ground. NOT the sky dome — snapping it would wobble the sky;
  // NOT the particles — they're point sprites.) Done before the first compile.
  for (const t of templates) {
    const isBush = t.id?.startsWith('bush');     // bushes: thin, close geometry → snapping them titillates hard
    ps1ify(t.branchMat, { snap: !isBush });
    ps1ify(t.leafMat, { snap: false });
  }
  ps1ify(grass.material);
  ps1ify(env.ground.material);
  seasonFx.setHeightPx(pixelSize().h);           // keep falling-particle size resolution-independent
  // Grass alpha/noise live in uniforms, not material.map — nearest them once in.
  Promise.resolve(grass.ready).then(() => {
    makeNearest(grass.uniforms?.uGrassAlpha?.value);
    makeNearest(grass.uniforms?.uNoiseTex?.value);
  }).catch(() => {});

  // three-good-godrays has NO phase function — it accumulates lit air along the
  // view ray regardless of where the sun is, so rays read the same with your
  // back to the sun. We re-introduce the expected directional falloff by fading
  // `density` toward 0 as the camera looks away from the sun. `grControl` is the
  // shared base the GUI edits; `directional` toggles the falloff.
  const grControl = {
    baseDensity: preset.godraysDensity ?? 0.013,
    directional: true,
    floor: 0.12,        // residual rays even facing away (atmospheric haze)
  };
  const _camFwd = new THREE.Vector3();
  // Set the density UNIFORM directly each frame. NOT setParams() — that repopulates
  // every other param to its default (white colour, blur, resolutionScale → setSize),
  // which recreated the render targets every frame and flickered to black.
  const grDensityU = post.godrays?.illumPass?.material?.uniforms?.density ?? null;

  // Two godray looks; alternate randomly. A = the warm cream default, B = denser,
  // pale-green, no distance attenuation, higher back-turned floor.
  function rollGodrays() {
    if (!post.godrays) return;
    const A = {
      baseDensity: preset.godraysDensity ?? 0.013, maxDensity: preset.godraysMaxDensity ?? 0.5,
      distanceAttenuation: preset.godraysDistanceAtten ?? 1.0, color: preset.godraysColor ?? 0xffe6bf,
      directional: true, floor: 0.12,
    };
    const B = {
      baseDensity: 0.0345, maxDensity: 0.21, distanceAttenuation: 0.0,
      color: 0xcdf1d8, directional: true, floor: 0.4,
    };
    const gp = Math.random() < 0.5 ? A : B;
    grControl.baseDensity = gp.baseDensity;
    grControl.directional = gp.directional;
    grControl.floor = gp.floor;
    post.godrays.setParams({
      density: gp.baseDensity, maxDensity: gp.maxDensity, distanceAttenuation: gp.distanceAttenuation,
      color: new THREE.Color(gp.color),
      raymarchSteps: preset.godraysRaymarchSteps ?? 60, blur: preset.godraysBlur ?? true,
      gammaCorrection: false,
    });
  }
  rollGodrays();

  // ── In-game Randomize: re-roll everything and regenerate the world live ──────
  let gui = null;     // assigned below (desktop only); used to also randomize graphics
  const _rnd = (mn, mx, st) => mn + Math.floor(Math.random() * ((mx - mn) / st + 1)) * st;
  const SEASON_KEYS = ['otono', 'invierno', 'primavera', 'verano'];
  function randomizeForest() {
    setForestConfig({
      densityMin: _rnd(0, 20, 1), densityMax: _rnd(5, 40, 1), densityZone: _rnd(30, 250, 5),
      groveZone: _rnd(20, 200, 5), offSpecies: _rnd(0, 0.6, 0.01), bushChance: _rnd(0, 0.6, 0.01),
      giantChance: _rnd(0, 0.1, 0.005),
      speciesWeight: {
        oak: _rnd(0, 4, 0.1), ash: _rnd(0, 4, 0.1), aspen: _rnd(0, 4, 0.1), pine: _rnd(0, 4, 0.1),
      },
    });
    setSeason(SEASON_KEYS[Math.floor(Math.random() * SEASON_KEYS.length)], { grass, env, particles: seasonFx });
    ps1Exposure();
    rollGodrays();
    gui?.randomizeGraphics?.();                         // also re-roll the post-processing look
    world.setSeed((Math.random() * 0x7fffffff) | 0);   // triggers a live regenerate
  }
  // Shared button style for the on-screen HUD controls.
  const hudBtnCss =
    'pointer-events:auto;padding:9px 13px;border-radius:8px;background:rgba(28,35,42,0.82);' +
    'color:#cfd5dc;border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(4px);cursor:pointer;' +
    'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:600;';
  const makeHudBtn = (text, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = text; b.style.cssText = hudBtnCss;
    b.addEventListener('click', onClick);
    return b;
  };
  // On mobile: Randomize bottom-centre, audio buttons bottom-right.
  if (MOBILE) {
    const rb = makeHudBtn('Random', randomizeForest);
    rb.style.cssText += 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:42;';
    document.body.appendChild(rb);
    activeCleanups.push(() => rb.remove());
    activeCleanups.push(addAudioButtons());
  }

  // Build the controller for the chosen mode. Both expose the same shape:
  // { update(dt, world), isAuto }.
  let explorer;
  let mobileHud = null;
  if (mode === 'free' && MOBILE) {
    // Touch walk: joystick + drag look + toggleable gyro + its own Exit button.
    explorer = buildMobilePlayer(camera, scene, { onExit: () => returnToMenu() });
  } else if (mode === 'free') {
    explorer = buildPlayer(camera, renderer.domElement, scene);
    // Defer the lock request one frame so it isn't fighting the click that hid
    // the overlay (Chrome rejects pointer-lock from a synthetic-looking event).
    requestAnimationFrame(() => {
      try { explorer.controls.lock(); } catch (_) { /* user-gesture race */ }
    });
    // Re-acquire lock on click (e.g. after the first attempt lost the race).
    renderer.domElement.addEventListener('click', () => {
      if (!explorer.controls.isLocked) {
        try { explorer.controls.lock(); } catch (_) { /* ignore */ }
      }
    });
    // Esc pops out of pointer-lock → frees the mouse so the GUI is usable. It
    // does NOT return to the menu (that's the GUI's "Reload / Menu" button), so
    // you can tweak post-processing mid-walk and click the canvas to resume.
  } else {
    explorer = buildDemo(camera, scene, env.sunDir);
    if (MOBILE) {
      enableGyro();
      // Exit button + gyro toggle for the hands-off demo mode.
      mobileHud = buildAutoMobileHud({ onExit: () => returnToMenu(), gyroOn: true });
    }
  }
  if (explorer?.dispose) activeCleanups.push(() => explorer.dispose());
  if (mobileHud?.dispose) activeCleanups.push(() => mobileHud.dispose());
  if (post?.composer?.dispose) activeCleanups.push(() => { try { post.composer.dispose(); } catch (_) { /* ignore */ } });

  // Surface the back hint briefly.
  backHint.classList.add('show');
  setTimeout(() => backHint.classList.remove('show'), 3500);

  // Reveal the scene only once the grass textures are in and a frame has drawn —
  // no more flash of half-loaded scene right after pressing a mode.
  revealWhenReady(grass.ready);

  // ── Return-to-menu ────────────────────────────────────────────────────────
  // returnToMenu (module scope) tears this session down and re-shows the splash
  // WITHOUT reloading the page. On mobile the on-screen "✕ Exit" button is the
  // way back; on desktop, Esc returns from demo mode (walk mode keeps Esc for the
  // GUI / pointer-lock).
  const onEscMenu = (e) => { if (e.code === 'Escape' && mode === 'demo') returnToMenu(); };
  window.addEventListener('keydown', onEscMenu);
  activeCleanups.push(() => window.removeEventListener('keydown', onEscMenu));

  // 'R' re-rolls everything (same as the Randomize button).
  const onKeyR = (e) => { if (e.code === 'KeyR') randomizeForest(); };
  window.addEventListener('keydown', onKeyR);
  activeCleanups.push(() => window.removeEventListener('keydown', onKeyR));

  // ── Live tuning GUI (desktop debug build) ─────────────────────────────────
  // Set DoF focus once here so the GUI can own it (no per-frame override).
  if (post.setFocusTarget) post.setFocusTarget(explorer.isAuto ? 9 : 6);
  const ps1Controls = {
    get height() { return PS1_HEIGHT; },
    set height(v) { PS1_HEIGHT = v; onResize(); },
    get jitter() { return PS1_JITTER; },
    set jitter(v) { PS1_JITTER = v; syncSnap(pixelSize()); },
    effect: post.effects.ps1,
  };
  if (!MOBILE) {
    gui = buildDebugGui({ post, env, grass, scene, world, preset, grControl, ps1: ps1Controls, onReturnToMenu: returnToMenu });
    if (gui?.destroy) activeCleanups.push(() => gui.destroy());

    if (gui?.domElement) gui.domElement.classList.add('dbg-gui');

    // "Hide UI" hides ALL on-screen UI (these buttons, the lil-gui panel and the
    // stats HUD) for a clean render-only view, leaving just a small restore
    // square. CSS does the hiding so it's atomic. 'O' toggles it.
    const style = document.createElement('style');
    style.textContent =
      'body.ui-hidden .ui-toggleable, body.ui-hidden #hud, body.ui-hidden .dbg-gui { display:none !important; }' +
      '.ui-restore { display:none; }' +
      'body.ui-hidden .ui-restore { display:flex !important; }';
    document.head.appendChild(style);
    activeCleanups.push(() => style.remove());

    // A flex row so the buttons keep an even 8px gap regardless of label width
    // (fixed left offsets left "Hide UI" drifting far from "Randomize").
    const btnBar = document.createElement('div');
    btnBar.classList.add('ui-toggleable');
    btnBar.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;display:flex;gap:8px;';
    document.body.appendChild(btnBar);
    activeCleanups.push(() => btnBar.remove());
    const placeBtn = (text, onClick) => {
      const b = makeHudBtn(text, onClick);
      btnBar.appendChild(b);
      return b;
    };
    placeBtn('Exit', returnToMenu);
    placeBtn('Randomize', randomizeForest);
    placeBtn('Hide UI', () => document.body.classList.add('ui-hidden'));
    // Desktop: 🔊 / 🎵 sit in the same top bar, after the buttons (OFF by default).
    activeCleanups.push(addAudioButtons(btnBar));

    // Small restore square — only visible while the UI is hidden.
    const restore = makeHudBtn('', () => document.body.classList.remove('ui-hidden'));
    restore.className = 'ui-restore';
    restore.title = 'Show UI (O)';
    restore.innerHTML = '<span style="display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-radius:2px;"></span>';
    restore.style.cssText += 'position:fixed;top:12px;left:12px;z-index:2147483647;align-items:center;justify-content:center;';
    document.body.appendChild(restore);
    activeCleanups.push(() => restore.remove());

    const onKeyO = (e) => { if (e.code === 'KeyO') document.body.classList.toggle('ui-hidden'); };
    window.addEventListener('keydown', onKeyO);
    activeCleanups.push(() => window.removeEventListener('keydown', onKeyO));
  }

  const onResize = () => {
    const ps = pixelSize();                       // keep the small PS1 buffer
    renderer.setSize(ps.w, ps.h, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    post.resize();
    syncSnap(ps);
    seasonFx.setHeightPx(ps.h);
  };
  window.addEventListener('resize', onResize);
  activeCleanups.push(() => window.removeEventListener('resize', onResize));

  // ── Frame loop ────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let frameCount = 0;
  let lastStatTime = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;

    explorer.update(dt, world);

    const counts = world.update(camera);
    grass.update(camera);
    grass.setTime(t);
    dust.update(camera, t);
    seasonFx.update(camera, t, world);
    shafts.update(camera, t);
    env.setTime(t);
    env.updateSun(camera.position);
    updateWind(t);

    // Directional godray falloff: fade rays out as the camera turns away from
    // the sun, so they no longer read the same with your back to it.
    if (grDensityU) {
      let factor = 1;
      if (grControl.directional) {
        camera.getWorldDirection(_camFwd);
        const facing = _camFwd.dot(env.sunDir);                 // -1 away … +1 toward
        const f = THREE.MathUtils.smoothstep(facing, -0.15, 0.55);
        factor = grControl.floor + (1 - grControl.floor) * f;
      }
      grDensityU.value = grControl.baseDensity * factor;
    }

    post.composer.render();
    frameCount++;

    if (t - lastStatTime > 0.5) {
      const fps = Math.round(frameCount / (t - lastStatTime));
      // trees drawn / in-fog-range / total-loaded — the gap between the last
      // two is what v06 was wastefully rendering.
      statsEl.textContent =
        `${mode}  ·  ${preset.label}  ·  fps ${fps}  ·  trees ${counts.totalVisible}/${counts.totalInRange}/${counts.totalActive}` +
        `  ·  calls ${renderer.info.render.calls}`;
      frameCount = 0;
      lastStatTime = t;
    }
  });

  // ── Automated capture (record mode) ───────────────────────────────────────
  if (RECORD && mode === 'demo') {
    const startRec = () => {
      // Unless recording at native window resolution, lock the drawing buffer to
      // the target social size (CSS untouched, so the captured stream is exactly
      // REC.w × REC.h regardless of window size).
      if (!REC.native) {
        renderer.setSize(REC.w, REC.h, false);
        post.composer.setSize(REC.w, REC.h);
        camera.aspect = REC.w / REC.h;
        camera.updateProjectionMatrix();
      }
      document.body.classList.add('ui-hidden');        // clean, UI-free frame

      // Music: start from its 0:50 mark at video second 0 (clamped so the clip
      // doesn't run off the end of the track).
      ambient.muted = false;
      music.muted = false;
      const dur = Number.isFinite(music.duration) ? music.duration : null;
      const startAt = dur ? Math.min(REC.musicStart, Math.max(0, dur - REC.secs - 1)) : REC.musicStart;
      try { music.currentTime = startAt; } catch (_) { /* metadata not ready */ }
      music.play().catch(() => {});

      // R cuts: by default YOU press R to the beat (the R key works during the
      // capture). With ?auto=1 it fires on a timer, delayed by roffset so the cuts
      // sit on the beat (first at roffset+rint, then every rint).
      let rInterval = null, rStart = null;
      if (REC.auto) {
        rStart = setTimeout(() => { rInterval = setInterval(randomizeForest, REC.rint * 1000); }, REC.roffset * 1000);
      }

      // REC indicator + countdown. It's a DOM overlay, so it is NOT in the captured
      // canvas — it only helps you time the R presses and see when it ends.
      const recDot = document.createElement('div');
      recDot.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'font:600 14px ui-monospace,Menlo,Consolas,monospace;color:#fff;background:rgba(180,30,30,0.85);' +
        'padding:6px 12px;border-radius:8px;letter-spacing:0.06em;pointer-events:none;';
      document.body.appendChild(recDot);
      let remain = REC.secs;
      const paintDot = () => { recDot.textContent = `● REC  ${remain}s${REC.auto ? '' : '  ·  press R to the beat'}`; };
      paintDot();
      const dotTimer = setInterval(() => { remain = Math.max(0, remain - 1); paintDot(); }, 1000);

      activeRecording = recordCanvasWithAudio({
        canvas: renderer.domElement,
        fps: REC.fps,
        mbps: REC.mbps,
        audioElements: [ambient, music],
        durationMs: REC.secs * 1000,
        onStop: () => {
          if (rStart) clearTimeout(rStart);
          if (rInterval) clearInterval(rInterval);
          clearInterval(dotTimer);
          recDot.remove();
          music.pause();
          console.log('[13] recording saved — send me the .webm to convert to mp4');
        },
      });
    };
    // Begin only once the scene is fully loaded (grass textures in) + 2 frames.
    Promise.resolve(grass.ready).catch(() => {})
      .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      .then(startRec);
  }

  renderer.compile(scene, camera);
  console.log(
    `[13] tier=${preset.label}`,
    `grass=${grass.total}`,
    `viewChunks=${preset.viewChunks}`,
    `renderDist=${preset.renderDistance}`,
    `shadow=${preset.shadowMapSize}`,
    `HDR=${preset.halfFloatHDR}`,
    `godrays=${preset.godraysEnabled ? `on(steps=${preset.godraysRaymarchSteps})` : 'off'}`,
  );
}
