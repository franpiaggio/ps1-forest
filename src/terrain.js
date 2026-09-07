// Shared terrain height field. The SAME formula lives in JS (trees, grass
// placement, the player's feet, collision) and GLSL (the ground mesh + grass),
// so every system sits on exactly the same rolling hills. A few sine octaves —
// trivially identical across JS and GLSL, and smooth.

export function terrainHeight(x, z) {
  return 2.6 * Math.sin(0.021 * x) * Math.cos(0.018 * z)
       + 1.3 * Math.sin(0.052 * x + 0.041 * z)
       + 0.6 * Math.cos(0.090 * z - 0.070 * x);
}

// GLSL twin of terrainHeight + a finite-difference normal, injected into the
// ground and grass vertex shaders.
export const TERRAIN_GLSL = /* glsl */ `
  float terrainH(vec2 p) {
    return 2.6 * sin(0.021 * p.x) * cos(0.018 * p.y)
         + 1.3 * sin(0.052 * p.x + 0.041 * p.y)
         + 0.6 * cos(0.090 * p.y - 0.070 * p.x);
  }
  vec3 terrainNormal(vec2 p) {
    float e = 0.6;
    float hL = terrainH(p - vec2(e, 0.0));
    float hR = terrainH(p + vec2(e, 0.0));
    float hD = terrainH(p - vec2(0.0, e));
    float hU = terrainH(p + vec2(0.0, e));
    return normalize(vec3(hL - hR, 2.0 * e, hD - hU));
  }
`;
