# PS1 Forest

A photo hunt in an endless procedural forest, rendered like it's 1997.

**[Play it →](https://franpiaggio.github.io/ps1-forest/)**

Eight frames, no brief. You walk, you frame, you shoot; the camera looks at what you framed and pays for what it finds. A close-up, the canopy, the sun through the trees, a grove of one species, one of the rare giants, leaves coming down. It pays less for something it has already seen on this roll, so the eight frames want to be eight different pictures. Every two photos the scene turns behind a cut to black. At the end you get a contact sheet, scored and graded, and you can save the sheet or any single photo.

## Running it

```bash
npm install
npm run dev      # http://localhost:5188
```

`npm run build` writes a static bundle to `dist/`. Pushing to `main` deploys it to GitHub Pages via `.github/workflows/deploy.yml`.

## Controls

**Desktop** — `WASD` to move, mouse (or arrow keys) to look, `Shift` to sprint, `Space` or click to shoot. In Walk mode `R` re-rolls the world. The `lil-gui` panel on the right has a **PS1** folder with live sliders for internal resolution, vertex jitter, colour levels and dither — that's the fastest way to see what each trick actually does.

**Mobile** — joystick bottom-left, drag the right half to look, optional gyroscope on top of that, big shutter button bottom-centre.

Before you start, the splash screen picks a graphics tier (auto-detected from cores and memory) and **Forest config** opens a form for density, species mix, terrain and season, plus a dice button for a new world seed. The same seed always produces the same forest.

## How a photo is graded

There's no image recognition and no hand-placed targets. The game already knows every tree the world streamed in — species, size, position, whether it's a giant — plus the camera's pitch, the angle to the sun and the current season. When you press the shutter it projects the nearby trees onto the screen and tags what it can see. Each tag pays, and the review card shows them with their points:

- **A tree** — the base. How much of the frame the best tree fills, how it sits left to right, whether a nearer trunk stands across it.
- **Distance and angle** — close-up, bark, the canopy, open sky, low angle, undergrowth.
- **Light** — into the sun, light shafts.
- **Depth and company** — the treeline, into the fog, a grove of one species, mixed woods, an ancient, understory.
- **Weather** — falling leaves, snowfall, petals, depending on the scene.
- **Placement** — rule of thirds, dead centre.

A tag you've already earned on this roll pays 40%. Grades run D to S per photo, out of 1000. Only an empty frame is refused, and it costs nothing. After thirty seconds without a shot, a quiet nudge appears — *look up*, *face the light* — and rotates until you shoot.

The photo itself is the PS1 buffer read straight off the canvas, so it's a real 640×360 pixelated frame, not a re-render. `Walk` and `Demo` are still there for wandering without a camera.

## Everything underneath

| File | What it does |
| --- | --- |
| `chunk.js` | Deterministic forest chunks. `(cx, cz, seed)` hashed through mulberry32 always yields the same trees, so walking back is free. |
| `world.js` / `tree-templates.js` | A small pool of pre-grown tree meshes, scattered as instances. |
| `grass.js` | One `InstancedMesh` of crossed alpha-textured cards — up to ~58k clumps — that follows the player, noise-driven for wind, height and colour. |
| `terrain.js` | A height field shared between JS and GLSL, so ground, trees, grass and player all agree on where the hills are. |
| `seasons.js` | Per-leaf recolouring that preserves luminance, plus falling leaves, snow or petals. Pines stay green. |
| `quality.js` | Three tiers (shadow map size, DPR, view distance, grass field radius, leaf reduction), auto-detected and overridable. |
| `photo.js` | The camera: what it sees in a frame, the tag scoring, the scene turns, HUD, end-of-roll contact sheet and downloads. |
| `demo.js` | The hands-off camera. |
| `recorder.js` | `#record` clip capture. |

## Credits

The trees come from Daniel Greenheck's [ez-tree](https://github.com/dgreenheck/ez-tree) (MIT), and this project started from his Codrops article [Fractals to Forests](https://tympanus.net/codrops/2025/01/27/fractals-to-forests-creating-realistic-3d-trees-with-three-js/).

The grass technique — crossed alpha cards with a base-to-tip gradient and noise-driven wind — is adapted from [FluffyGrass](https://github.com/thebenezer/FluffyGrass) by Ebenezer (MIT), along with its blade and noise textures.

Bark and leaf textures are editable copies extracted from ez-tree; their original photo sources are listed in [`src/assets/trees/CREDITS.txt`](src/assets/trees/CREDITS.txt).

Built with [Three.js](https://threejs.org/), [postprocessing](https://github.com/pmndrs/postprocessing), [three-good-godrays](https://github.com/Ameobea/three-good-godrays), GSAP, lil-gui and nipplejs.

## License

MIT — see [LICENSE](LICENSE).
