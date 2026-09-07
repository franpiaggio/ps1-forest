# PS1 Forest

A photo hunt in an endless procedural forest, rendered like it's 1997.

**[Play it →](https://franpiaggio.github.io/ps1-forest/)**

You get a shot list and a roll of five frames. Five briefs — "a large oak, up close", "three aspens in one frame", "a giant" — one photo each. The fog hides everything past thirty metres, so you find your subject by walking, frame it in the viewfinder, and shoot. Every photo turns the season behind a cut to black, so a full roll walks you through a year. At the end you get a contact sheet of your five photos, scored and graded, that you can save.

The forest itself is modern: trees grown procedurally with [ez-tree](https://github.com/dgreenheck/ez-tree), instanced foliage, a field of alpha-textured grass streamed as one instanced mesh, rolling terrain, four seasons, wind. Then the whole thing gets pushed through a PlayStation-1 pipeline — vertex snapping, 15-bit colour, a low-res buffer upscaled with nearest-neighbour — and the modern post-processing stack is thrown away.

The goal was a *tasteful* PS1, not a parody of one. The console's look came from hardware limits, and copying every limit at once gives you something unreadable. So some of them are reproduced faithfully and some are deliberately softened; the notes below say which, and why.

## Running it

```bash
npm install
npm run dev      # http://localhost:5188
```

`npm run build` writes a static bundle to `dist/`. Pushing to `main` deploys it to GitHub Pages via `.github/workflows/deploy.yml`.

## Controls

**Desktop** — `WASD` to move, mouse (or arrow keys) to look, `Shift` to sprint, `Space` or click to shoot. In Walk mode `R` re-rolls the world. The `lil-gui` panel on the right has a **PS1** folder with live sliders for internal resolution, vertex jitter, colour levels and dither — that's the fastest way to see what each trick actually does.

**Mobile** — joystick bottom-left, drag the right half to look, optional gyroscope on top of that, big shutter button bottom-centre.

Before you start, the splash screen picks a graphics tier (auto-detected from cores and memory) and **Forest config** opens a form for density, species mix, terrain and season, plus a dice button for a new world seed. The same seed always produces the same forest and the same shot list.

## How a photo is graded

There's no image recognition and no hand-placed targets. The game already knows every tree the world streamed in — species, size, position, whether it's one of the rare giants — so when you press the shutter it projects each nearby tree onto the screen and scores the frame out of 1000:

- **Composition, up to 500.** The best tree in the box: how much of the frame it fills, how centred it is, whether a nearer trunk stands across it.
- **The brief, up to 400.** A bonus, not a requirement. "An oak, up close" pays for the oak and again for getting close; "three aspens in one frame" pays per aspen and extra if they're spread across the frame rather than stacked; "a giant" pays for finding one at all.
- **The scene, up to 100.** More species in one frame, a giant somewhere in it.

Any photo with a tree in it counts and turns the season. Only an empty frame is refused, and it costs nothing. The chips on the review card say what the brief paid for and what it didn't; the grade runs D to S, and S means you got everything.

After forty seconds without a shot, a small compass points toward the nearest tree that fits the current brief. It's there so a run can't dead-end in a grove of the wrong species; it doesn't tell you how to frame it.

The photo itself is the PS1 buffer read straight off the canvas, so it's a real 640×360 pixelated frame, not a re-render. `Walk` and `Demo` are still there for wandering without a list.

## Everything underneath

| File | What it does |
| --- | --- |
| `chunk.js` | Deterministic forest chunks. `(cx, cz, seed)` hashed through mulberry32 always yields the same trees, so walking back is free. |
| `world.js` / `tree-templates.js` | A small pool of pre-grown tree meshes, scattered as instances. |
| `grass.js` | One `InstancedMesh` of crossed alpha-textured cards — up to ~58k clumps — that follows the player, noise-driven for wind, height and colour. |
| `terrain.js` | A height field shared between JS and GLSL, so ground, trees, grass and player all agree on where the hills are. |
| `seasons.js` | Per-leaf recolouring that preserves luminance, plus falling leaves, snow or petals. Pines stay green. |
| `quality.js` | Three tiers (shadow map size, DPR, view distance, grass field radius, leaf reduction), auto-detected and overridable. |
| `photo.js` | The photo hunt: shot list, framing score, film, season progression, HUD, end-of-roll contact sheet. |
| `demo.js` | The hands-off camera. |
| `recorder.js` | `#record` clip capture. |

## Credits

The trees come from Daniel Greenheck's [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT), and this project started from his Codrops article [Fractals to Forests](https://tympanus.net/codrops/2025/01/27/fractals-to-forests-creating-realistic-3d-trees-with-three-js/).

The grass technique — crossed alpha cards with a base-to-tip gradient and noise-driven wind — is adapted from [FluffyGrass](https://github.com/thebenezer/FluffyGrass) by Ebenezer (MIT), along with its blade and noise textures.

Bark and leaf textures are editable copies extracted from ez-tree; their original photo sources are listed in [`src/assets/trees/CREDITS.txt`](src/assets/trees/CREDITS.txt).

Built with [Three.js](https://threejs.org/), [postprocessing](https://github.com/pmndrs/postprocessing), [three-good-godrays](https://github.com/Ameobea/three-good-godrays), GSAP, lil-gui and nipplejs.

## License

MIT — see [LICENSE](LICENSE).
