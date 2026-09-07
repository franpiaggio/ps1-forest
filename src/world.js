// Chunk-streamed, FOV-culled forest. Same shape as v05; in v06 trees ALWAYS
// cast shadow so the godrays pass has occluders to raymarch against. The leaf
// InstancedMesh gets a dedicated MeshDepthMaterial that honors the alphaMap +
// alphaTest, otherwise leaf quads would project as solid squares and the
// rays piercing the canopy would look like rectangular bars.

import * as THREE from 'three';
import { CHUNK_SIZE, chunkKey, generateChunk } from './chunk.js';
import { applyWind } from './wind.js';
import { terrainHeight } from './terrain.js';

const MAX_INSTANCES_PER_TEMPLATE = 500;
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export function buildWorld(scene, templates, { worldSeed = 1337, viewChunks = 4, treeCastShadow = false, renderDistance = 28 } = {}) {
  // Trees past this horizontal distance from the camera are fully dissolved by
  // fog (THREE.Fog hits factor 0 at fogFar), so rendering them — and casting
  // their shadows — is pure waste. v06 had no such cull: the frustum kept every
  // tree out to the chunk-load radius (~128 m), rendering ~10-30× more trees
  // than the fog ever shows. Culling at fog distance is the single biggest perf
  // win on modest hardware.
  const renderDist2 = renderDistance * renderDistance;
  const pools = templates.map(tpl => {
    const branches = new THREE.InstancedMesh(tpl.branchGeom, tpl.branchMat, MAX_INSTANCES_PER_TEMPLATE);
    const leaves   = new THREE.InstancedMesh(tpl.leafGeom,   tpl.leafMat,   MAX_INSTANCES_PER_TEMPLATE);

    // Custom depth material for alpha-tested leaf shadows. Three.js auto-
    // derives a depth material for MeshStandardMaterial, but the derivation
    // path for InstancedMesh + alphaMap is finicky across versions — pinning
    // an explicit MeshDepthMaterial is the reliable fix and makes the canopy
    // cast lacy shadows that the godrays pass picks up beautifully.
    if (treeCastShadow) {
      leaves.customDepthMaterial = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        map: tpl.leafMat.map || null,
        alphaTest: tpl.leafMat.alphaTest ?? 0.5,
        side: THREE.DoubleSide,
      });
    }

    for (const m of [branches, leaves]) {
      m.castShadow    = treeCastShadow;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
    applyWind(tpl.leafMat);
    return { branches, leaves };
  });

  const activeChunks = new Map();
  const candidates = [];
  let lastCenterCX = Number.NaN, lastCenterCZ = Number.NaN;
  let currentSeed = worldSeed;
  let needsRegen = false;

  function rebuildCandidates() {
    candidates.length = 0;
    for (const chunk of activeChunks.values()) {
      for (const t of chunk.trees) candidates.push(t);
    }
  }

  function updateActive(cx, cz) {
    const wanted = new Set();
    for (let dz = -viewChunks; dz <= viewChunks; dz++) {
      for (let dx = -viewChunks; dx <= viewChunks; dx++) {
        const k = chunkKey(cx + dx, cz + dz);
        wanted.add(k);
        if (!activeChunks.has(k)) {
          activeChunks.set(k, generateChunk(cx + dx, cz + dz, currentSeed, templates));
        }
      }
    }
    for (const k of activeChunks.keys()) {
      if (!wanted.has(k)) activeChunks.delete(k);
    }
    rebuildCandidates();
  }

  const tmpMatrix = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();

  // Drop all cached chunks so the next update() rebuilds them with the current
  // config/seed. A flag coalesces many GUI changes per frame into one rebuild.
  function regenerate() { needsRegen = true; }
  function setSeed(s) { currentSeed = s | 0; needsRegen = true; }

  function update(camera) {
    if (needsRegen) {
      activeChunks.clear();
      lastCenterCX = lastCenterCZ = Number.NaN;
      needsRegen = false;
    }
    const cx = Math.floor(camera.position.x / CHUNK_SIZE);
    const cz = Math.floor(camera.position.z / CHUNK_SIZE);
    if (cx !== lastCenterCX || cz !== lastCenterCZ) {
      updateActive(cx, cz);
      lastCenterCX = cx;
      lastCenterCZ = cz;
    }

    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);

    const writeIdx = new Array(pools.length).fill(0);
    const camX = camera.position.x, camZ = camera.position.z;
    let totalInRange = 0;

    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];

      const tpl = templates[t.templateIdx];
      const h = tpl.height * t.scale;

      // Distance cull FIRST. Cull by the tree's NEAR edge, not its centre: a tree
      // appears once its near side reaches the boundary, so its centre is still
      // beyond renderDistance (fully fogged) and it fades IN through the fog
      // instead of popping. Giants tower over the canopy → loom from even farther.
      const dx = t.x - camX, dz = t.z - camZ;
      const reach = renderDistance + h * (t.giant ? 0.7 : 0.5);
      if (dx * dx + dz * dz > reach * reach) continue;
      totalInRange++;
      // Cull sphere must sit at the tree's ACTUAL height on the terrain — using a
      // flat y=h*0.5 put small props (bushes) at the wrong height on the relief,
      // so their tiny sphere missed the frustum and they vanished up close.
      const groundY = terrainHeight(t.x, t.z);
      sphere.center.set(t.x, groundY + h * 0.5, t.z);
      sphere.radius = h * 0.7;
      if (!frustum.intersectsSphere(sphere)) continue;

      const slot = writeIdx[t.templateIdx];
      if (slot >= MAX_INSTANCES_PER_TEMPLATE) continue;

      tmpPos.set(t.x, groundY, t.z);                   // sit on the terrain
      tmpQuat.setFromAxisAngle(AXIS_Y, t.rotY);
      tmpScale.setScalar(t.scale);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      pools[t.templateIdx].branches.setMatrixAt(slot, tmpMatrix);
      pools[t.templateIdx].leaves.setMatrixAt(slot, tmpMatrix);
      writeIdx[t.templateIdx] = slot + 1;
    }

    let totalVisible = 0;
    for (let i = 0; i < pools.length; i++) {
      const n = writeIdx[i];
      pools[i].branches.count = n;
      pools[i].leaves.count = n;
      pools[i].branches.instanceMatrix.needsUpdate = true;
      pools[i].leaves.instanceMatrix.needsUpdate = true;
      totalVisible += n;
    }
    return { totalActive: candidates.length, totalInRange, totalVisible };
  }

  function getNearbyTrees(x, z, radius) {
    const out = [];
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const rPad = radius + 1;
    const r2 = rPad * rPad;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = activeChunks.get(chunkKey(cx + dx, cz + dz));
        if (!chunk) continue;
        for (const t of chunk.trees) {
          const ddx = t.x - x, ddz = t.z - z;
          if (ddx * ddx + ddz * ddz <= r2) out.push(t);
        }
      }
    }
    return out;
  }

  return { update, getNearbyTrees, pools, regenerate, setSeed };
}
