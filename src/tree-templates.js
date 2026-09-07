// Pre-generates the EZ-Tree templates once at boot, with tier-aware
// leaf density (huge perf lever — leaves dominate the vertex budget when
// looking up through the canopy).

import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';

// v08: every preset ez-tree ships. ez-tree's native sizes are HUGE (Oak Medium
// ≈ 61 m, Oak Large ≈ 97 m — ~3× a real tree), which made the world feel giant
// and walking glacial. So each template is normalised to a realistic
// `targetHeight` (metres) at build time, and `scaleMin/Max` are just per-instance
// variation around it. `weight` biases the random mix (trees common, Large rarer,
// bushes a scattered understory, trellis a rarity).
const RECIPES = [
  // ── Trees — normalised to realistic heights ──
  { id: 'oak-l',   preset: 'Oak Large',    seed: 7,   trunkRadius: 0.85, weight: 2, targetHeight: 24, scaleMin: 0.85, scaleMax: 1.15 },
  { id: 'oak-m',   preset: 'Oak Medium',   seed: 13,  trunkRadius: 0.55, weight: 4, targetHeight: 17, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'oak-s',   preset: 'Oak Small',    seed: 71,  trunkRadius: 0.40, weight: 3, targetHeight: 11, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'ash-l',   preset: 'Ash Large',    seed: 23,  trunkRadius: 0.70, weight: 2, targetHeight: 23, scaleMin: 0.85, scaleMax: 1.15 },
  { id: 'ash-m',   preset: 'Ash Medium',   seed: 29,  trunkRadius: 0.45, weight: 3, targetHeight: 17, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'ash-s',   preset: 'Ash Small',    seed: 37,  trunkRadius: 0.32, weight: 3, targetHeight: 11, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'aspen-l', preset: 'Aspen Large',  seed: 31,  trunkRadius: 0.45, weight: 2, targetHeight: 22, scaleMin: 0.85, scaleMax: 1.15 },
  { id: 'aspen-m', preset: 'Aspen Medium', seed: 41,  trunkRadius: 0.28, weight: 3, targetHeight: 16, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'aspen-s', preset: 'Aspen Small',  seed: 43,  trunkRadius: 0.22, weight: 3, targetHeight: 10, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'pine-l',  preset: 'Pine Large',   seed: 47,  trunkRadius: 0.55, weight: 2, targetHeight: 23, scaleMin: 0.85, scaleMax: 1.15 },
  { id: 'pine-m',  preset: 'Pine Medium',  seed: 53,  trunkRadius: 0.42, weight: 3, targetHeight: 16, scaleMin: 0.85, scaleMax: 1.20 },
  { id: 'pine-s',  preset: 'Pine Small',   seed: 59,  trunkRadius: 0.32, weight: 3, targetHeight: 11, scaleMin: 0.85, scaleMax: 1.20 },
  // ── Bushes — low understory ──
  { id: 'bush-1',  preset: 'Bush 1',       seed: 61,  trunkRadius: 0.12, weight: 4, targetHeight: 2.4, scaleMin: 0.80, scaleMax: 1.25, category: 'bush' },
  { id: 'bush-2',  preset: 'Bush 2',       seed: 67,  trunkRadius: 0.12, weight: 4, targetHeight: 2.6, scaleMin: 0.80, scaleMax: 1.25, category: 'bush' },
  { id: 'bush-3',  preset: 'Bush 3',       seed: 73,  trunkRadius: 0.12, weight: 4, targetHeight: 2.2, scaleMin: 0.80, scaleMax: 1.25, category: 'bush' },
  // ── Trellis — a garden prop, rare ──
  { id: 'trellis', preset: 'Trellis',      seed: 79,  trunkRadius: 0.15, weight: 1, targetHeight: 3.0, scaleMin: 0.90, scaleMax: 1.10, category: 'trellis' },
];

// ez-tree stores branch sections/segments and leaf count as numbers, arrays, OR
// objects keyed by branch level ({0:12,1:10,…}). The old code only handled the
// array case, so the branch-geometry reduction was silently a no-op. This scales
// any of those shapes in place.
function scaleCounts(obj, key, factor, floor) {
  const v = obj[key];
  if (typeof v === 'number') {
    obj[key] = Math.max(floor, Math.floor(v * factor));
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = Math.max(floor, Math.floor(v[i] * factor));
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = Math.max(floor, Math.floor(v[k] * factor));
  }
}

function softenGeometry(tree, leavesCountMult, geomMult) {
  const b = tree.options?.branch;
  if (b && geomMult < 1.0) {                 // branch length/round resolution
    scaleCounts(b, 'sections', geomMult, 2);
    scaleCounts(b, 'segments', geomMult, 3);
  }
  // Leaf count is the single biggest perf lever once trees stream in.
  const lv = tree.options?.leaves;
  if (lv && leavesCountMult < 1.0) {
    scaleCounts(lv, 'count', leavesCountMult, 4);
  }
}

function tuneLeaves(mat) {
  // Do NOT override alphaTest — ez-tree tunes it per species (pine 0.3, oak 0.5,
  // …). Forcing 0.5 over-cut the pine's soft needle alpha and left the pines
  // sparse and spiky. Keep the rest (already ez-tree's defaults) as a safety.
  mat.transparent = false;
  mat.depthWrite = true;
  mat.side = THREE.DoubleSide;
}

// CRITICAL: EZ-Tree's leaf material installs an onBeforeCompile that replaces
// the standard `#include <project_vertex>` chunk — but its replacement drops
// the `#ifdef USE_INSTANCING / mvPosition = instanceMatrix * mvPosition;`
// block. Without re-injecting it, every leaf instance renders at origin.
function patchLeafInstancing(mat) {
  const orig = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof orig === 'function') orig(shader, renderer);

    shader.vertexShader = shader.vertexShader.replace(
      'mvPosition = modelViewMatrix * mvPosition;',
      /* glsl */ `
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      mvPosition = modelViewMatrix * mvPosition;`
    );

    // Per-tree wind phase: sample at instance-world XYZ so each canopy has its
    // own beat instead of swaying in unison.
    shader.vertexShader = shader.vertexShader.replace(
      'float windOffset = 2.0 * 3.14 * simplex3(mvPosition.xyz / uWindScale);',
      /* glsl */ `
      vec4 _instWorld = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        _instWorld = instanceMatrix * _instWorld;
      #endif
      float windOffset = 2.0 * 3.14 * simplex3(_instWorld.xyz / uWindScale);`
    );

    mat.userData.shader = shader;
  };
  mat.needsUpdate = true;
}

export function buildTemplates({ lowPoly = true, leavesCountMult = 1.0, includeIds = null, geomMult = 1.0 } = {}) {
  const templates = [];
  const recipes = includeIds ? RECIPES.filter(r => includeIds.includes(r.id)) : RECIPES;
  for (const recipe of recipes) {
    const tree = new Tree();
    tree.loadPreset(recipe.preset);
    tree.options.seed = recipe.seed;
    if (lowPoly) softenGeometry(tree, leavesCountMult, geomMult);
    tree.generate();

    const branchGeom = tree.branchesMesh.geometry;
    const leafGeom = tree.leavesMesh.geometry;
    const branchMat = tree.branchesMesh.material;
    const leafMat = tree.leavesMesh.material;
    tuneLeaves(leafMat);
    patchLeafInstancing(leafMat);

    // Normalise the (huge) native geometry to a realistic target height. ez-tree
    // builds with the base at y≈0, so a uniform scale keeps the tree planted.
    branchGeom.computeBoundingBox();
    let nativeH = branchGeom.boundingBox
      ? branchGeom.boundingBox.max.y - branchGeom.boundingBox.min.y
      : 6;
    const norm = recipe.targetHeight ? recipe.targetHeight / nativeH : 1;
    if (norm !== 1) {
      branchGeom.scale(norm, norm, norm);
      leafGeom.scale(norm, norm, norm);
      branchGeom.computeBoundingBox();
    }
    const bb = branchGeom.boundingBox;
    const height = bb ? bb.max.y - bb.min.y : (recipe.targetHeight ?? 6);

    templates.push({
      id: recipe.id,
      branchGeom, branchMat,
      leafGeom,   leafMat,
      trunkRadius: recipe.trunkRadius,
      height,
      weight:   recipe.weight   ?? 1,
      scaleMin: recipe.scaleMin ?? 0.7,
      scaleMax: recipe.scaleMax ?? 1.3,
      category: recipe.category ?? 'tree',
    });
  }
  return templates;
}
