// PS1-style sun shafts. NOT volumetric godrays (the console couldn't) — the
// period faked light beams with flat additive textured polygons. Each shaft is a
// pair of CROSSED quads (perpendicular, sharing the sun-direction axis), additively
// blended with a soft beam texture. Crossed planes mean there's always a face
// toward the viewer, so the beams never wink out edge-on and never need a
// camera-billboard (which made them spin as you moved). They're parked far toward
// the sun and world-wrapped, so they read as distant rays you walk past, and the
// PS1 dither/low-res bands them into stepped, soft shafts.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const _smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function makeShaftTexture(w = 32, h = 192) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);                       // 0 = sun end (top), 1 = bottom
    const topBias = 0.6 + 0.4 * (1 - v);
    const fade = _smooth(0, 0.34, v) * _smooth(0, 0.42, 1 - v);   // very soft at both ends
    const along = topBias * fade;
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1) - 0.5;
      const across = Math.exp(-(u * 1.9) * (u * 1.9));   // wide, diffuse across width
      const a = Math.max(0, along * across);
      const i = (y * w + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildSunShafts(scene, sunDir, {
  count = 5, length = 32, width = 4.2, color = 0xffe7c2, opacity = 0.14,
} = {}) {
  const tex = makeShaftTexture();
  const baseMat = new THREE.MeshBasicMaterial({
    map: tex, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  let baseOpacity = opacity;
  const geo = new THREE.PlaneGeometry(width, length);

  const up = sunDir.clone().normalize();                                 // beam long axis (toward sun)
  const sunAz = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();     // sun on the ground plane
  const nA = new THREE.Vector3(-sunAz.z, 0, sunAz.x).normalize();         // one ⟂ axis (horizontal)
  const nB = new THREE.Vector3().crossVectors(up, nA).normalize();        // the other ⟂ axis
  // The two crossed quads: plane A faces nA, plane B faces nB (both contain `up`).

  const BOX = 56;          // world wrap cell (large → re-snaps happen far away)
  const BIAS = 30;         // park them well toward the sun, in the distance

  const shafts = [], seeds = [];
  const mk = (m) => { const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.renderOrder = 3; scene.add(mesh); return mesh; };
  for (let i = 0; i < count; i++) {
    const m = baseMat.clone();   // own material so we can fade each shaft independently
    shafts.push({ a: mk(m), b: mk(m), mat: m });
    seeds.push({ sx: Math.random(), sz: Math.random(), hgt: 9 + Math.random() * 10 });
  }

  const _c = new THREE.Vector3();
  function place(mesh, x, up3, z3, center) { mesh.matrix.makeBasis(x, up3, z3); mesh.matrix.setPosition(center); mesh.matrixWorldNeedsUpdate = true; }

  function update(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    const bcx = cx + sunAz.x * BIAS, bcz = cz + sunAz.z * BIAS;
    for (let i = 0; i < shafts.length; i++) {
      const s = seeds[i];
      const px = s.sx * BOX, pz = s.sz * BOX;
      const ax = px + BOX * Math.floor((bcx - px) / BOX + 0.5);
      const az = pz + BOX * Math.floor((bcz - pz) / BOX + 0.5);
      _c.set(ax, terrainHeight(ax, az) + s.hgt, az);
      // Fade toward the cell edge so the re-snap happens while invisible (no pop).
      const rel = Math.hypot(ax - bcx, az - bcz);
      shafts[i].mat.opacity = baseOpacity * (1 - _smooth(BOX * 0.34, BOX * 0.5, rel));
      place(shafts[i].a, nB, up, nA, _c);   // plane A (normal = nA)
      place(shafts[i].b, nA, up, nB, _c);   // plane B (normal = nB)
    }
  }

  function setOpacity(v) { baseOpacity = v; }
  function dispose() {
    for (const s of shafts) { scene.remove(s.a); scene.remove(s.b); s.mat.dispose(); }
    geo.dispose(); baseMat.dispose(); tex.dispose();
  }

  return { update, setOpacity, dispose };
}
