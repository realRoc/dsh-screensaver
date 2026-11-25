"""Export the magic-tower knight as surface splats (surfels) for the pixel-art Gaussian splat prototype.

Builds the same model as the knight pipeline's render_knight.py (its code up to the render loop runs unchanged, so
nothing is rendered and build/knight.blend / knight.glb are not touched), then for every walk frame poses him and
scatters points over every visible part. Each point keeps the part's palette ramp and base step plus the surface
normal, so the browser lights it the way the sprite shader lights the index/normal sprites: shift the step along
the ramp.

    KN_PIPELINE=/path/to/demos/magic-tower/pipeline blender -b --factory-startup --python export_splats.py

Writes public/knight_walk.bin + knight_walk.json next to this file:
  bin  = per frame, per splat: float32 x, y, z, nx, ny, nz (three.js space: y up, he faces +z) + uint8 ramp, step, part, 0
  json = { frames, count (per frame), spacing, stride, ramps }
The same seeded barycentric samples are used on every frame, so splats move with the mesh instead of re-scattering.
"""
import json
import os
import random
import struct
import sys
import zlib

import bpy

PIPE = os.environ.get("KN_PIPELINE") or os.path.expanduser(
    "~/Desktop/desk-pet/.claude/worktrees/practice-water-logic-c4bea6/demos/magic-tower/pipeline")
SRC = os.path.join(PIPE, "render_knight.py")
code = open(SRC, encoding="utf-8").read()
cut = code.index("# ---------------------------------------------------------------- render loop")
ns = {"__file__": SRC, "__name__": "render_knight_model"}
exec(compile(code[:cut], SRC, "exec"), ns)

sys.path.insert(0, PIPE)
from config import FRAMES  # noqa: E402
from palette import RAMPS, RAMP_ID  # noqa: E402

SPACING = float(os.environ.get("KN_SPACING", "0.011"))   # metres between splats
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
os.makedirs(OUT, exist_ok=True)

PARTS, root, walk = ns["PARTS"], ns["root"], ns["walk"]
ns["set_props_visible"](True)
root.rotation_euler.z = 0.0
parts = [(o, ramp, step) for o, _, ramp, step in PARTS if not o.hide_render]


def tri_list(obj, depsgraph):
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    M = ev.matrix_world.copy()
    N = M.to_3x3().inverted().transposed()
    vs = [M @ v.co for v in me.vertices]
    tris = [tuple(t.vertices) for t in me.loop_triangles]
    smooth = [me.polygons[t.polygon_index].use_smooth for t in me.loop_triangles]
    vn = [(N @ v.normal).normalized() for v in me.vertices]
    ev.to_mesh_clear()
    return vs, tris, vn, smooth


# 1) sample plan on frame 0: per part, per triangle, seeded barycentric coords (area-weighted)
walk(0)
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
plan = []
for pi, (obj, ramp, step) in enumerate(parts):
    vs, tris, _, _ = tri_list(obj, dg)
    rnd = random.Random(zlib.crc32(obj.name.encode()))
    carry = rnd.random()
    for ti, (i, j, k) in enumerate(tris):
        area = ((vs[j] - vs[i]).cross(vs[k] - vs[i])).length / 2
        carry += area / (SPACING * SPACING)
        n = int(carry)
        carry -= n
        for _ in range(n):
            a, b = rnd.random(), rnd.random()
            if a + b > 1:
                a, b = 1 - a, 1 - b
            plan.append((pi, ti, a, b))
print(f"[export_splats] {len(parts)} parts, {len(plan)} splats per frame at spacing {SPACING}")

# 2) evaluate the plan on every walk frame
STRIDE = 28
buf = bytearray()
dropped = 0
for f in range(FRAMES):
    walk(f)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    cache = {}
    for pi, ti, a, b in plan:
        if pi not in cache:
            cache[pi] = tri_list(parts[pi][0], dg)
        vs, tris, vn, smooth = cache[pi]
        _, ramp, step = parts[pi]
        if ti >= len(tris):          # topology changed between frames: park the splat far below
            dropped += 1
            buf += struct.pack("<6f4B", 0, -100, 0, 0, 1, 0, RAMP_ID[ramp], step, pi, 0)
            continue
        i, j, k = tris[ti]
        c = 1 - a - b
        p = vs[i] * c + vs[j] * a + vs[k] * b
        if smooth[ti]:
            n = vn[i] * c + vn[j] * a + vn[k] * b
        else:
            n = (vs[j] - vs[i]).cross(vs[k] - vs[i])
        n = n.normalized() if n.length > 1e-9 else n.__class__((0, 0, 1))
        # Blender (x right, y back, z up; he faces -y)  ->  three.js (x, z, -y; he faces +z)
        buf += struct.pack("<6f4B", p.x, p.z, -p.y, n.x, n.z, -n.y, RAMP_ID[ramp], step, pi, 0)
    print(f"[export_splats] frame {f} done")

with open(os.path.join(OUT, "knight_walk.bin"), "wb") as fh:
    fh.write(buf)
meta = {"frames": FRAMES, "count": len(plan), "spacing": SPACING, "stride": STRIDE, "dropped": dropped,
        "ramps": [{"name": n, "colors": cols, "lit": lit} for n, cols, lit in RAMPS]}
with open(os.path.join(OUT, "knight_walk.json"), "w") as fh:
    json.dump(meta, fh, indent=1)
print(f"[export_splats] wrote {len(buf) / 1e6:.1f} MB to {os.path.abspath(OUT)} (dropped {dropped})")
