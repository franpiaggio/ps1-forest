// Seasons. Recolours the canopy (per-leaf, luminance-preserving, with intra-tree
// variation), the grass, the ground tint, the sky/fog/sun palette, and swaps the
// falling particles (autumn leaves / winter snow / spring petals). Evergreens
// (pines) keep most of their colour through autumn and winter.

import * as THREE from 'three';
import { terrainHeight, TERRAIN_GLSL } from './terrain.js';

const LEAF_ATLAS_URL = new URL('./assets/leaves-atlas.png', import.meta.url).href;
const MAX_LEAF_ANCHORS = 16;     // how many nearby trees can shed leaves at once
const ATLAS_GRID = 4;   // 4×4 = 16 leaf variants

export const SEASONS = {
  verano: {
    label: 'Summer',
    leafA: '#6f9a45', leafB: '#557f36', leafMix: 0.30,
    grass: { base: '#3b4d25', tip1: '#a6cf7e', tip2: '#5a7d36' },
    ground: '#ffffff',
    horizon: '#acb9c0', zenith: '#586a78', sunGlow: '#ffe1ad',
    sun: '#ffe2b8', sunInt: 1.7, hemiSky: '#d2e5ff', hemiGround: '#3a2a18', hemiInt: 0.78,
    particle: 'none',
  },
  otono: {
    label: 'Autumn',
    leafA: '#cf8324', leafB: '#9e2f16', leafMix: 0.88,
    grass: { base: '#52471f', tip1: '#caa85a', tip2: '#7a5e2a' },
    ground: '#c8a36c',
    horizon: '#c9bfa6', zenith: '#6e6a64', sunGlow: '#ffcf85',
    sun: '#ffcf95', sunInt: 1.7, hemiSky: '#e6dcc4', hemiGround: '#3a2a14', hemiInt: 0.82,
    particle: 'leaves',
  },
  invierno: {
    label: 'Winter',
    leafA: '#d3dce2', leafB: '#9fae9a', leafMix: 0.9,
    grass: { base: '#8a96a0', tip1: '#dfe6ea', tip2: '#aeb9c0' },
    ground: '#ffffff', snow: true,
    horizon: '#cbd6dd', zenith: '#71808c', sunGlow: '#e3edf5',
    sun: '#e3edf6', sunInt: 1.35, hemiSky: '#dde8f2', hemiGround: '#2a3038', hemiInt: 0.92,
    particle: 'snow',
  },
  primavera: {
    label: 'Spring',
    leafA: '#86ba4c', leafB: '#b6d98a', leafMix: 0.5,
    grass: { base: '#42612a', tip1: '#bfe08a', tip2: '#6aa03e' },
    ground: '#ffffff',
    horizon: '#bdd0c7', zenith: '#5f7a82', sunGlow: '#ffeec0',
    sun: '#fff0d2', sunInt: 1.65, hemiSky: '#d8ecdf', hemiGround: '#33301a', hemiInt: 0.84,
    particle: 'petals',
  },
};

// Shared leaf uniforms — one set drives every leaf material at once.
export const seasonLeafUniforms = {
  uSeasonLeafA: { value: new THREE.Color('#6f9a45') },
  uSeasonLeafB: { value: new THREE.Color('#557f36') },
  uSeasonMix:   { value: 0.30 },
};

// Patch a leaf material to tint toward the season colour, keeping the texture's
// luminance detail and varying per-instance (vSeasonVar). `evergreen` pines keep
// most of their original colour.
export function applySeasonToLeaf(mat, evergreen = false) {
  if (!mat || mat.userData?.__season) return;
  mat.userData = mat.userData || {};
  mat.userData.__season = true;
  mat.userData.uEvergreen = { value: evergreen ? 1.0 : 0.0 };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    Object.assign(shader.uniforms, {
      uSeasonLeafA: seasonLeafUniforms.uSeasonLeafA,
      uSeasonLeafB: seasonLeafUniforms.uSeasonLeafB,
      uSeasonMix:   seasonLeafUniforms.uSeasonMix,
      uEvergreen:   mat.userData.uEvergreen,
    });
    shader.vertexShader = 'varying float vSeasonVar;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'void main() {\n  vSeasonVar = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);'
    );
    shader.fragmentShader =
      'uniform vec3 uSeasonLeafA; uniform vec3 uSeasonLeafB; uniform float uSeasonMix; uniform float uEvergreen; varying float vSeasonVar;\n'
      + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
      {
        float _l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 _s = mix(uSeasonLeafA, uSeasonLeafB, vSeasonVar);
        float _m = uSeasonMix * (1.0 - uEvergreen * 0.78);
        diffuseColor.rgb = mix(diffuseColor.rgb, _s * (0.35 + 0.9 * _l), _m);
      }`
    );
    mat.userData.shader = shader;
  };
  mat.needsUpdate = true;
}

// Apply a season everywhere. env exposes setPalette; grass exposes uniforms.
export function setSeason(name, { grass, env, particles } = {}) {
  const s = SEASONS[name] || SEASONS.verano;
  seasonLeafUniforms.uSeasonLeafA.value.set(s.leafA);
  seasonLeafUniforms.uSeasonLeafB.value.set(s.leafB);
  seasonLeafUniforms.uSeasonMix.value = s.leafMix;
  if (grass?.uniforms) {
    grass.uniforms.uBaseColor.value.set(s.grass.base);
    grass.uniforms.uTipColor1.value.set(s.grass.tip1);
    grass.uniforms.uTipColor2.value.set(s.grass.tip2);
    if (grass.uniforms.uTintVar) grass.uniforms.uTintVar.value = s.snow ? 0.15 : 1.0;
  }
  if (env?.ground) env.ground.material.color.set(s.ground);
  if (env?.setPalette) env.setPalette(s);
  if (particles?.setType) particles.setType(s.particle);
  return s;
}

// ── Falling particles (leaves / snow / petals) — GPU-driven, follows camera ──
const PARTICLE_TYPES = {
  none:   { visible: false },
  snow:   { frac: 0.62, fall: 3.5, size: 1.5, sway: 0.6, opacity: 0.9,  tex: false, a: '#eef4f8', b: '#dfe8ef' },
  leaves: { frac: 0.016, fall: 2.6, size: 5.5, sway: 2.0, opacity: 1.0,  tex: true,  a: '#ffffff', b: '#ffffff' },
  petals: { frac: 0.26, fall: 2.2, size: 1.7, sway: 1.5, opacity: 0.85, tex: false, a: '#f1bcd2', b: '#e89ec0' },
};

const P_VERT = /* glsl */ `
  ${TERRAIN_GLSL}
  attribute vec3 aSeed;
  uniform float uTime, uFall, uSize, uSway, uBoxW, uBoxH;
  uniform float uHeightPx;   // render-buffer height, so point size is resolution-independent
  uniform vec3 uCamera;
  uniform float uUseTex;
  uniform int  uAnchorCount;                 // # of nearby trees shedding leaves
  uniform vec4 uAnchors[${MAX_LEAF_ANCHORS}]; // x,z = trunk; .z = terrain height; .w = canopy radius
  varying float vR;
  varying vec2 vCell;   // atlas cell (col,row)
  varying float vRot;   // tumble angle
  void main() {
    float ci = floor(aSeed.x * 16.0);
    vCell = vec2(mod(ci, 4.0), floor(ci / 4.0));
    vRot = aSeed.y * 6.2832 + uTime * (aSeed.z - 0.5) * 1.6;   // tumbling
    float ph = aSeed.x * 6.2832;
    float sway = uSway * sin(uTime * (0.7 + aSeed.z) + ph);
    vec3 wp;
    if (uUseTex > 0.5 && uAnchorCount > 0) {
      // LEAVES: shed from the canopy of a nearby tree (not the open sky). Each
      // particle is bound to one tree anchor and falls within its canopy disc.
      int idx = int(mod(floor(aSeed.x * 163.0 + aSeed.z * 269.0), float(uAnchorCount)));
      vec4 anc = uAnchors[idx];
      float ang = aSeed.y * 6.2832;
      float rad = sqrt(aSeed.z) * anc.w;            // uniform within the canopy disc
      float lx = anc.x + cos(ang) * rad;
      float lz = anc.y + sin(ang) * rad;
      float ground = terrainH(vec2(lx, lz));        // local terrain UNDER this leaf
      float canopyH = 4.0 + anc.w * 1.6;            // fall height: canopy top → ground
      float fall = mod(uTime * uFall + aSeed.y * canopyH, canopyH);
      wp.x = lx + sway;
      wp.z = lz + cos(uTime * 0.6 + ph) * uSway * 0.6;
      wp.y = ground + canopyH - fall;               // lands on the local ground, loops
    } else {
      // SNOW / PETALS: world-space positions that wrap around the camera so you
      // fall THROUGH them instead of dragging them along.
      float box = uBoxW * 2.0;
      float px = aSeed.x * box;
      float pz = aSeed.z * box;
      float fall = mod(uTime * uFall + aSeed.y * uBoxH, uBoxH);
      wp.x = px + box * floor((uCamera.x - px) / box + 0.5) + sway;
      wp.z = pz + box * floor((uCamera.z - pz) / box + 0.5) + cos(uTime * 0.6 + ph) * uSway * 0.6;
      wp.y = uCamera.y + uBoxH * 0.6 - fall;
    }
    vR = aSeed.x;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (60.0 / max(-mv.z, 1.0)) * (uHeightPx / 1000.0);
  }
`;
const P_FRAG = /* glsl */ `
  uniform vec3 uColorA, uColorB;
  uniform float uOpacity, uUseTex, uAtlas;
  uniform sampler2D uTex;
  varying float vR;
  varying vec2 vCell;
  varying float vRot;
  void main() {
    vec2 pc = gl_PointCoord - 0.5;
    if (uUseTex > 0.5) {
      // rotate the sprite (tumbling leaf), then sample its atlas cell
      float c = cos(vRot), s = sin(vRot);
      pc = mat2(c, -s, s, c) * pc + 0.5;
      if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0) discard;
      vec2 uv = (vCell + pc) / uAtlas;     // texture is flipY=false → top-down match
      vec4 tx = texture2D(uTex, uv);
      if (tx.a < 0.4) discard;
      gl_FragColor = vec4(tx.rgb, tx.a * uOpacity);
    } else {
      if (length(pc) > 0.5) discard;
      float a = (1.0 - smoothstep(0.2, 0.5, length(pc))) * uOpacity;
      gl_FragColor = vec4(mix(uColorA, uColorB, vR), a);
    }
  }
`;

export function buildSeasonParticles(scene, { count = 500 } = {}) {
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) seeds[i] = Math.random();
  const geom = new THREE.BufferGeometry();
  // position attribute unused by the shader but required; reuse seeds buffer slot
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

  const atlas = new THREE.TextureLoader().load(LEAF_ATLAS_URL);
  atlas.flipY = false;                 // so cell rows map top-down like gl_PointCoord
  atlas.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.ShaderMaterial({
    vertexShader: P_VERT, fragmentShader: P_FRAG,
    uniforms: {
      uTime: { value: 0 }, uFall: { value: 3 }, uSize: { value: 2 }, uSway: { value: 1 },
      uHeightPx: { value: 1000 },
      uBoxW: { value: 18 }, uBoxH: { value: 22 }, uCamera: { value: new THREE.Vector3() },
      uColorA: { value: new THREE.Color('#ffffff') }, uColorB: { value: new THREE.Color('#ffffff') },
      uOpacity: { value: 0.9 },
      uTex: { value: atlas }, uUseTex: { value: 0 }, uAtlas: { value: ATLAS_GRID },
      uAnchorCount: { value: 0 },
      uAnchors: { value: new Float32Array(MAX_LEAF_ANCHORS * 4) },
    },
    transparent: true, depthWrite: false,
  });
  const anchorsFlat = mat.uniforms.uAnchors.value;

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  let currentType = 'none';
  function setType(type) {
    currentType = type;
    const t = PARTICLE_TYPES[type] || PARTICLE_TYPES.none;
    if (!t.visible && t.visible !== undefined && type === 'none') { points.visible = false; return; }
    if (type === 'none') { points.visible = false; return; }
    points.visible = true;
    mat.uniforms.uFall.value = t.fall;
    mat.uniforms.uSize.value = t.size;
    mat.uniforms.uSway.value = t.sway;
    mat.uniforms.uOpacity.value = t.opacity;
    mat.uniforms.uUseTex.value = t.tex ? 1 : 0;   // leaves use the atlas, snow/petals = dots
    mat.uniforms.uColorA.value.set(t.a);
    mat.uniforms.uColorB.value.set(t.b);
    geom.setDrawRange(0, Math.floor(count * t.frac));
  }

  function update(camera, t, world) {
    mat.uniforms.uTime.value = t;
    mat.uniforms.uCamera.value.copy(camera.position);

    // Leaves only: bind them to the nearest trees so they shed from canopies, not
    // the open sky. Refresh the anchor list each frame (closest N real trees).
    if (currentType === 'leaves' && world?.getNearbyTrees) {
      const cx = camera.position.x, cz = camera.position.z;
      const near = world.getNearbyTrees(cx, cz, mat.uniforms.uBoxW.value)
        .filter((tr) => tr.colRadius > 0.28)          // real trees, not bushes
        .sort((a, b) => ((a.x - cx) ** 2 + (a.z - cz) ** 2) - ((b.x - cx) ** 2 + (b.z - cz) ** 2));
      const n = Math.min(MAX_LEAF_ANCHORS, near.length);
      for (let i = 0; i < n; i++) {
        const tr = near[i];
        anchorsFlat[i * 4]     = tr.x;
        anchorsFlat[i * 4 + 1] = tr.z;
        anchorsFlat[i * 4 + 2] = terrainHeight(tr.x, tr.z);
        anchorsFlat[i * 4 + 3] = 1.8 + 0.9 * tr.scale;    // canopy radius ~ tree size
      }
      mat.uniforms.uAnchorCount.value = n;
      mat.uniforms.uAnchors.needsUpdate = true;
    }
  }

  function setHeightPx(px) { mat.uniforms.uHeightPx.value = px; }

  return { update, setType, points, setHeightPx };
}
