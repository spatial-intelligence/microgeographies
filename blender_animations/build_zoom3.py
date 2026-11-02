"""
Clip 5 (25 s, 600 f @ 24 fps): space -> Earth -> Scotland -> Edinburgh -> Heriot-Watt
campus -> up to a building entrance. NO TEXT overlays (pure imagery), cloud layer kept.
  0-12s   orbital descent: stars, Earth + clouds, Europe, Scotland, Edinburgh pin
  ~12s    white flash transition through the clouds
  12-25s  campus swoop: lawn, lake, trees, tower + glass entrance pavilion, warm lobby
Run: blender -b --factory-startup --python-exit-code 1 -P build_zoom3.py
Outputs (next to this script): space_to_heriotwatt_25s.mp4, zoom3_scene.blend
Needs: tex/earth_day.jpg, tex/earth_clouds.png
"""
import bpy, math, random, os, sys
from mathutils import Vector

OUT = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(OUT, "tex")
FPS, END = 24, 600
CUT = 300
rng = random.Random(31)
TESTFRAME = 0
for _a in sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []:
    if _a.startswith("testframe="): TESTFRAME = int(_a.split("=")[1])

R = 2.0
LAT, LON = math.radians(55.948), math.radians(-3.190)
E0 = Vector((math.cos(LAT)*math.cos(LON), math.cos(LAT)*math.sin(LON), math.sin(LAT))) * R
SX = 120.0  # campus offset; entrance faces -Y, doors at local x=0

def clean():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    try: s.cycles.device = 'CPU'
    except Exception: pass
    s.cycles.samples = 24
    try:
        s.cycles.use_denoising = True; s.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception: pass
    s.render.resolution_x, s.render.resolution_y = 1280, 720
    s.render.fps = FPS; s.frame_start, s.frame_end = 1, END
    s.render.image_settings.file_format = 'FFMPEG'
    s.render.ffmpeg.format = 'MPEG4'; s.render.ffmpeg.codec = 'H264'
    s.render.ffmpeg.constant_rate_factor = 'HIGH'; s.render.ffmpeg.ffmpeg_preset = 'GOOD'
    s.render.filepath = os.path.join(OUT, "space_to_heriotwatt_25s.mp4")
    s.world = bpy.data.worlds.new("W"); s.world.use_nodes = True
    bg = s.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.004, 0.005, 0.012, 1)
    bg.inputs[1].default_value = 0.5
    return s, bg

def mat(name, color=(1,1,1), rough=0.6, emit=None, es=0.0, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Alpha"].default_value = alpha
    if emit: b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = es
    if alpha < 1: m.surface_render_method = 'DITHERED'
    return m

def box(name, loc, size, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object; o.name = name; o.dimensions = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("b", 'BEVEL'); mod.width = bevel; mod.segments = 2
    o.data.materials.append(material); return o

def cyl(name, loc, r, h, material, verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc)
    o = bpy.context.object; o.name = name; o.data.materials.append(material); return o

def sphere(name, loc, r, material):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=18, ring_count=10)
    o = bpy.context.object; o.name = name; o.data.materials.append(material)
    bpy.ops.object.shade_smooth(); return o

def look(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def key(o, f, loc=None, scale=None, hide=None):
    if loc is not None: o.location = loc; o.keyframe_insert("location", frame=f)
    if scale is not None: o.scale = scale; o.keyframe_insert("scale", frame=f)
    if hide is not None: o.hide_render = hide; o.keyframe_insert("hide_render", frame=f)

def key_alpha(m, f, a):
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Alpha"].default_value = a
    b.inputs["Alpha"].keyframe_insert("default_value", frame=f)

scene, world_bg = clean()
space_objs, camp_objs = [], []

# ---------- stars ----------
import bmesh
sme = bpy.data.meshes.new("Stars"); sbm = bmesh.new()
faces = [(0,1,2),(0,2,3),(0,3,4),(0,4,1),(5,2,1),(5,3,2),(5,4,3),(5,1,4)]
for _ in range(1200):
    v = Vector((rng.gauss(0,1), rng.gauss(0,1), rng.gauss(0,1)))
    if v.length == 0: continue
    v.normalize(); p = v * rng.uniform(35, 70); r = rng.uniform(0.05, 0.16)
    vs = [sbm.verts.new((p.x+dx*r, p.y+dy*r, p.z+dz*r)) for dx,dy,dz in
          [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
    for fc in faces: sbm.faces.new([vs[i] for i in fc])
sbm.to_mesh(sme)
stars = bpy.data.objects.new("Stars", sme); bpy.context.collection.objects.link(stars)
stars.data.materials.append(mat("StarM", (1,1,1), 0.5, emit=(1,1,1), es=1.6))
space_objs.append(stars)

def equirect_uv(me, rad):
    uvl = me.uv_layers.new(name="EQ")
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            lon = math.degrees(math.atan2(co.y, co.x))
            lat = math.degrees(math.asin(max(-1, min(1, co.z / rad))))
            uvl.data[li].uv = ((lon+180.0)/360.0, (lat+90.0)/180.0)

bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=R, location=(0,0,0))
earth = bpy.context.object; earth.name = "Earth"
equirect_uv(earth.data, R); bpy.ops.object.shade_smooth()
day_img = bpy.data.images.load(os.path.join(TEX, "earth_day.jpg")); day_img.colorspace_settings.name = 'sRGB'
em = mat("EarthM", (1,1,1), rough=0.62)
nt = em.node_tree; ebsdf = nt.nodes["Principled BSDF"]
etx = nt.nodes.new("ShaderNodeTexImage"); etx.image = day_img
nt.links.new(etx.outputs["Color"], ebsdf.inputs["Base Color"])
earth.data.materials.append(em); space_objs.append(earth)

bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, radius=R*1.02, location=(0,0,0))
clouds = bpy.context.object; clouds.name = "Clouds"
equirect_uv(clouds.data, R*1.02); bpy.ops.object.shade_smooth()
cl_img = bpy.data.images.load(os.path.join(TEX, "earth_clouds.png")); cl_img.colorspace_settings.name = 'sRGB'
cm = mat("CloudM", (1,1,1), rough=0.9)
cnt = cm.node_tree; cbsdf = cnt.nodes["Principled BSDF"]
ctx = cnt.nodes.new("ShaderNodeTexImage"); ctx.image = cl_img
cnt.links.new(ctx.outputs["Color"], cbsdf.inputs["Base Color"])
cnt.links.new(ctx.outputs["Alpha"], cbsdf.inputs["Alpha"])
clouds.data.materials.append(cm); space_objs.append(clouds)

bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=R*1.045, location=(0,0,0))
atmo = bpy.context.object; atmo.name = "Atmo"; bpy.ops.object.shade_smooth()
am = bpy.data.materials.new("AtmoM"); am.use_nodes = True
ant = am.node_tree; aout = ant.nodes["Material Output"]
trans = ant.nodes.new("ShaderNodeBsdfTransparent")
emis = ant.nodes.new("ShaderNodeEmission"); emis.inputs["Color"].default_value = (0.35, 0.6, 1.0, 1)
emis.inputs["Strength"].default_value = 1.4
lw = ant.nodes.new("ShaderNodeLayerWeight"); lw.inputs["Blend"].default_value = 0.35
mix = ant.nodes.new("ShaderNodeMixShader")
ant.links.new(lw.outputs["Fresnel"], mix.inputs["Fac"])
ant.links.new(trans.outputs["BSDF"], mix.inputs[1])
ant.links.new(emis.outputs["Emission"], mix.inputs[2])
ant.links.new(mix.outputs["Shader"], aout.inputs["Surface"])
atmo.data.materials.append(am); space_objs.append(atmo)

sun_dir = (E0.normalized() + Vector((0.25, -0.2, 0.35))).normalized()
sd = bpy.data.lights.new("SunSpace", 'SUN'); sd.energy = 4.0
so = bpy.data.objects.new("SunSpace", sd); bpy.context.collection.objects.link(so)
so.rotation_euler = (-sun_dir).to_track_quat('-Z', 'Y').to_euler()

pinM = mat("PinM", (1, 0.2, 0.25), 0.35, emit=(1, 0.2, 0.25), es=2.2)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.03, location=E0*1.005)
pin = bpy.context.object; pin.name = "Pin"; pin.data.materials.append(pinM)
pin.parent = earth; pin.matrix_parent_inverse.identity(); space_objs.append(pin)
key(pin, 1, hide=True); key(pin, 200, hide=False); key(pin, CUT, hide=False); key(pin, CUT+1, hide=True)

# ================= CAMPUS (local frame + SX offset, entrance faces -Y) =================
def S(x, y, z): return (SX+x, y, z)
concM  = mat("Conc", (0.72, 0.70, 0.66), 0.8)
stoneM = mat("Stone2", (0.58, 0.53, 0.46), 0.85)
glassM = mat("Glass2", (0.55, 0.7, 0.85), 0.08, alpha=0.45)
mullM  = mat("Mull", (0.12, 0.13, 0.15), 0.5)
lawnM  = mat("Lawn", (0.24, 0.44, 0.22), 0.9)
pathM  = mat("Path", (0.78, 0.75, 0.68), 0.9)
waterM = mat("Water", (0.2, 0.42, 0.62), 0.05)
leafM  = mat("Leaf2", (0.22, 0.52, 0.24), 0.85)
barkM  = mat("Bark2", (0.3, 0.2, 0.12), 0.9)
lobbyM = mat("Lobby", (1.0, 0.74, 0.45), 0.5, emit=(1.0, 0.72, 0.42), es=2.6)
ironM  = mat("Iron2", (0.06, 0.06, 0.07), 0.5)

camp_objs.append(box("Lawn", S(0, -12, -0.1), (76, 56, 0.2), lawnM, 0.0))
camp_objs.append(box("PathMain", S(0, -20, -0.02), (3.2, 44, 0.08), pathM, 0.0))
camp_objs.append(box("PathCross", S(0, -8, 0.0), (40, 2.6, 0.08), pathM, 0.0))
camp_objs.append(box("Plaza", S(0, -2.5, 0.02), (20, 7, 0.08), pathM, 0.0))
# lake
camp_objs.append(cyl("Lake", S(-21, -24, -0.02), 7.0, 0.16, waterM, 40))
# main teaching block: concrete frame + glass front
camp_objs.append(box("MainBlock", S(0, 5, 4.5), (26, 10, 9), concM, 0.06))
camp_objs.append(box("RoofSlab", S(0, 5, 9.2), (27.5, 11, 0.5), stoneM, 0.03))
for gx in [i*2.0-12.0 for i in range(13)]:
    camp_objs.append(box("Mullion", S(gx, -0.05, 4.5), (0.22, 0.25, 8.2), mullM, 0.0))
for gz in (1.2, 4.5, 7.8):
    camp_objs.append(box("Transom", S(0, -0.05, gz), (24.5, 0.25, 0.22), mullM, 0.0))
camp_objs.append(box("GlassFront", S(0, 0.02, 4.5), (24.5, 0.12, 8.2), glassM, 0.0))
# entrance pavilion: glass box + glowing lobby core + canopy
camp_objs.append(box("PavGlass", S(0, -1.8, 2.0), (9, 3.2, 4.0), glassM, 0.0))
camp_objs.append(box("LobbyCore", S(0, -1.4, 1.9), (6.5, 1.6, 3.2), lobbyM, 0.0))
camp_objs.append(box("Canopy", S(0, -2.6, 4.35), (10, 4.2, 0.3), concM, 0.03))
for colx in (-4.4, 4.4):
    camp_objs.append(cyl("CanopyCol", S(colx, -3.8, 2.1), 0.16, 4.2, concM, 12))
# stone side wing + tower with light strips
camp_objs.append(box("Wing", S(-17, 4, 3), (11, 8, 6), stoneM, 0.04))
for wz in (2.0, 4.0):
    for wx in (-20.5, -17, -13.5):
        camp_objs.append(box("WingWin", S(wx, -0.05, wz), (1.6, 0.15, 1.4),
                             mat(f"WWin{wz}{wx}", (0.16, 0.22, 0.3), 0.15, emit=(1.0, 0.8, 0.55), es=0.5), 0.0))
camp_objs.append(box("Tower", S(16, 6, 10), (7, 7, 20), concM, 0.05))
for tx in (14.2, 16, 17.8):
    camp_objs.append(box("TowerStrip", S(tx, 2.4, 10), (0.9, 0.2, 17),
                         mat(f"TStrip{tx}", (0.5, 0.68, 0.85), 0.1, emit=(0.6, 0.8, 1.0), es=0.35), 0.0))
camp_objs.append(box("TowerCap", S(16, 6, 20.4), (8, 8, 0.8), stoneM, 0.03))
# trees (deterministic ring, clear of paths/building/lake)
tree_spots = [(-10,-14), (-6,-22), (6,-16), (10,-26), (-14,-6), (14,-10), (22,-18),
              (-26,-12), (24,-6), (-8,-32), (8,-34), (-28,-28), (28,-30), (4,-10)]
for i, (tx, ty) in enumerate(tree_spots):
    camp_objs.append(cyl(f"Trunk{i}", S(tx, ty, 0.9), 0.14, 1.8, barkM, 8))
    camp_objs.append(sphere(f"Crown{i}", S(tx, ty, 2.5), 1.15, leafM))
    camp_objs[-1].scale = (1, 1, 0.9)
# lamp posts along main path
lampM = mat("Lamp2", (1.0, 0.82, 0.55), 0.4, emit=(1.0, 0.8, 0.52), es=2.0)
for i, lx in enumerate((-3.2, 3.2)):
    for lz, ly in ((8, -14), (8, -26)):
        camp_objs.append(cyl(f"Post{i}{ly}", S(lx, ly, 2.5), 0.08, 5.0, ironM, 8))
        camp_objs.append(sphere(f"Lamp{i}{ly}", S(lx, ly, 5.1), 0.24, lampM))
# campus sun (swapped in after the flash)
sd2 = bpy.data.lights.new("SunCamp", 'SUN'); sd2.energy = 3.2
so2 = bpy.data.objects.new("SunCamp", sd2); bpy.context.collection.objects.link(so2)
so2.rotation_euler = (math.radians(48), 0, math.radians(-35))
key(so2, 1, hide=True); key(so2, CUT-6, hide=False); key(so2, END, hide=False)
key(so, CUT, hide=False); key(so, CUT+1, hide=True)

for o in camp_objs:
    key(o, 1, hide=True); key(o, CUT-6, hide=False); key(o, END, hide=False)
for o in space_objs:
    key(o, CUT, hide=False); key(o, CUT+1, hide=True)
world_bg.inputs[1].default_value = 0.5; world_bg.inputs[1].keyframe_insert("default_value", frame=1)
world_bg.inputs[1].default_value = 0.5; world_bg.inputs[1].keyframe_insert("default_value", frame=CUT)
world_bg.inputs[1].default_value = 1.15; world_bg.inputs[1].keyframe_insert("default_value", frame=380)
world_bg.inputs[0].default_value = (0.004, 0.005, 0.012, 1)
world_bg.inputs[0].keyframe_insert("default_value", frame=CUT)
world_bg.inputs[0].default_value = (0.55, 0.63, 0.78, 1)
world_bg.inputs[0].keyframe_insert("default_value", frame=380)
so.data.energy = 4.0

# ================= CAMERA =================
cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 42
cam_data.clip_start = 0.01; cam_data.clip_end = 300
cam = bpy.data.objects.new("Camera", cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam
D0 = (E0.normalized() + Vector((0.55, -0.5, 0.4))).normalized()
D1 = E0.normalized()
d0, d1A = 7*R, R*1.25
SPIN = math.radians(10)
for f in list(range(1, CUT+1, 12)) + [CUT]:
    t = (f-1)/(CUT-1)
    ang = SPIN * t
    ca, sa = math.cos(ang), math.sin(ang)
    E = Vector((E0.x*ca - E0.y*sa, E0.x*sa + E0.y*ca, E0.z))
    dd = max(-1, min(1, D0.dot(D1))); om = math.acos(dd)
    D = D1.copy() if om < 1e-4 else (D0*math.sin((1-t)*om) + D1*math.sin(t*om)) / math.sin(om)
    D.normalize()
    d = math.exp(math.log(d0)*(1-t) + math.log(d1A)*t)
    cam.location = E + D*d; look(cam, E*(t**2))
    cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_euler", frame=f)
    earth.rotation_euler = (0, 0, ang); earth.keyframe_insert("rotation_euler", frame=f)
    clouds.rotation_euler = (0, 0, ang*1.6 + 0.15); clouds.keyframe_insert("rotation_euler", frame=f)
# phase B: campus swoop to the entrance (dense cubic keys)
P0, P1, P2, P3 = (Vector(S(-32,-58,30)), Vector(S(-14,-30,15)),
                  Vector(S(-4,-14,6)), Vector(S(0,-14,4.5)))
T0, T1 = Vector(S(0,0,4.5)), Vector(S(0,-0.5,2.5))
for f in range(CUT, END+1, 4):
    t = (f-CUT)/(END-CUT)
    u = 1-t
    pos = u**3*P0 + 3*u*u*t*P1 + 3*u*t*t*P2 + t**3*P3
    s = t*t*(3-2*t)
    tgt = T0 + (T1-T0)*s
    cam.location = pos; look(cam, tgt)
    cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_euler", frame=f)

# flash card (masks the cut; no text anywhere in this clip)
flashM = mat("Flash3", (1,1,1), 1.0, emit=(1,1,1), es=3.0, alpha=0.0)
flash = box("Flash", (0,0,-1.0), (1.4, 1.4, 0.02), flashM, 0.0)
flash.parent = cam; flash.location = (0, 0, -1.0); flash.rotation_euler = (0,0,0)
key_alpha(flashM, 1, 0.0); key_alpha(flashM, CUT-8, 0.0); key_alpha(flashM, CUT-2, 1.0)
key_alpha(flashM, CUT+4, 1.0); key_alpha(flashM, CUT+12, 0.0); key_alpha(flashM, END, 0.0)

for o in bpy.data.objects:
    if o.animation_data and o.animation_data.action:
        for fc in o.animation_data.action.fcurves:
            for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "zoom3_scene.blend"))
if TESTFRAME:
    scene.frame_set(TESTFRAME)
    scene.render.filepath = f"/tmp/zoom3_preview_{TESTFRAME}.png"
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("DONE zoom3 frames 1-600 ->", scene.render.filepath)
