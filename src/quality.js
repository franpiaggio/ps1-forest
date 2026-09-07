// Graphics tier presets — same shape as v05 but with godrays knobs added,
// and a key constraint: every tier must run shadows because the godrays pass
// raymarches the directional light's shadow map. There is no "godrays without
// shadows". Low tier therefore keeps a small (512²) shadow map and uses cheap
// raymarch settings; medium and high scale up.
//
//   low    — phones / integrated GPUs. Small shadow map, few raymarch steps,
//            no godray blur, no DoF, tiny bloom, light dust.
//   medium — modern mobile / mid-range laptops. 1024² shadow map, moderate
//            raymarch steps with blur, full atmospherics.
//   high   — desktop / gaming. 2048² shadow map, fat raymarch steps with blur,
//            longest view distance.
//
// Godrays color is a warm cream that matches the sun light tint (#fff2dc) so
// the rays don't read as a separate effect bolted on top.

export const TIER_PRESETS = {
  low: {
    label: 'Low',
    sub:   'Low-end · modest phones',

    // The expensive systems — shadows, godrays, bloom, SMAA — are all OFF on
    // this tier. That, plus a low DPR and short view distance, is what lets it
    // run on low-end phones. (Shadows were previously forced on for godrays; with
    // godrays off there's no reason to pay for a shadow map.)
    dpr:           0.6,
    halfFloatHDR:  true,
    shadowsEnabled: false,            // no shadow-map render pass at all
    shadowMapSize: 512,
    smaaEnabled:   false,             // low DPR hides edges; skip the AA pass

    // World streaming — short distance + a curated handful of species → few
    // draw calls (the full 16-template set is ~32 InstancedMeshes).
    viewChunks:    2,
    renderDistance: 20,
    treePresets:   ['oak-m', 'oak-s', 'ash-m', 'aspen-m', 'pine-m', 'bush-1', 'bush-2'],

    // Grass — fewer, simpler clumps.
    grassGridSide:    80,
    grassCellSize:    0.5,            // ~6.4k clumps, field radius ≈ 20 m
    grassPlanes:      2,
    grassEdgeFade:    0.84,

    // Trees — aggressive leaf + branch-geometry reduction (lowPoly soften).
    leavesCountMult:  0.40,
    geomMult:         0.55,          // cut branch sections/segments ~45%
    treeCastShadow:   false,
    groundReceiveShadow: false,

    // Atmosphere
    dustCount:        0,
    fogNear:          5,
    fogFar:           20,            // = renderDistance so trees fade in (no pop)

    // Post-processing — tone mapping + a light vignette only.
    dofEnabled:       false,
    bloomEnabled:     false,
    chromAbEnabled:   false,
    grainEnabled:     false,
    vignetteOffset:   0.34,
    vignetteDarkness: 0.40,

    // Godrays OFF — they raymarch the shadow map, far too costly for this tier.
    godraysEnabled:   false,
  },

  medium: {
    label: 'Medium',
    sub:   'Most modern devices',

    dpr:           1.0,
    halfFloatHDR:  true,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    smaaEnabled:   true,
    smaaPreset:    'MEDIUM',
    treePresets:   null,             // all 16

    viewChunks:    2,
    renderDistance: 34,

    grassGridSide:    175,
    grassCellSize:    0.40,            // ~30k clumps, field radius ≈ 35 m (reaches the fog)
    grassPlanes:      3,
    grassEdgeFade:    0.88,

    leavesCountMult:  0.75,
    treeCastShadow:   true,
    groundReceiveShadow: true,

    dustCount:        200,
    fogNear:          6,
    fogFar:           32,

    dofEnabled:       true,
    dofBokehScale:    1.8,
    dofResScale:      0.5,
    bloomEnabled:     true,
    bloomKernel:      'MEDIUM',
    bloomIntensity:   0.16,
    bloomThreshold:   0.94,
    bloomSmoothing:   0.15,
    chromAbEnabled:   false,
    grainEnabled:     false,
    vignetteOffset:   0.30,
    vignetteDarkness: 0.50,

    godraysEnabled:        true,
    godraysDensity:        0.016,
    godraysMaxDensity:     0.55,
    godraysDistanceAtten:  1.0,
    godraysRaymarchSteps:  52,
    godraysBlur:           true,
    godraysColor:          0xffe6bf,
  },

  high: {
    label: 'High',
    sub:   'Desktop / gaming GPU',

    dpr:           1.25,
    halfFloatHDR:  true,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    smaaEnabled:   true,
    smaaPreset:    'HIGH',
    treePresets:   null,             // all 16

    // High = desktop/gaming GPU: push the fog way back and render trees much
    // farther so the fog reads as light haze instead of a near wall. viewChunks
    // bumped to 3 (±96 m) so chunks exist out to the longer renderDistance.
    viewChunks:    3,
    renderDistance: 70,

    grassGridSide:    240,
    grassCellSize:    0.40,            // ~58k clumps, field radius ≈ 48 m (reaches the fog)
    grassPlanes:      3,
    grassEdgeFade:    0.90,

    leavesCountMult:  1.0,
    treeCastShadow:   true,
    groundReceiveShadow: true,

    dustCount:        320,
    fogNear:          14,            // haze starts farther out
    fogFar:           68,            // trees stay visible ~2x farther than before

    dofEnabled:       true,
    dofBokehScale:    2.6,
    dofResScale:      0.5,
    bloomEnabled:     true,
    bloomKernel:      'MEDIUM',
    bloomIntensity:   0.20,
    bloomThreshold:   0.92,
    bloomSmoothing:   0.18,
    chromAbEnabled:   false,
    grainEnabled:     false,
    vignetteOffset:   0.30,
    vignetteDarkness: 0.50,

    godraysEnabled:        true,
    godraysDensity:        0.020,
    godraysMaxDensity:     0.60,
    godraysDistanceAtten:  0.9,
    godraysRaymarchSteps:  72,
    godraysBlur:           true,
    godraysColor:          0xffe6bf,
  },
};

export function detectDefaultTier() {
  if (typeof navigator === 'undefined') return 'medium';

  const ua = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (window.matchMedia?.('(pointer: coarse)')?.matches && 'ontouchstart' in window);

  const cores = navigator.hardwareConcurrency ?? 4;
  const mem   = navigator.deviceMemory ?? 4;

  if (cores < 4 || mem < 4) return 'low';
  if (isMobile && (cores < 6 || mem < 6)) return 'low';
  if (isMobile) return 'medium';

  if (cores >= 8 && mem >= 8) return 'high';
  return 'medium';
}

export function getPreset(tier) {
  return TIER_PRESETS[tier] ?? TIER_PRESETS.medium;
}
