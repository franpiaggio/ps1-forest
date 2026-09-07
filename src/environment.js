import * as THREE from 'three';
import { TERRAIN_GLSL } from './terrain.js';

// A flat XZ grid (size×size, segs×segs) that the shader displaces by the terrain
// height. It follows the camera, snapped to the vertex spacing so the verts land
// on a fixed world grid → the relief doesn't swim as the tile recentres.
function buildTerrainGrid(size, segs) {
  const verts = [], uvs = [], idx = [];
  const half = size / 2, step = size / segs;
  for (let j = 0; j <= segs; j++) {
    for (let i = 0; i <= segs; i++) {
      verts.push(-half + i * step, 0, -half + j * step);
      uvs.push(i, j);
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(verts.length), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);
  return { geom: g, step };
}

// Atmospheric sky. The old flat bright sky-blue (#c3d6ef) read as "white haze".
// Instead: a muted, slightly cool HORIZON haze (also the fog colour, so trees
// fade seamlessly into it) graduating up to a deeper ZENITH, plus a warm glow
// toward the sun. A vertical gradient + sun glow is what gives the scene depth
// and mood a single flat colour never can.
const HORIZON  = new THREE.Color(0xacb9c0);   // fog + sky at the horizon (muted)
const ZENITH   = new THREE.Color(0x586a78);   // deeper sky overhead
const SUN_GLOW = new THREE.Color(0xffe1ad);   // warm halo around the sun
const SKY = HORIZON;                            // fog matches the horizon band
// Sun at ~21° elevation so godray shafts rake horizontally between the trunks
// where the (horizon-level) camera actually looks.
export const SUN_DIR = new THREE.Vector3(0.55, 0.27, 0.42).normalize();

function makeGroundTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gridN = 16;
  const grid = new Float32Array(gridN * gridN);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
  const sample = (gx, gy) => {
    const x = ((gx % gridN) + gridN) % gridN;
    const y = ((gy % gridN) + gridN) % gridN;
    return grid[y * gridN + x];
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const fade = t => t * t * (3 - 2 * t);
  const fbm = (u, v) => {
    let amp = 0.55, sum = 0, freq = 1;
    for (let oct = 0; oct < 4; oct++) {
      const x = u * freq, y = v * freq;
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const a = sample(xi, yi),     b = sample(xi + 1, yi);
      const c = sample(xi, yi + 1), d = sample(xi + 1, yi + 1);
      const sx = fade(xf), sy = fade(yf);
      sum += amp * lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  };

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * gridN;
      const v = (y / size) * gridN;
      const greenN = fbm(u, v);
      const dirtN  = fbm(u + 53.3, v + 17.7);
      let r, g, b;
      if (greenN < 0.42)      { r =  58; g =  92; b =  40; }
      else if (greenN < 0.65) { r =  85; g = 125; b =  56; }
      else                    { r = 118; g = 158; b =  74; }
      if (dirtN > 0.78) {
        const t = (dirtN - 0.78) / 0.22;
        r = lerp(r, 116, t);
        g = lerp(g,  92, t);
        b = lerp(b,  62, t);
      }
      const j = (Math.random() - 0.5) * 18;
      const i = (y * size + x) * 4;
      d[i]     = Math.max(0, Math.min(255, r + j));
      d[i + 1] = Math.max(0, Math.min(255, g + j));
      d[i + 2] = Math.max(0, Math.min(255, b + j));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// A snow blanket for winter: a cool near-white with soft low-contrast drifts and
// faint sparkle, so the ground reads as fresh snow rather than green dirt tinted
// blue. Same fbm machinery as makeGroundTexture, different palette.
function makeSnowTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gridN = 16;
  const grid = new Float32Array(gridN * gridN);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
  const sample = (gx, gy) => grid[(((gy % gridN) + gridN) % gridN) * gridN + (((gx % gridN) + gridN) % gridN)];
  const lerp = (a, b, t) => a + (b - a) * t;
  const fade = t => t * t * (3 - 2 * t);
  const fbm = (u, v) => {
    let amp = 0.55, sum = 0, freq = 1;
    for (let oct = 0; oct < 4; oct++) {
      const x = u * freq, y = v * freq;
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const a = sample(xi, yi), b = sample(xi + 1, yi);
      const c = sample(xi, yi + 1), d = sample(xi + 1, yi + 1);
      sum += amp * lerp(lerp(a, b, fade(xf)), lerp(c, d, fade(xf)), fade(yf));
      amp *= 0.5; freq *= 2;
    }
    return sum;
  };

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * gridN, v = (y / size) * gridN;
      const n = fbm(u, v);                       // soft drifts
      // Cool white base; hollows (low n) go faintly blue-grey, crests stay bright.
      let r = lerp(222, 246, n);
      let g = lerp(230, 250, n);
      let b = lerp(238, 255, n);
      // Faint sparkle: rare near-white specks.
      if (Math.random() > 0.992) { r = 255; g = 255; b = 255; }
      const j = (Math.random() - 0.5) * 6;       // subtle grain (snow is low-contrast)
      const i = (y * size + x) * 4;
      d[i]     = Math.max(0, Math.min(255, r + j));
      d[i + 1] = Math.max(0, Math.min(255, g + j));
      d[i + 2] = Math.max(0, Math.min(255, b + j));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// In v06 the sun ALWAYS casts shadow because the godrays pass raymarches the
// shadow map. Disabling shadows would disable the godrays entirely. Tier only
// scales the map size and whether the ground receives shadow on its surface.
export function buildEnvironment(scene, renderer, preset) {
  scene.background = HORIZON;
  scene.fog = new THREE.Fog(SKY, preset.fogNear, preset.fogFar);

  // ── Gradient sky dome (atmosphere) ──────────────────────────────────────────
  // A large inward-facing sphere, NOT fogged, that follows the camera. Trees and
  // ground fog out to HORIZON, which is exactly the dome's horizon colour, so
  // there's no seam; above the horizon the dome darkens toward ZENITH and warms
  // toward the sun. One cheap draw call — runs even on the Low tier.
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uHorizon: { value: HORIZON },
      uZenith:  { value: ZENITH },
      uSunGlow: { value: SUN_GLOW },
      uSunDir:  { value: SUN_DIR.clone() },
      uTime:    { value: 0 },
      uCloud:   { value: 0.5 },   // coverage 0..1
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 uHorizon, uZenith, uSunGlow, uSunDir;
      uniform float uTime, uCloud;

      float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i), b = hash21(i + vec2(1,0)), c = hash21(i + vec2(0,1)), d = hash21(i + vec2(1,1));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.0; a *= 0.5; } return v; }
      // 4x4 Bayer to dither ONLY the sky gradient — breaks the PS1 quantiser's
      // banding on the smooth sky without touching the (textured) trees.
      float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
      float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }

      void main() {
        vec3 vd = normalize(vDir);
        float up = clamp(vd.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, up));
        float s = max(dot(vd, normalize(uSunDir)), 0.0);
        float glow = pow(s, 6.0) * 0.55 + pow(s, 90.0) * 0.5;   // soft halo + tighter core

        // ── Painted drifting clouds (skybox-style; the dither bands them PSX) ──
        float skyMask = smoothstep(0.03, 0.42, vd.y);            // only above the horizon
        vec2 cuv = vd.xz / (vd.y + 0.35) * 1.5 + uTime * 0.012;  // planar sky projection + slow drift
        float n = fbm(cuv) * 0.62 + fbm(cuv * 2.3 + 7.0) * 0.38; // two layers for shape
        float cov = mix(0.66, 0.34, clamp(uCloud, 0.0, 1.0));    // higher uCloud → more cloud
        float cloud = smoothstep(cov, cov + 0.20, n) * skyMask;
        cloud *= 1.0 - glow * 0.6;                               // let the sun core punch through
        vec3 cloudCol = mix(vec3(0.80, 0.84, 0.88), uSunGlow, glow * 0.7);

        col = mix(col, uSunGlow, clamp(glow, 0.0, 0.85) * (1.0 - up * 0.5));
        col = mix(col, cloudCol, cloud * 0.85);
        // Pre-dither by ~1 quantisation step so the global 56-level quantiser
        // doesn't band the smooth sky into contour rings.
        col += (bayer4(gl_FragCoord.xy) - 0.5) * (1.0 / 56.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const skydome = new THREE.Mesh(new THREE.SphereGeometry(160, 24, 16), skyMat);
  skydome.frustumCulled = false;
  skydome.renderOrder = -1;
  scene.add(skydome);

  // Slightly cooler / dimmer ambient so the warm directional light + godrays
  // read as the dominant illumination source.
  const hemi = new THREE.HemisphereLight(0xd2e5ff, 0x3a2a18, 0.78);
  scene.add(hemi);

  // Warmer + a touch stronger than v06 to sell the low-sun, late-afternoon read
  // that the lowered SUN_DIR implies.
  const sun = new THREE.DirectionalLight(0xffe2b8, 1.7);
  // Low tier disables shadows entirely (no godrays there to need them) — that
  // skips the per-frame shadow-map render, the biggest cost on weak GPUs.
  sun.castShadow = preset.shadowsEnabled !== false;
  sun.shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  // Ortho frustum covers the camera's visible area + a margin so trees just
  // outside the frame still occlude rays.
  const c = sun.shadow.camera;
  c.left = -28; c.right = 28; c.top = 28; c.bottom = -28;
  c.near = 1; c.far = 90;
  c.updateProjectionMatrix();
  sun.target = new THREE.Object3D();
  scene.add(sun);
  scene.add(sun.target);

  const groundMap = makeGroundTexture(512);
  groundMap.repeat.set(200, 200);
  if (renderer?.capabilities?.getMaxAnisotropy) {
    groundMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  groundMap.wrapS = groundMap.wrapT = THREE.RepeatWrapping;
  const snowMap = makeSnowTexture(512);
  if (renderer?.capabilities?.getMaxAnisotropy) {
    snowMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  const groundMat = new THREE.MeshStandardMaterial({
    map: groundMap, color: 0xffffff, roughness: 0.95, metalness: 0.0,
  });
  // Snow blend amount (0 = grass/dirt, 1 = snow). Shared object so setPalette can
  // flip it whether or not the shader has compiled yet.
  groundMat.userData.uSnow = { value: 0 };
  groundMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundUvScale = { value: 0.1 };  // 1 texture tile per 10 m
    shader.uniforms.uSnowTex = { value: snowMap };
    shader.uniforms.uSnow = groundMat.userData.uSnow;
    // ── vertex: displace by the terrain height, normal from the height field ──
    shader.vertexShader = TERRAIN_GLSL + 'varying vec2 vWXZ;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
       vec3 _wn = (modelMatrix * vec4(position, 1.0)).xyz;
       objectNormal = terrainNormal(_wn.xz);`
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vec3 _wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
       vWXZ = _wp.xz;
       transformed.y += terrainH(_wp.xz);`
    );
    // ── fragment: world-anchored texture UV so it doesn't swim as the tile moves.
    // In winter mix toward the snow blanket (tiled larger, ×0.5, so it reads as a
    // smooth sheet rather than busy noise). ──
    shader.fragmentShader = 'uniform float uGroundUvScale;\nuniform float uSnow;\nuniform sampler2D uSnowTex;\nvarying vec2 vWXZ;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `vec3 _grnd = texture2D(map, vWXZ * uGroundUvScale).rgb;
       vec3 _snow = texture2D(uSnowTex, vWXZ * uGroundUvScale * 0.5).rgb;
       diffuseColor.rgb *= mix(_grnd, _snow, uSnow);`
    );
  };

  const { geom: terrainGeom, step: terrainStep } = buildTerrainGrid(320, 160);
  const ground = new THREE.Mesh(terrainGeom, groundMat);
  ground.frustumCulled = false;
  ground.receiveShadow = !!preset.groundReceiveShadow;
  ground.castShadow = false;
  scene.add(ground);

  function updateSun(playerPos) {
    const offset = SUN_DIR.clone().multiplyScalar(40);
    sun.position.copy(playerPos).add(offset);
    sun.target.position.copy(playerPos);
    sun.target.updateMatrixWorld();
    skydome.position.copy(playerPos);     // keep the sky centred on the player
    // Recentre the terrain tile on the player, snapped to the vertex spacing so
    // the verts stay on a fixed world grid (no swimming relief).
    ground.position.set(
      Math.round(playerPos.x / terrainStep) * terrainStep, 0,
      Math.round(playerPos.z / terrainStep) * terrainStep,
    );
  }

  // Re-tint the whole atmosphere for a season (sky dome, fog, sun, hemisphere).
  function setPalette(s) {
    if (s.horizon) { skyMat.uniforms.uHorizon.value.set(s.horizon); scene.fog.color.set(s.horizon); if (scene.background?.set) scene.background.set(s.horizon); }
    if (s.zenith)  skyMat.uniforms.uZenith.value.set(s.zenith);
    if (s.sunGlow) skyMat.uniforms.uSunGlow.value.set(s.sunGlow);
    if (s.sun)     sun.color.set(s.sun);
    if (s.sunInt != null) sun.intensity = s.sunInt;
    if (s.hemiSky) hemi.color.set(s.hemiSky);
    if (s.hemiGround) hemi.groundColor.set(s.hemiGround);
    if (s.hemiInt != null) hemi.intensity = s.hemiInt;
    groundMat.userData.uSnow.value = s.snow ? 1 : 0;   // winter → snow blanket
  }

  function setTime(t) { skyMat.uniforms.uTime.value = t; }
  function setCloud(v) { skyMat.uniforms.uCloud.value = v; }

  return { sun, hemi, ground, skydome, updateSun, setPalette, setTime, setCloud, skyColor: SKY, sunDir: SUN_DIR };
}
