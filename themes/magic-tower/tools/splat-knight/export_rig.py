"""Export the magic-tower knight as a *rigged* splat model: splats once, in a rest pose, plus bone keyframes.

Every rigid part of the Blender knight (helmet plates, pauldrons, gauntlets, sword ...) becomes one bone; the four
cloak panels, whose shape render_knight.py recomputes every frame (cloth_eval), each get a coarse grid of bones that
follows the cloth surface, and their splats are bilinearly skinned to the grid. A keyframe is then just every bone's
rigid transform relative to the rest pose, so the browser can interpolate between keyframes (smooth motion at any
frame rate), add its own offsets (head turns) and show him from any angle.

Splats that no ray can reach in any of a few sample poses (the body under the armour, the inner faces of plates) are
dropped: they never show and only cost sorting.

    KN_PIPELINE=/path/to/demos/magic-tower/pipeline blender -b --factory-startup --python export_rig.py

Writes out/knight_rig.bin + knight_rig.json (three.js space: y up, the knight faces +z, feet at y = 0):
  splats   count x 22 bytes: int16 x, y, z (bbox-quantised) | int8 oct-normal u, v | uint8 colour (ramp * 5 + step)
           | uint8 part | uint8 size class (0 normal, 1 fine: helmet and hands, 2 gold thread) | uint8 weight[3]
           (the 4th weight is 255 - the others) | uint16 bone[4]
  The whole file is gzipped (knight_rig.bin.gz); the browser inflates it with DecompressionStream.
  frames   per animation, per keyframe, per bone: float32 qx, qy, qz, qw, tx, ty, tz  (rest -> pose)
  pivots   per animation, per keyframe: float32 head pivot x, y, z  (for runtime head turns)
"""
import json
import math
import os
import random
import struct
import sys
import zlib

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

PIPE = os.environ.get("KN_PIPELINE") or os.path.expanduser(
    "~/Desktop/desk-pet/.claude/worktrees/practice-water-logic-c4bea6/demos/magic-tower/pipeline")
SRC = os.path.join(PIPE, "render_knight.py")
code = open(SRC, encoding="utf-8").read()
cut = code.index("# ---------------------------------------------------------------- render loop")
ns = {"__file__": SRC, "__name__": "render_knight_model"}
exec(compile(code[:cut], SRC, "exec"), ns)

sys.path.insert(0, PIPE)
from config import ANIMS, FRAMES, SIT_HANDS, SIT_TURN  # noqa: E402
from palette import RAMPS, RAMP_ID  # noqa: E402

SPACING = float(os.environ.get("KN_SPACING", "0.009"))
# cloth bones per panel (u across, v down). Spark's skinning reads 8-bit bone indices, so everything has to fit in 255
# bones: the rigid parts share one bone per joint (see GROUPS below), the rest goes to the cloth, densest along v on the
# skirts, which fold over his lap when he sits
GRID = {"BackA": (6, 10), "BackB": (6, 10), "SkirtR": (6, 10), "SkirtL": (6, 10)}
# point spacing per kind of part, relative to SPACING: gold cords and trims are thin, the helmet and the hands are the
# parts the study camera sees closest
SIZE_SPACING = {0: 1.0, 1: 0.65, 2: 0.55}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

PARTS, NODES, CLOTH, PANELS = ns["PARTS"], ns["NODES"], ns["CLOTH"], ns["PANELS"]
root, head, walk, sit, cloth_eval = ns["root"], ns["head"], ns["walk"], ns["sit"], ns["cloth_eval"]
set_props_visible = ns["set_props_visible"]
root.rotation_euler.z = 0.0

# Blender (x right, y back, z up; he faces -y)  ->  three.js (x, z, -y; he faces +z)
C3 = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
C4 = C3.to_4x4()
C4i = C4.inverted()


def to3(v):
    return Vector((v.x, v.z, -v.y))


cloth_of = {obj.name: (panel, pts) for obj, panel, pts in CLOTH}
parts = [(o, ramp, step) for o, _, ramp, step in PARTS if not o.hide_render]
rigid = [o for o, _, _ in parts if o.name not in cloth_of]
panels = list(PANELS.keys())

# ---------------------------------------------------------------- bones
# bone ids: one per group of rigid parts that move together (filled in once the keyframes are known), then each panel's
# cloth grid
GRID_START = {}


def grid_nodes(panel):
    nu, nv = GRID[panel]
    return [-1 + 2 * i / (nu - 1) for i in range(nu)], [j / (nv - 1) for j in range(nv)]


def grid_bone(pk, i, j):
    return GRID_START[panels[pk]] + j * GRID[panels[pk]][0] + i


def under_head(o):
    p = o.parent
    while p is not None:
        if p == head:
            return True
        p = p.parent
    return False


def under(o, names):
    p = o.parent
    while p is not None:
        if p.name in names:
            return True
        p = p.parent
    return False


def size_class(o, ramp):
    if ramp == "gold":
        return 2
    if under_head(o) or under(o, ("ElbowL", "ElbowR")):
        return 1
    return 0


def bone_frames(P):
    """world matrices (three.js space, scale stripped) of every bone for the current pose"""
    bpy.context.view_layer.update()
    mats = []
    for o in rigid:
        loc, rot, _ = (C4 @ o.matrix_world @ C4i).decompose()
        mats.append((rot, loc))
    for panel in panels:
        GU, GV = grid_nodes(panel)
        for j, v in enumerate(GV):
            for i, u in enumerate(GU):
                e = 1e-3
                p = cloth_eval(panel, u, v, 0.0, P)
                du = cloth_eval(panel, min(u + e, 1), v, 0.0, P) - cloth_eval(panel, max(u - e, -1), v, 0.0, P)
                dv = cloth_eval(panel, u, min(v + e, 1), 0.0, P) - cloth_eval(panel, u, max(v - e, 0), 0.0, P)
                x = to3(du).normalized()
                z = x.cross(to3(dv)).normalized()
                y = z.cross(x)
                rot = Matrix((x, y, z)).transposed().to_quaternion()
                mats.append((rot, to3(p)))
    return mats


# cloth params of each pose: walk/sit call apply_cloth(P); capture P instead of re-deriving it
CAPTURED = {}
_apply = ns["apply_cloth"]


def _capture(P):
    CAPTURED["P"] = P
    _apply(P)


ns["apply_cloth"] = _capture


def pose(anim, f):
    set_props_visible(anim != "sit")
    {"walk": walk, "sit": sit}[anim](f)
    bpy.context.view_layer.update()
    return CAPTURED["P"]


# ---------------------------------------------------------------- sampling on the rest pose (walk frame 0)
ANIM_FRAMES = (("walk", FRAMES), ("sit", ANIMS["sit"]["frames"]))
KEYS = {}
for anim, n in ANIM_FRAMES:
    for f in range(n):
        KEYS[(anim, f)] = (bone_frames(pose(anim, f)), [list(to3(head.matrix_world.translation))])
REST_P = pose("walk", 0)
REST = bone_frames(REST_P)
NR = len(rigid)


def rel(cur, rest):
    q, t = cur
    qr = q @ rest[0].inverted()
    return qr, t - qr @ rest[1]


# rigid parts whose rest -> pose transform is the same in every keyframe share a bone (they hang off the same joint);
# the sword stays on its own so it can be hidden while he sits
GROUPS, BONE_OF_PART = [], {}
for k, o in enumerate(rigid):
    sig = [rel(KEYS[key][0][k], REST[k]) for key in KEYS]
    for g, (members, gsig, prop) in enumerate(GROUPS):
        if prop == (o.name in ns["PROPS"]) and all(
                min((a[0] - b[0]).magnitude, (a[0] + b[0]).magnitude) < 1e-5 and (a[1] - b[1]).length < 1e-5
                for a, b in zip(sig, gsig)):
            members.append(k)
            BONE_OF_PART[o.name] = g
            break
    else:
        GROUPS.append(([k], sig, o.name in ns["PROPS"]))
        BONE_OF_PART[o.name] = len(GROUPS) - 1
nb = len(GROUPS)
for panel in panels:
    GRID_START[panel] = nb
    nb += GRID[panel][0] * GRID[panel][1]
NBONES = nb
assert NBONES <= 255, NBONES
print(f"[export_rig] {NR} rigid parts -> {len(GROUPS)} joint bones, {NBONES} bones in all")


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


dg = bpy.context.evaluated_depsgraph_get()
plan = []          # (part index, tri, a, b)
for pi, (obj, ramp, step) in enumerate(parts):
    vs, tris, _, _ = tri_list(obj, dg)
    rnd = random.Random(zlib.crc32(obj.name.encode()))
    carry = rnd.random()
    sp = SPACING * SIZE_SPACING[size_class(obj, ramp)]
    for ti, (i, j, k) in enumerate(tris):
        area = ((vs[j] - vs[i]).cross(vs[k] - vs[i])).length / 2
        carry += area / (sp * sp)
        n = int(carry)
        carry -= n
        for _ in range(n):
            a, b = rnd.random(), rnd.random()
            if a + b > 1:
                a, b = 1 - a, 1 - b
            plan.append((pi, ti, a, b))
print(f"[export_rig] {len(parts)} parts, {NBONES} bones, {len(plan)} samples at spacing {SPACING}")


def eval_plan(depsgraph):
    """posed position + normal (Blender space) of every sample, and a BVH of the whole knight"""
    cache = {pi: tri_list(parts[pi][0], depsgraph) for pi in range(len(parts))}
    allv, allf = [], []
    for pi in range(len(parts)):
        vs, tris, _, _ = cache[pi]
        o = len(allv)
        allv += vs
        allf += [(i + o, j + o, k + o) for i, j, k in tris]
    out = []
    for pi, ti, a, b in plan:
        vs, tris, vn, smooth = cache[pi]
        i, j, k = tris[ti]
        c = 1 - a - b
        p = vs[i] * c + vs[j] * a + vs[k] * b
        n = (vn[i] * c + vn[j] * a + vn[k] * b) if smooth[ti] else (vs[j] - vs[i]).cross(vs[k] - vs[i])
        out.append((p, n.normalized() if n.length > 1e-9 else Vector((0, 0, 1))))
    return out, BVHTree.FromPolygons(allv, allf, epsilon=0.0)


# ray directions around a normal: the normal itself, then two rings
def hemi(n):
    t = n.orthogonal().normalized()
    s = n.cross(t)
    dirs = [n]
    for ring, k in ((math.radians(45), 8), (math.radians(78), 10)):
        for m in range(k):
            a = 2 * math.pi * (m + 0.5 * (ring > 1)) / k
            dirs.append((n * math.cos(ring) + (t * math.cos(a) + s * math.sin(a)) * math.sin(ring)).normalized())
    return dirs


visible = [False] * len(plan)
rest_samples = None
for anim, f in (("walk", 0), ("walk", 4), ("sit", 0), ("sit", 13)):
    pose(anim, f)
    samples, bvh = eval_plan(bpy.context.evaluated_depsgraph_get())
    if rest_samples is None:
        rest_samples = samples
    for s, (p, n) in enumerate(samples):
        if visible[s]:
            continue
        o = p + n * 0.004
        for d in hemi(n):
            if bvh.ray_cast(o, d, 4.0)[0] is None:
                visible[s] = True
                break
    print(f"[export_rig] visibility after {anim} {f}: {sum(visible)} / {len(plan)}")

# ---------------------------------------------------------------- splat records
keep = [s for s in range(len(plan)) if visible[s]]
pts3 = [to3(rest_samples[s][0]) for s in keep]
lo = Vector((min(p.x for p in pts3), min(p.y for p in pts3), min(p.z for p in pts3)))
hi = Vector((max(p.x for p in pts3), max(p.y for p in pts3), max(p.z for p in pts3)))
span = hi - lo


def q16(v, a, b):
    return max(-32767, min(32767, round(((v - a) / (b - a)) * 65534 - 32767)))


def oct8(n):
    s = abs(n.x) + abs(n.y) + abs(n.z)
    x, y = n.x / s, n.y / s
    if n.z < 0:
        x, y = (1 - abs(y)) * (1 if x >= 0 else -1), (1 - abs(x)) * (1 if y >= 0 else -1)
    return max(-127, min(127, round(x * 127))), max(-127, min(127, round(y * 127)))


def cloth_uv(pi, ti, a, b):
    """(u, v) of a cloth sample: Solidify keeps the base vertices first, so vertex i maps to base point i % n"""
    obj = parts[pi][0]
    panel, pts = cloth_of[obj.name]
    n = len(pts)
    vs, tris, _, _ = tri_list(obj, bpy.context.evaluated_depsgraph_get()) if pi not in _uvcache else _uvcache[pi]
    _uvcache[pi] = (vs, tris, None, None)
    i, j, k = tris[ti]
    c = 1 - a - b
    u = pts[i % n][0] * c + pts[j % n][0] * a + pts[k % n][0] * b
    v = pts[i % n][1] * c + pts[j % n][1] * a + pts[k % n][1] * b
    return panels.index(panel), u, v


_uvcache = {}
pose("walk", 0)
buf = bytearray()
for s, p3 in zip(keep, pts3):
    pi, ti, a, b = plan[s]
    obj, ramp, step = parts[pi]
    n3 = to3(rest_samples[s][1]).normalized()
    if obj.name in cloth_of:
        pk, u, v = cloth_uv(pi, ti, a, b)
        nu, nv = GRID[panels[pk]]
        fu = (min(max(u, -1), 1) + 1) / 2 * (nu - 1)
        fv = min(max(v, 0), 1) * (nv - 1)
        i0, j0 = min(int(fu), nu - 2), min(int(fv), nv - 2)
        du, dv = fu - i0, fv - j0
        bones = [grid_bone(pk, i0, j0), grid_bone(pk, i0 + 1, j0), grid_bone(pk, i0, j0 + 1), grid_bone(pk, i0 + 1, j0 + 1)]
        w = [(1 - du) * (1 - dv), du * (1 - dv), (1 - du) * dv, du * dv]
    else:
        bones = [BONE_OF_PART[obj.name], 0, 0, 0]
        w = [1, 0, 0, 0]
    wq = [round(x * 255) for x in w[:3]]
    wq = [min(255, max(0, x)) for x in wq]
    if sum(wq) > 255:
        wq[0] -= sum(wq) - 255
    ox, oy = oct8(n3)
    buf += struct.pack("<3h2b3B3B4H", q16(p3.x, lo.x, hi.x), q16(p3.y, lo.y, hi.y), q16(p3.z, lo.z, hi.z),
                       ox, oy, RAMP_ID[ramp] * 5 + step, pi, size_class(obj, ramp), *wq, *bones)
assert len(buf) == len(keep) * 22

# ---------------------------------------------------------------- keyframes
anims = {}
frames_buf = bytearray()
for anim, n in ANIM_FRAMES:
    off = len(frames_buf)
    pivots = []
    for f in range(n):
        cur, piv = KEYS[(anim, f)]
        rows = [rel(cur[members[0]], REST[members[0]]) for members, _, _ in GROUPS]
        rows += [rel(c, r) for c, r in zip(cur[NR:], REST[NR:])]
        assert len(rows) == NBONES
        for qr, tt in rows:
            frames_buf += struct.pack("<7f", qr.x, qr.y, qr.z, qr.w, tt.x, tt.y, tt.z)
        pivots.append(piv[0])
    anims[anim] = {"frames": n, "offset": off, "pivots": pivots, "hideProps": anim == "sit"}
    print(f"[export_rig] {anim}: {n} keyframes")

# ---------------------------------------------------------------- self-check: skin the rest samples with the exported
# bones and compare with the real posed surface (KN_CHECK=1)
if os.environ.get("KN_CHECK"):
    import statistics
    nb = NBONES
    recs = [struct.unpack_from("<3h2b3B3B4H", buf, i * 22) for i in range(len(keep))]
    for anim, f in (("walk", 3), ("sit", 0), ("sit", 13)):
        A = anims[anim]
        P = pose(anim, f)
        truth, _ = eval_plan(bpy.context.evaluated_depsgraph_get())
        base = A["offset"] // 4 + f * nb * 7
        fl = struct.unpack_from(f"<{nb * 7}f", frames_buf, base * 4)
        err = {}
        for s, rec in zip(keep, recs):
            pi = plan[s][0]
            name = parts[pi][0].name
            p0 = Vector((rec[0], rec[1], rec[2]))
            p0 = Vector((lo.x + (p0.x + 32767) / 65534 * span.x, lo.y + (p0.y + 32767) / 65534 * span.y, lo.z + (p0.z + 32767) / 65534 * span.z))
            ws = list(rec[8:11]) + [255 - sum(rec[8:11])]
            acc = Vector((0, 0, 0))
            for b, w in zip(rec[11:15], ws):
                if w <= 0:
                    continue
                o = b * 7
                q = Quaternion((fl[o + 3], fl[o], fl[o + 1], fl[o + 2]))
                acc += (q @ p0 + Vector(fl[o + 4:o + 7])) * (w / 255)
            e = (acc - to3(truth[s][0])).length
            key = "cloth:" + cloth_of[name][0] if name in cloth_of else "rigid"
            err.setdefault(key, []).append(e)
        print(f"[check] {anim} {f}: " + ", ".join(f"{k} mean {statistics.mean(v) * 1000:.1f} mm max {max(v) * 1000:.0f} mm" for k, v in sorted(err.items())))

import gzip  # noqa: E402
with gzip.open(os.path.join(OUT, "knight_rig.bin.gz"), "wb", compresslevel=9) as fh:
    fh.write(buf)
    fh.write(frames_buf)
meta = {
    "count": len(keep), "spacing": SPACING, "sizeSpacing": SIZE_SPACING, "stride": 22, "bones": NBONES,
    "framesOffset": len(buf), "parts": len(parts),
    "bbox": [list(lo), list(hi)],
    "headBones": sorted({BONE_OF_PART[o.name] for o in rigid if under_head(o)}),
    # the sword: render_knight.py hides it while he sits (set_props_visible(anim != "sit"))
    "propBones": [g for g, (_, _, prop) in enumerate(GROUPS) if prop],
    "anims": anims,
    "ramps": [{"name": nm, "colors": cols, "lit": lit} for nm, cols, lit in RAMPS],
    "sitHands": SIT_HANDS, "sitTurn": SIT_TURN,
}
with open(os.path.join(OUT, "knight_rig.json"), "w") as fh:
    json.dump(meta, fh, indent=1)
gz = os.path.getsize(os.path.join(OUT, "knight_rig.bin.gz"))
print(f"[export_rig] wrote {len(keep)} splats ({len(buf) / 1e6:.2f} MB) + {len(frames_buf) / 1e3:.0f} KB keyframes, gzipped {gz / 1e6:.2f} MB")
