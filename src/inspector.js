// Single-tree inspector mode. Centres one tree, orbit camera (works with touch),
// a preset selector to swap species/size, and a Regenerate button for a new seed.
// No world / grass / fog — just the tree on the ground so you can study it.

import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildEnvironment } from './environment.js';
import { applyWind, updateWind } from './wind.js';

const PRESETS = [
  'Oak Large', 'Oak Medium', 'Oak Small',
  'Ash Large', 'Ash Medium', 'Ash Small',
  'Aspen Large', 'Aspen Medium', 'Aspen Small',
  'Pine Large', 'Pine Medium', 'Pine Small',
  'Bush 1', 'Bush 2', 'Bush 3', 'Trellis',
];

// Real-world target heights (same as the forest), so the three sizes actually
// look different in the inspector. The camera uses a FIXED frame (REF_HEIGHT),
// NOT each tree's height — otherwise every preset would fill the frame the same
// and Large/Medium/Small would look identical.
const TARGET_H = {
  'Oak Large': 24, 'Oak Medium': 17, 'Oak Small': 11,
  'Ash Large': 23, 'Ash Medium': 17, 'Ash Small': 11,
  'Aspen Large': 22, 'Aspen Medium': 16, 'Aspen Small': 10,
  'Pine Large': 23, 'Pine Medium': 16, 'Pine Small': 11,
  'Bush 1': 2.4, 'Bush 2': 2.6, 'Bush 3': 2.2, 'Trellis': 3.0,
};
const REF_HEIGHT = 24;        // framing reference (tallest tree); fixed across presets

export function buildInspector(renderer, scene, camera, preset, { onReturnToMenu } = {}) {
  // Plain ACES render (no composer) — clean, predictable lighting for a viewer.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const env = buildEnvironment(scene, renderer, preset);
  scene.fog = null;                       // show the whole tree, top to bottom
  env.updateSun(new THREE.Vector3(0, 0, 0));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 120;
  controls.maxPolarAngle = Math.PI * 0.495;   // don't dip under the ground
  // Fixed frame around REF_HEIGHT so taller presets genuinely look taller.
  controls.target.set(0, REF_HEIGHT * 0.42, 0);
  camera.position.set(REF_HEIGHT * 1.1, REF_HEIGHT * 0.55, REF_HEIGHT * 1.1);
  controls.update();

  // Human-height (1.8 m) reference pole so the size is legible at a glance.
  const ref = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 1.8, 8),
    new THREE.MeshStandardMaterial({ color: 0xc94f3a, roughness: 0.7 }),
  );
  ref.position.set(2.4, 0.9, 2.4);
  ref.castShadow = true;
  scene.add(ref);

  const statsEl = document.getElementById('stats');
  let presetLabel = 'Oak Medium';
  let seed = 1;
  let current = null;

  function disposeTree() {
    if (!current) return;
    scene.remove(current.group);
    current.branchGeom?.dispose();
    current.leafGeom?.dispose();
    current.branchMat?.dispose();
    current.leafMat?.dispose();
    current = null;
  }

  function buildTree() {
    disposeTree();
    const tree = new Tree();
    tree.loadPreset(presetLabel);
    tree.options.seed = seed;
    tree.generate();

    const branches = tree.branchesMesh;
    const leaves = tree.leavesMesh;
    const leafMat = leaves.material;
    // Respect ez-tree's per-species alphaTest (pine 0.3, oak 0.5, …); just make
    // sure the leaves stay in the opaque pass and light from both sides.
    leafMat.transparent = false;
    leafMat.depthWrite = true;
    leafMat.side = THREE.DoubleSide;
    applyWind(leafMat);

    branches.castShadow = true;
    leaves.castShadow = true;
    branches.receiveShadow = true;

    branches.geometry.computeBoundingBox();
    const bb = branches.geometry.boundingBox;
    const h = Math.max(0.001, bb.max.y - bb.min.y);
    const targetH = TARGET_H[presetLabel] ?? 16;
    const s = targetH / h;                 // realistic height — NOT a fixed display size

    const group = new THREE.Group();
    group.add(branches);
    group.add(leaves);
    group.scale.setScalar(s);
    scene.add(group);

    current = {
      group,
      branchGeom: branches.geometry, leafGeom: leaves.geometry,
      branchMat: branches.material, leafMat,
    };
    if (statsEl) statsEl.textContent = `inspector · ${presetLabel} · ${targetH} m · seed ${seed}`;
  }

  buildTree();

  // ── On-screen controls (touch-friendly) ───────────────────────────────────
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:30;' +
    'display:flex;gap:8px;align-items:center;background:rgba(8,11,14,0.72);' +
    'padding:8px 10px;border-radius:12px;backdrop-filter:blur(4px);' +
    'font-family:ui-monospace,Menlo,Consolas,monospace;';

  const sel = document.createElement('select');
  sel.setAttribute('aria-label', 'preset');
  sel.style.cssText =
    'padding:10px 8px;border-radius:8px;background:#1a222a;color:#cfd5dc;' +
    'border:1px solid rgba(255,255,255,0.12);font:inherit;font-size:14px;max-width:46vw;';
  for (const p of PRESETS) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    sel.appendChild(o);
  }
  sel.value = presetLabel;
  sel.addEventListener('change', () => { presetLabel = sel.value; seed = 1; buildTree(); });

  const btnRegen = document.createElement('button');
  btnRegen.type = 'button';
  btnRegen.textContent = '⟳ Regenerate';
  btnRegen.style.cssText =
    'padding:10px 14px;border:none;border-radius:8px;background:rgba(255,212,130,0.92);' +
    'color:#1a1308;font:inherit;font-weight:600;font-size:14px;cursor:pointer;white-space:nowrap;';
  btnRegen.addEventListener('click', () => { seed = (seed + 1) % 100000; buildTree(); });

  const btnMenu = document.createElement('button');
  btnMenu.type = 'button';
  btnMenu.textContent = '↩';
  btnMenu.title = 'Menu';
  btnMenu.style.cssText =
    'padding:10px 13px;border:none;border-radius:8px;background:rgba(48,60,70,0.95);' +
    'color:#ffd482;font:inherit;font-size:15px;cursor:pointer;';
  btnMenu.addEventListener('click', () => onReturnToMenu?.());

  bar.append(sel, btnRegen, btnMenu);
  document.body.appendChild(bar);

  const onEsc = (e) => { if (e.code === 'Escape') onReturnToMenu?.(); };
  window.addEventListener('keydown', onEsc);

  const onResize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  // ── Loop ───────────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    controls.update();
    updateWind(clock.getElapsedTime());
    renderer.render(scene, camera);
  });

  // Teardown for a clean return to the menu (no page reload).
  function dispose() {
    renderer.setAnimationLoop(null);
    window.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', onResize);
    controls.dispose();
    disposeTree();
    ref.geometry.dispose();
    ref.material.dispose();
    bar.remove();
  }

  return { dispose };
}
