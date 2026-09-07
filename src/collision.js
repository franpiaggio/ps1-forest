// Cylinder-vs-cylinder collision in the XZ plane. The player is a fixed-radius
// cylinder; every tree's trunk is one too. We push the player out of each tree
// it overlaps until it's free — slides naturally along trunks.

export function resolveCollisions(nextX, nextZ, playerRadius, trees) {
  // Two iterations are enough for the worst case "wedged between two trees"
  // scenario; with one we'd sometimes slide a few mm into the second.
  let x = nextX, z = nextZ;
  const collisions = [];
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    for (const t of trees) {
      const dx = x - t.x;
      const dz = z - t.z;
      const min = playerRadius + t.colRadius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (min - d) / d;
        const pushX = dx * push;
        const pushZ = dz * push;
        collisions.push({
          treeX: t.x,
          treeZ: t.z,
          playerX: x,
          playerZ: z,
          pushX,
          pushZ,
        });
        x += pushX;
        z += pushZ;
        any = true;
      }
    }
    if (!any) break;
  }
  return { pos: [x, z], collisions };
}
