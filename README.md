# PS1 Forest

A first-person walk through an endless procedural forest, rendered like it's 1997.

**[Open the demo →](https://franpiaggio.github.io/ps1-forest/)**

The forest itself is modern: trees grown procedurally with [ez-tree](https://github.com/dgreenheck/ez-tree), instanced foliage, a field of alpha-textured grass streamed as one instanced mesh, rolling terrain, four seasons, wind. Then the whole thing gets pushed through a PlayStation-1 pipeline — vertex snapping, 15-bit colour, a low-res buffer upscaled with nearest-neighbour — and the modern post-processing stack is thrown away.

The goal was a *tasteful* PS1, not a parody of one. The console's look came from hardware limits, and copying every limit at once gives you something unreadable. So some of them are reproduced faithfully and some are deliberately softened; the notes below say which, and why.

## Running it

```bash
npm install
npm run dev      # http://localhost:5188
```

`npm run build` writes a static bundle to `dist/`. Pushing to `main` deploys it to GitHub Pages via `.github/workflows/deploy.yml`.

## Controls

**Desktop** — `WASD` to move, mouse (or arrow keys) to look, `Shift` to sprint, `R` to re-roll the world, `Esc` back to the menu. The `lil-gui` panel on the right has a **PS1** folder with live sliders for internal resolution, vertex jitter, colour levels and dither — that's the fastest way to see what each trick actually does.

**Mobile** — joystick bottom-left, drag the right half to look, optional gyroscope on top of that.

Before you start, the splash screen picks a graphics tier (auto-detected from cores and memory) and **Forest config** opens a form for density, species mix, terrain and season, plus a dice button for a new world seed.

**Demo** is a hands-off camera: four looping GSAP timelines layer a meandering heading, a slow speed inhale/exhale, a buoyant bob with the occasional crane shot above the canopy, and a gaze that pans independently of travel. It's the mode to leave running on a second monitor.

Adding `#record` to the URL captures the canvas plus live audio to a `.webm` — `#record?w=1080&h=1920&secs=30` for a vertical clip.

## How the PS1 look is built

Everything lives in [`src/ps1.js`](src/ps1.js), about a hundred lines.

**Vertex snapping.** The PS1's GTE had no sub-pixel vertex precision, so vertices landed on whole pixels and geometry visibly wobbled as the camera moved. `applyVertexSnap` chains onto a material's `onBeforeCompile` and rounds clip-space XY to the internal buffer's pixel grid. The one non-obvious part: vertices at or behind the near plane (`w <= 0`) blow up under the perspective divide and stretch triangles across the screen, so those are left alone. Leaves opt out of snapping entirely — snapping dense alpha cards makes them flicker rather than wobble.

**Low internal resolution.** The scene renders into a ~360px-tall buffer that CSS upscales with nearest-neighbour. That's also what drives the snap grid, so the wobble scales with the pixelation instead of fighting it.

**Nearest textures, but keep mipmaps.** Nearest magnification gives the chunky texels up close. True PS1 hardware had no mipmaps at all, but our source textures are high-res, and minifying them without mips makes distant foliage shimmer in a way that reads as a bug, not as retro. So: nearest magnification, mipmapped minification.

**15-bit colour with an ordered dither.** The console output 5 bits per channel and dithered to hide the banding. A 4×4 Bayer matrix at one quantisation step of amplitude gives the signature grain without turning flat surfaces into noise.

**What was removed.** Godrays, bloom, depth of field, SMAA and chromatic aberration are all switched off, and tone mapping drops to linear with lowered exposure. They're beautiful and they're from the wrong decade.

**What was skipped on purpose.** Affine texture warping — the swimming-texture artifact everyone associates with the console — is the most conspicuous PS1 tell, and WebGL can't produce true non-perspective varyings cleanly. The snapping plus the low resolution already gives enough swim.

## Everything underneath

| File | What it does |
| --- | --- |
| `chunk.js` | Deterministic forest chunks. `(cx, cz, seed)` hashed through mulberry32 always yields the same trees, so walking back is free. |
| `world.js` / `tree-templates.js` | A small pool of pre-grown tree meshes, scattered as instances. |
| `grass.js` | One `InstancedMesh` of crossed alpha-textured cards — up to ~58k clumps — that follows the player, noise-driven for wind, height and colour. |
| `terrain.js` | A height field shared between JS and GLSL, so ground, trees, grass and player all agree on where the hills are. |
| `seasons.js` | Per-leaf recolouring that preserves luminance, plus falling leaves, snow or petals. Pines stay green. |
| `quality.js` | Three tiers (shadow map size, DPR, view distance, grass field radius, leaf reduction), auto-detected and overridable. |
| `demo.js` | The hands-off camera. |
| `recorder.js` | `#record` clip capture. |

## Credits

The trees come from Daniel Greenheck's [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT), and this project started from his Codrops article [Fractals to Forests](https://tympanus.net/codrops/2025/01/27/fractals-to-forests-creating-realistic-3d-trees-with-three-js/).

The grass technique — crossed alpha cards with a base-to-tip gradient and noise-driven wind — is adapted from [FluffyGrass](https://github.com/thebenezer/FluffyGrass) by Ebenezer (MIT), along with its blade and noise textures.

Bark and leaf textures are editable copies extracted from ez-tree; their original photo sources are listed in [`src/assets/trees/CREDITS.txt`](src/assets/trees/CREDITS.txt).

Built with [Three.js](https://threejs.org/), [postprocessing](https://github.com/pmndrs/postprocessing), [three-good-godrays](https://github.com/Ameobea/three-good-godrays), GSAP, lil-gui and nipplejs.

## License

MIT — see [LICENSE](LICENSE).
