// Drives `uTime` (and the other EZ-Tree wind uniforms) on every material we
// register. Same shape as 01-ez-tree-baseline/wind.js — the leaf shader EZ-Tree
// injects already declares uTime/uWindStrength/uWindFrequency/uWindScale, so we
// only need to update them per frame.

import * as THREE from 'three';

const tracked = new Set();

export const wind = {
  strength: new THREE.Vector3(0.45, 0, 0.45),
  frequency: 0.45,
  scale: 70,
};

export function applyWind(material) {
  if (!material) return;
  const existing = material.userData?.shader;
  if (existing?.uniforms?.uTime) {
    tracked.add(existing);
    return;
  }
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    material.userData.shader = shader;
    tracked.add(shader);
  };
  material.needsUpdate = true;
}

export function updateWind(time) {
  for (const shader of tracked) {
    const u = shader.uniforms;
    if (u.uTime) u.uTime.value = time;
    if (u.uWindStrength) u.uWindStrength.value.copy(wind.strength);
    if (u.uWindFrequency) u.uWindFrequency.value = wind.frequency;
    if (u.uWindScale) u.uWindScale.value = wind.scale;
  }
}
