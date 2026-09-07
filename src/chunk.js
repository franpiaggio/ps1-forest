// A chunk is a deterministic patch of forest at integer coords (cx, cz).
// Given (cx, cz, worldSeed), we always produce the same set of trees —
// regenerating after the player loops back is free.

export const CHUNK_SIZE = 32;

// Tiny seeded RNG (mulberry32) — deterministic, no state shared between chunks.
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

function hashCoords(cx, cz, worldSeed) {
  // Cantor-pair-ish mix so adjacent chunks decorrelate.
  let h = worldSeed | 0;
  h = (h * 374761393 + (cx | 0)) | 0;
  h = (h * 668265263 + (cz | 0)) | 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export function chunkKey(cx, cz) {
  return `${cx}|${cz}`;
}

// ── Coherent low-frequency value noise ───────────────────────────────────────
// hashCoords is white noise (decorrelated per chunk); for density fields and
// species groves we need a SMOOTH field that spans many chunks. This is a tiny
// bilinear-interpolated value noise over a coarse integer grid.
function ihash(ix, iz, seed) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (ix | 0), 374761393);
  h = Math.imul(h ^ (iz | 0), 668265263);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;       // 0..1
}
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = ihash(ix, iz, seed),     b = ihash(ix + 1, iz, seed);
  const c = ihash(ix, iz + 1, seed), d = ihash(ix + 1, iz + 1, seed);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}

// ── Live-tunable generation config (driven by the GUI's "Forest" folder) ─────
// All forest-shape knobs live here so they can be changed at runtime; world.js
// regenerates the active chunks when any of these change.
export const CONFIG = {
  densityMin:  16,    // high density by default (denser clearings)
  densityMax:  30,    // dense thickets
  densityZone: 105,   // metres per clearing↔thicket feature
  groveZone:   72,    // metres per single-species grove
  offSpecies:  0.22,  // chance a tree breaks its grove's species (soft edges)
  bushChance:  0.22,  // share of spawns that are understory bushes
  trellisChance: 0.01,
  // Rare "ancient" giants: a small chance a tree spawns much larger than normal,
  // towering over the canopy as a landmark. They claim proportionally more space.
  giantChance: 0.02,  // ~2% of trees
  giantMin:    2.2,   // scale multiplier range
  giantMax:    3.2,
  // per-species multiplier — default biased toward ash (an ash-dominant forest)
  speciesWeight: { oak: 1, ash: 2, aspen: 1, pine: 1 },
};

export function setForestConfig(partial = {}) {
  if (partial.speciesWeight) {
    Object.assign(CONFIG.speciesWeight, partial.speciesWeight);
    delete partial.speciesWeight;
  }
  Object.assign(CONFIG, partial);
}

// ── Density field — how MANY objects this chunk gets ─────────────────────────
function targetForChunk(cx, cz, worldSeed) {
  const wx = (cx + 0.5) * CHUNK_SIZE / CONFIG.densityZone;
  const wz = (cz + 0.5) * CHUNK_SIZE / CONFIG.densityZone;
  let n = valueNoise(wx, wz, worldSeed ^ 0x0d1ce5);
  n = n * n * (3 - 2 * n);                          // smoothstep → punchier extremes
  return Math.round(CONFIG.densityMin + n * (CONFIG.densityMax - CONFIG.densityMin));
}

// ── Species field — WHICH species dominates this patch (groves) ──────────────
// The grove noise is mapped through a WEIGHTED cumulative of the species, so a
// heavier species (more weight) claims a larger share of the noise range → more
// and bigger groves of it. Spatial coherence (same spot → same species) is kept.
function zoneSpecies(x, z, worldSeed, keys) {
  const n = valueNoise(x / CONFIG.groveZone, z / CONFIG.groveZone, worldSeed ^ 0x5be3d0);
  let total = 0;
  for (const k of keys) total += CONFIG.speciesWeight[k] ?? 1;
  let r = n * total;
  for (const k of keys) { r -= CONFIG.speciesWeight[k] ?? 1; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

// Per-object "personal space" radius (metres). Two objects can't be placed
// closer than the SUM of their clearances, so big trees keep breathing room
// while bushes can still cluster as undergrowth.
function clearanceFor(tpl) {
  if (tpl.category === 'bush')    return 0.5;
  if (tpl.category === 'trellis') return 0.9;
  if (tpl.id.endsWith('-l'))      return 2.3;   // Large trees
  if (tpl.id.endsWith('-s'))      return 1.4;   // Small trees
  return 1.8;                                    // Medium trees
}

// Split templates into species groups + bushes + trellis (by id/category).
function categorize(templates) {
  const species = {}, bushes = [], trellis = [];
  templates.forEach((t, i) => {
    if (t.category === 'bush') bushes.push(i);
    else if (t.category === 'trellis') trellis.push(i);
    else {
      const sp = t.id.split('-')[0];
      (species[sp] = species[sp] || []).push(i);
    }
  });
  return { species, speciesKeys: Object.keys(species), bushes, trellis };
}

// Pick a species key weighted by CONFIG.speciesWeight (used for off-grove trees).
function pickSpeciesKey(rng, keys) {
  let total = 0;
  for (const k of keys) total += CONFIG.speciesWeight[k] ?? 1;
  let r = rng() * total;
  for (const k of keys) { r -= CONFIG.speciesWeight[k] ?? 1; if (r <= 0) return k; }
  return keys[keys.length - 1];
}

// Weighted pick within a subset of template indices (Large trees stay rarer).
function pickFrom(rng, templates, idxList) {
  let total = 0;
  for (const i of idxList) total += templates[i].weight ?? 1;
  let r = rng() * total;
  for (const i of idxList) { r -= templates[i].weight ?? 1; if (r <= 0) return i; }
  return idxList[idxList.length - 1];
}

export function generateChunk(cx, cz, worldSeed, templates) {
  const rng = mulberry32(hashCoords(cx, cz, worldSeed));
  const cats = categorize(templates);
  const target = targetForChunk(cx, cz, worldSeed);   // density varies per zone
  const trees = [];
  const baseX = cx * CHUNK_SIZE;
  const baseZ = cz * CHUNK_SIZE;
  const tries = Math.max(40, target * 10);

  for (let i = 0; i < tries && trees.length < target; i++) {
    const x = baseX + rng() * CHUNK_SIZE;
    const z = baseZ + rng() * CHUNK_SIZE;

    // Choose what to plant: bush / trellis / a tree of the zone's grove species.
    const roll = rng();
    let templateIdx;
    if (cats.bushes.length && roll < CONFIG.bushChance) {
      templateIdx = cats.bushes[Math.floor(rng() * cats.bushes.length)];
    } else if (cats.trellis.length && roll < CONFIG.bushChance + CONFIG.trellisChance) {
      templateIdx = cats.trellis[Math.floor(rng() * cats.trellis.length)];
    } else {
      let sp = zoneSpecies(x, z, worldSeed, cats.speciesKeys);
      if (rng() < CONFIG.offSpecies) {                 // soften grove edges
        sp = pickSpeciesKey(rng, cats.speciesKeys);    // weighted toward heavier species
      }
      templateIdx = pickFrom(rng, templates, cats.species[sp]);
    }
    const tpl = templates[templateIdx];
    const isTree = tpl.category !== 'bush' && tpl.category !== 'trellis';

    // Rare giant: a few trees tower over the canopy. Decide first so its much
    // larger clearance gates placement (giants stand in their own small clearing).
    let giantMult = 1;
    if (isTree && rng() < CONFIG.giantChance) {
      giantMult = CONFIG.giantMin + rng() * (CONFIG.giantMax - CONFIG.giantMin);
    }
    const giant = giantMult > 1;
    const clearance = clearanceFor(tpl) * giantMult;

    // Dart-throw: reject if the two clearance circles would overlap.
    let ok = true;
    for (const t of trees) {
      const dx = t.x - x, dz = t.z - z;
      const minD = clearance + t.clearance;
      if (dx * dx + dz * dz < minD * minD) { ok = false; break; }
    }
    if (!ok) continue;

    const sMin = tpl.scaleMin ?? 0.7, sMax = tpl.scaleMax ?? 1.3;
    const scale = (sMin + rng() * (sMax - sMin)) * giantMult;
    const rotY = rng() * Math.PI * 2;
    trees.push({
      x, z,
      templateIdx,
      scale,
      rotY,
      clearance,
      giant,
      colRadius: tpl.trunkRadius * scale + 0.15,
    });
  }
  return { cx, cz, trees };
}
