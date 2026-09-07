// "Fluffy" grass — v07 rewrite based on Ebenezer's FluffyGrass technique
// (https://github.com/thebenezer/FluffyGrass, MIT). The earlier geometric-blade
// versions read as a static comb of vertical lines; this is the real recipe:
//
//   • each instance is a CLUMP of crossed vertical planes,
//   • an alpha texture (grass-blades.jpeg) cuts a fan of soft blades out of
//     each plane, so a clump looks full from every angle,
//   • a perlin noise texture drives wind, per-place colour variation and height,
//   • colour is a base→tip gradient, the tip mixed between two greens by noise.
//
// We keep our own infinite-streaming trick: one InstancedMesh, the clump XZ is
// derived in the vertex shader from gl_InstanceID + uPlayerCell with a wrap
// mod(), so the field follows the player forever. uTime is driven through
// applyWind() like the leaves.
//
// Asset credit: src/assets/CREDITS.txt.

import * as THREE from 'three';
import { applyWind } from './wind.js';
import { TERRAIN_GLSL } from './terrain.js';

const ALPHA_URL = new URL('./assets/grass-blades.jpeg', import.meta.url).href;
const NOISE_URL = new URL('./assets/perlin-noise.webp', import.meta.url).href;

const DEFAULTS = {
  gridSide:      145,
  cellSize:      0.36,
  clumpHeight:   0.55,
  clumpWidth:    0.55,
  planes:        3,
  segments:      4,
  edgeFadeStart: 0.90,
  windAmp:       0.08,
  aoFloor:       0.72,
  baseColor:     '#3b4d25',
  tipColor1:     '#a6cf7e',
  tipColor2:     '#5a7d36',
  halfSize:      0,
};

// One clump = `planes` vertical quads crossed around Y, each carrying the full
// blade-fan texture. Normals point straight up so the clump shades like a soft
// tuft instead of a set of dark cards.
function buildClumpGeometry({ clumpHeight, clumpWidth, planes, segments, gridSide, cellSize }) {
  const verts = [];
  const uvs = [];
  const normals = [];
  const indices = [];
  let base = 0;
  for (let p = 0; p < planes; p++) {
    const ang = (p / planes) * Math.PI;          // 0..π (a plane and its back are the same quad, DoubleSide)
    const dx = Math.cos(ang), dz = Math.sin(ang);
    for (let i = 0; i <= segments; i++) {
      const v = i / segments;
      const y = clumpHeight * v;
      verts.push(-dx * clumpWidth * 0.5, y, -dz * clumpWidth * 0.5);
      verts.push( dx * clumpWidth * 0.5, y,  dz * clumpWidth * 0.5);
      uvs.push(0, v); uvs.push(1, v);
      normals.push(0, 1, 0); normals.push(0, 1, 0);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      indices.push(a, a + 2, a + 1);
      indices.push(a + 1, a + 2, a + 3);
    }
    base += (segments + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, clumpHeight * 0.5, 0), gridSide * cellSize);
  return g;
}

function buildGrassMaterial(uniforms, opts) {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    alphaTest: 0.32,        // opaque pass, no transparency sort (repo principle)
    transparent: false,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = TERRAIN_GLSL + `
      uniform float     uTime;
      uniform vec2      uPlayerCell;
      uniform sampler2D uNoiseTex;
      uniform float     uNoiseScale;
      uniform float     uWindAmp;
      uniform float     uWindFreq;
      uniform float     uWindSpeed;
      uniform float     uNoiseFactor;
      uniform float     uNoiseSpeed;
      varying vec2  vUv;
      varying vec2  vWorldUV;
      varying float vBladeY;
      const float gridSide = ${opts.gridSide.toFixed(1)};
      const float cellSize = ${opts.cellSize.toFixed(4)};

      vec2 hash22(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return fract(sin(p) * 43758.5453);
      }
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      // ── Which clump is this instance, and where in the world does it sit? ──
      float gInstance = float(gl_InstanceID);
      float gIx = mod(gInstance, gridSide);
      float gIz = floor(gInstance / gridSide);
      vec2 patchMod = mod(uPlayerCell, gridSide);
      vec2 wrap = mod(vec2(gIx, gIz) - patchMod + gridSide, gridSide);
      vec2 gWorldCell = uPlayerCell - vec2(gridSide * 0.5) + wrap;

      vec2 gH1 = hash22(gWorldCell);
      vec2 gH2 = hash22(gWorldCell + vec2(17.3, 91.7));
      float gRotY = gH1.x * 6.28318;
      vec2 gWorldXZ = gWorldCell * cellSize + (gH1 - 0.5) * cellSize;

      // Edge fade (collapse clump height inside the fog band) + per-clump height.
      float patchHalf = gridSide * 0.5;
      float gT = length(gWorldCell - uPlayerCell) / patchHalf;
      float gEdgeFade = 1.0 - smoothstep(${opts.edgeFadeStart.toFixed(3)}, 1.0, gT);
      float gScale = (0.7 + gH2.x * 0.6) * gEdgeFade;

      vUv = uv;
      vBladeY = uv.y;
      vWorldUV = gWorldXZ * uNoiseScale;

      vec3 gp = transformed;
      gp.y *= gScale;
      // random Y rotation per clump
      float gc = cos(gRotY), gs = sin(gRotY);
      vec3 grot = vec3(gc * gp.x - gs * gp.z, gp.y, gs * gp.x + gc * gp.z);

      // Wind: sine across the world, de-correlated by the noise texture, weighted
      // toward the blade tip (uv.y) so roots stay planted.
      vec2 windDir = normalize(vec2(1.0, 1.0));
      vec4 wnoise = texture2D(uNoiseTex, vWorldUV + uTime * uNoiseSpeed);
      float sinWave = sin(uWindFreq * dot(windDir, vWorldUV) + wnoise.g * uNoiseFactor
                          + uTime * uWindSpeed) * uWindAmp * uv.y;
      grot.x += sinWave;
      grot.z += sinWave;

      grot.x += gWorldXZ.x;
      grot.z += gWorldXZ.y;
      grot.y += terrainH(gWorldXZ);   // sit the clump on the terrain
      transformed = grot;
      `
    );

    shader.fragmentShader = `
      uniform sampler2D uGrassAlpha;
      uniform sampler2D uNoiseTex;
      uniform vec3 uBaseColor;
      uniform vec3 uTipColor1;
      uniform vec3 uTipColor2;
      uniform float uAoFloor;
      uniform float uTintVar;
      varying vec2  vUv;
      varying vec2  vWorldUV;
      varying float vBladeY;
    ` + shader.fragmentShader;

    // The clump is built from double-sided crossed planes. Three flips the
    // normal on back faces (faceDirection), so planes facing away from the sun
    // point "down", catch only the dark ground-hemisphere term, and render as
    // BLACK blades scattered through the field. Force the up-normal on both
    // faces — the grass then reads as a soft, evenly-lit carpet.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      normal = normalize(vNormal);`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      /* glsl */ `
      float gAlpha = texture2D(uGrassAlpha, vUv).r;

      vec4 gNoise = texture2D(uNoiseTex, vWorldUV);
      vec3 tipCol = mix(uTipColor1, uTipColor2, gNoise.r);
      vec3 grassCol = mix(uBaseColor, tipCol, vBladeY);

      // ── Green-gamut variation ──────────────────────────────────────────────
      // The field was one flat green. Sample the noise at a much LOWER frequency
      // (≈1 patch per dozen metres) so neighbouring clumps share a tint and it
      // drifts smoothly across the meadow, then nudge it within the green gamut:
      // a warm yellow-green on one end, a cooler deep green on the other. A pure
      // multiply keeps everything in-gamut (never tints blue/grey).
      float gVar = texture2D(uNoiseTex, vWorldUV * 0.07).b;
      vec3  warmGreen = vec3(1.08, 1.05, 0.82);   // sun-bleached, yellower
      vec3  coolGreen = vec3(0.84, 0.97, 0.90);   // shaded, deeper
      // uTintVar fades the tint toward neutral (winter snow-grass shouldn't go yellow).
      grassCol *= mix(vec3(1.0), mix(coolGreen, warmGreen, gVar), uTintVar);

      // Root ambient occlusion so the carpet has depth, brighter toward the tip.
      // uAoFloor lifts the root brightness — too low and the bases crush to black.
      grassCol *= mix(uAoFloor, 1.0, vBladeY);

      vec4 diffuseColor = vec4(grassCol, gAlpha);`
    );

    mat.userData.shader = shader;
  };
  return mat;
}

export function buildGrass(scene, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  opts.halfSize = opts.gridSide * opts.cellSize * 0.5;

  const geom = buildClumpGeometry(opts);

  // 1×1 black placeholder so nothing renders (alphaTest discards) until the real
  // alpha texture loads a frame or two later — avoids a flash of solid planes.
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;

  const uniforms = {
    uTime:        { value: 0 },
    uPlayerCell:  { value: new THREE.Vector2() },
    uGrassAlpha:  { value: black },
    uNoiseTex:    { value: black },
    uNoiseScale:  { value: 0.0035 },     // world→noise UV scale (large, smooth zones)
    uWindAmp:     { value: opts.windAmp },
    uWindFreq:    { value: 12.0 },
    uWindSpeed:   { value: 1.1 },
    uNoiseFactor: { value: 5.5 },
    uNoiseSpeed:  { value: 0.02 },
    uAoFloor:     { value: opts.aoFloor },
    uBaseColor:   { value: new THREE.Color(opts.baseColor) },
    uTipColor1:   { value: new THREE.Color(opts.tipColor1) },
    uTipColor2:   { value: new THREE.Color(opts.tipColor2) },
    uTintVar:     { value: 1.0 },   // green-gamut variation strength (0 in winter)
  };

  const mat = buildGrassMaterial(uniforms, opts);
  const total = opts.gridSide * opts.gridSide;
  const mesh = new THREE.InstancedMesh(geom, mat, total);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = total;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const id = new THREE.Matrix4();
  for (let i = 0; i < total; i++) mesh.setMatrixAt(i, id);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  applyWind(mat);

  // Async-load the two textures; assign when ready (the material reads the
  // uniform, so it lights up the moment the alpha arrives). `ready` resolves once
  // both are in, so the loader can hold the reveal until the grass is textured.
  const loader = new THREE.TextureLoader();
  const loadTex = (url, wrap, assign) => new Promise((res) => {
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.wrapS = tex.wrapT = wrap;
      assign(tex);
      res();
    }, undefined, res);            // resolve on error too, never hang the reveal
  });
  const ready = Promise.all([
    loadTex(ALPHA_URL, THREE.ClampToEdgeWrapping, (t) => { uniforms.uGrassAlpha.value = t; }),
    loadTex(NOISE_URL, THREE.RepeatWrapping,      (t) => { uniforms.uNoiseTex.value = t; }),
  ]);

  function update(camera) {
    uniforms.uPlayerCell.value.set(
      Math.floor(camera.position.x / opts.cellSize),
      Math.floor(camera.position.z / opts.cellSize)
    );
  }

  function setTime(_t) {}

  return { mesh, material: mat, uniforms, update, setTime, total, halfSize: opts.halfSize, ready };
}
