# Splat knight (prototype)

The magic-tower knight as pixel-art Gaussian splats: real 3D you can orbit, drawn as crisp pixels in the knight's
own 45-colour palette.

```bash
npm install
npm run export   # Blender: samples the knight into surfels -> public/knight_walk.{bin,json} (bin is gitignored)
npm run dev
```

- `export_splats.py` runs the knight pipeline's `render_knight.py` up to its render loop (nothing is rendered, the
  .blend/.glb are untouched), then scatters seeded points over every part for each of the 8 walk frames. A point
  keeps its part's palette ramp + base step and the surface normal. `KN_PIPELINE` points at the pipeline folder
  (default: the practice-water-logic worktree), `KN_SPACING` sets the point spacing (0.016 m ≈ 70k splats/frame).
- `main.js` loads one Spark `SplatMesh` per walk frame. A world modifier lights every splat with the tower's knight
  lighting (scene.js `makeKnightMesh`: ambient 0.46 + 4 lights, bands 0.32 / 0.62 / 0.9 shift the step, ink capped,
  glow unlit) and lifts gold / gem / glow splats toward the camera so the cloth underneath can't speckle them.
- `post.js` (adapted from cobanov/pixelart-gaussiansplat, MIT): 2×2 supersampled coverage, colour by vote, outline
  drops an edge pixel to its own ramp's dark step.

`knightProto.pose({ angle, elev, frame })` freezes a view for screenshots; `knightProto.bench(80)` gives GPU ms/frame.

## Where this lives

Moved here from desk-pet `demos/splat-knight` on 2026-11-25 so the prototype is in git. `export_rig.py` wrote
`out/knight_rig.{bin.gz,json}`; that output is the same file as `themes/magic-tower/assets/knight_rig.*`, which the
`#splat` knight in the tower loads (`src/splatKnight.js`). The prototype was not adopted; main stays on the Blender
sprite knight.
