// Atmospheric dust motes — world-space particles drifting in the air.
// COUNT is tier-driven so low-end devices don't pay the texture-sampling
// cost on so many overlapping additive points.

import * as THREE from 'three';

const FADE_NEAR = 4.0;
const FADE_FAR  = 11.0;
const DESPAWN_R = 16.0;
const DRIFT_AMP = 0.55;
const RESPAWN_PER_FRAME = 3;

const vert = /* glsl */ `
  attribute vec2 aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform vec3  uCamera;
  varying float vOpacity;

  void main() {
    vec3 drift = vec3(
      ${DRIFT_AMP.toFixed(2)} * sin(uTime * 0.22 + aSeed.x * 6.2832),
      ${(DRIFT_AMP * 0.55).toFixed(2)} * cos(uTime * 0.17 + aSeed.y * 6.2832),
      ${DRIFT_AMP.toFixed(2)} * cos(uTime * 0.19 + (aSeed.x + aSeed.y) * 3.1416)
    );
    vec3 worldPos = position + drift;

    float d = distance(worldPos, uCamera);
    vOpacity = 1.0 - smoothstep(${FADE_NEAR.toFixed(2)}, ${FADE_FAR.toFixed(2)}, d);

    vec4 mvPos = viewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float dist = -mvPos.z;
    gl_PointSize = uSize * (30.0 / max(dist, 0.8));
  }
`;

const frag = /* glsl */ `
  uniform float uOpacity;
  varying float vOpacity;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = (1.0 - smoothstep(0.15, 0.5, d)) * vOpacity * uOpacity;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(1.0, 0.97, 0.86, alpha);
  }
`;

function spawnOnShell(positions, i, cx, cy, cz, radius) {
  const theta = Math.random() * Math.PI * 2;
  const phi   = Math.acos(2 * Math.random() - 1);
  positions[i * 3]     = cx + radius * Math.sin(phi) * Math.cos(theta);
  positions[i * 3 + 1] = cy + radius * Math.sin(phi) * Math.sin(theta) - 0.3;
  positions[i * 3 + 2] = cz + radius * Math.cos(phi);
}

export function buildDust(scene, { count = 200 } = {}) {
  // Defensive: count = 0 returns a no-op handle (low tier could disable).
  if (count <= 0) {
    return { update: () => {} };
  }

  const positions = new Float32Array(count * 3);
  const seeds     = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const r = Math.cbrt(Math.random()) * FADE_FAR;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) + 1.2;
    positions[i * 3 + 2] = r * Math.cos(phi);
    seeds[i * 2]     = Math.random() * 100;
    seeds[i * 2 + 1] = Math.random() * 100;
  }

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('aSeed',    new THREE.BufferAttribute(seeds, 2));

  const mat = new THREE.ShaderMaterial({
    vertexShader:   vert,
    fragmentShader: frag,
    uniforms: {
      uTime:    { value: 0 },
      uSize:    { value: 0.9 },
      uOpacity: { value: 0.22 },
      uCamera:  { value: new THREE.Vector3() },
    },
    transparent:  true,
    depthWrite:   false,
    blending:     THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  scene.add(points);

  let scanCursor = 0;

  function update(camera, t) {
    mat.uniforms.uTime.value = t;
    mat.uniforms.uCamera.value.copy(camera.position);

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const despawnSq = DESPAWN_R * DESPAWN_R;

    let respawned = 0;
    const stride = Math.max(1, Math.ceil(count / 90));
    for (let k = 0; k < stride && respawned < RESPAWN_PER_FRAME; k++) {
      const i = scanCursor;
      scanCursor = (scanCursor + 1) % count;
      const dx = positions[i * 3]     - cx;
      const dy = positions[i * 3 + 1] - cy;
      const dz = positions[i * 3 + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > despawnSq) {
        spawnOnShell(positions, i, cx, cy, cz, FADE_FAR);
        respawned++;
      }
    }
    if (respawned > 0) posAttr.needsUpdate = true;
  }

  return { update };
}
