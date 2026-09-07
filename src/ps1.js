// PlayStation-1 look toolkit (tasteful, not exaggerated).
//
//   • Vertex snap — PS1 had no sub-pixel vertex precision, so vertices jumped to
//     the screen pixel grid → the classic "wobble" as things move. We snap
//     clip-space XY to the LOW-RES buffer's pixel grid in every patched material.
//   • Nearest textures — no bilinear filtering, no mipmaps → chunky texels that
//     crawl (no smooth LOD fade).
//   • 15-bit colour + ordered dither — PS1 output 5 bits/channel (32 levels) and
//     dithered to fake more depth. A 4×4 Bayer dither gives the signature grain.
//
// The internal resolution (the pixelation) is set in main.js by sizing the
// renderer/composer small and letting CSS upscale nearest-neighbour. Affine
// texture warping is intentionally NOT forced here: it's the most "burdo" PS1
// artifact and WebGL1 can't do true non-perspective varyings cleanly — the vertex
// snap + low res already gives a tasteful amount of texture swim.

import * as THREE from 'three';
import { Effect } from 'postprocessing';

// Shared uniforms so the GUI drives every patched material at once. uSnap is the
// half-size (in pixels) of the internal buffer, so vertices land exactly on its
// pixel grid; main.js keeps it in sync with the render size.
export const ps1Uniforms = {
  uSnap: { value: new THREE.Vector2(213, 160) },   // ≈ 426×320 internal buffer
};

// Wrap a material's onBeforeCompile to snap gl_Position to the pixel grid. Chains
// any existing onBeforeCompile (wind, instancing, terrain, …). Call BEFORE the
// first compile.
export function applyVertexSnap(material) {
  if (!material || material.userData?.__ps1) return;
  material.userData = material.userData || {};
  material.userData.__ps1 = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    shader.uniforms.uSnap = ps1Uniforms.uSnap;
    if (!shader.vertexShader.includes('uniform vec2 uSnap;')) {
      shader.vertexShader = 'uniform vec2 uSnap;\n' + shader.vertexShader;
    }
    const SNAP = /* glsl */`$&
      // Only snap in front of the camera. For vertices at/behind the near plane
      // (w <= 0) the perspective divide explodes and stretches triangles across
      // the screen — the classic naive-snap artifact.
      if (gl_Position.w > 0.0) {
        vec4 _ps1 = gl_Position;
        _ps1.xyz /= _ps1.w;                          // → NDC
        _ps1.xy = floor(_ps1.xy * uSnap) / uSnap;    // snap to the pixel grid
        _ps1.xyz *= _ps1.w;                          // → clip
        gl_Position = _ps1;
      }`;
    // Most materials still have the include; ez-tree's leaf material has already
    // EXPANDED project_vertex, so fall back to the raw gl_Position line.
    let v = shader.vertexShader;
    if (v.includes('#include <project_vertex>')) {
      v = v.replace('#include <project_vertex>', SNAP);
    } else if (v.includes('gl_Position = projectionMatrix * mvPosition;')) {
      v = v.replace('gl_Position = projectionMatrix * mvPosition;', SNAP);
    }
    shader.vertexShader = v;
    material.userData.shader = shader;   // keep wind's reference valid
  };
  material.needsUpdate = true;
}

// Nearest magnification → chunky texels up close (the PS1 crunch), but KEEP
// mipmaps for minification so distant alpha foliage doesn't shimmer/flicker
// (true PS1 had no mipmaps, but our hi-res-source + downscale aliases far worse,
// reading as "buggy" rather than retro).
export function makeNearest(tex) {
  if (!tex) return tex;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ── 15-bit quantise + 4×4 Bayer ordered dither (postprocessing Effect) ───────
const PS1_FRAG = /* glsl */`
uniform float uLevels;
uniform float uDither;

// Compact 4×4 Bayer, returns 0..1.
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Dither amplitude is one quantisation step, so it nudges values across colour
  // bands without adding visible noise on flat areas.
  float d = (bayer4(gl_FragCoord.xy) - 0.5) * uDither;
  vec3 c = floor(inputColor.rgb * uLevels + 0.5 + d) / uLevels;
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}`;

export class PS1Effect extends Effect {
  // 32 levels = true 5-bit-per-channel (15-bit colour). dither ~0.8 is a gentle,
  // tasteful grain rather than the heavy shimmer of a full-step dither.
  constructor({ levels = 56, dither = 0 } = {}) {
    super('PS1Effect', PS1_FRAG, {
      uniforms: new Map([
        ['uLevels', new THREE.Uniform(levels)],
        ['uDither', new THREE.Uniform(dither)],
      ]),
    });
  }
  get levels() { return this.uniforms.get('uLevels').value; }
  set levels(v) { this.uniforms.get('uLevels').value = v; }
  get dither() { return this.uniforms.get('uDither').value; }
  set dither(v) { this.uniforms.get('uDither').value = v; }
}
