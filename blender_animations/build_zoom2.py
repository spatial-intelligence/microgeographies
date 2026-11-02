"""
Clip 4 (20 s, 480 f @ 24 fps): space -> Scotland -> down to a building's front door.
  0-10s   orbital descent: stars, Earth + cloud layer, northern Europe, Scotland, Edinburgh pin
  ~10s    white flash transition through the clouds
  10-20s  Edinburgh Old Town street: stone tenement, swoop down the street,
          door opens onto a warm hall, camera stops on the threshold
Run: blender -b --factory-startup --python-exit-code 1 -P build_zoom2.py
Outputs (next to this script): space_to_doorstep_20s.mp4, zoom2_scene.blend
Needs: tex/earth_day.jpg, tex/earth_clouds.png
"""
import bpy, math, random, os, sys
from mathutils import Vector

OUT = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(OUT, "tex")
FPS, END = 24, 480
CUT = 244  # flash transition centre frame
rng = random.Random(23)
TESTFRAME = 0
for _a in sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []:
    if _a.startswith("testframe="): TESTFRAME = int(_a.split("=")[1])

R = 2.0
LAT, LON = math.radians(55.948), math.radians(-3.190)
E0 = Vector((math.cos(LAT)*math.cos(LON), math.cos(LAT)*math.sin(LON), math.sin(LAT))) * R
SX, SY = 60.0, 0.0   # street scene offset (door faces -Y, door centre at local x=0)

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
    s.render.filepath = os.path.join(OUT, "space_to_doorstep_20s.mp4")
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

def text(name, body, loc, size=0.3, color=(1,1,1), align='CENTER'):
    bpy.ops.object.text_add(location=loc)
    o = bpy.context.object; o.name = name; o.data.body = body
    o.data.size = size; o.data.align_x = align; o.data.align_y = 'CENTER'
    o.data.materials.append(mat(name+"_m", color, 0.4, emit=color, es=0.55)); return o

def look(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def key(o, f, loc=None, scale=None, hide=None):
    if loc is not None: o.location = loc; o.keyframe_insert("location", frame=f)
    if scale is not None: o.scale = scale; o.keyframe_insert("scale", frame=f)
    if hide is not None: o.hide_render = hide; o.keyframe_insert("hide_render", frame=f)

def pop(o, f, s=1.0):
    key(o, max(1, f-1), scale=(0.001,)*3, hide=False)
    key(o, f+4, scale=(s*1.2,)*3); key(o, f+8, scale=(s,)*3)

def key_alpha(m, f, a):
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Alpha"].default_value = a
    b.inputs["Alpha"].keyframe_insert("default_value", frame=f)

scene, world_bg = clean()
WHITE = (0.92, 0.93, 0.95)
space_objs, street_objs = [], []

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

# ---------- earth + clouds + atmosphere ----------
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
key(pin, 1, hide=True); key(pin, 170, hide=False); key(pin, CUT, hide=False); key(pin, CUT+1, hide=True)

# ================= STREET (Edinburgh Old Town, local frame + offset) =================
def S(x, y, z): return (SX+x, SY+y, z)
stoneM = mat("Stone", (0.60, 0.56, 0.50), 0.85)
stoneD = mat("StoneD", (0.38, 0.35, 0.32), 0.9)
slateM = mat("Slate", (0.16, 0.17, 0.20), 0.7)
trimM  = mat("Trim", (0.88, 0.86, 0.82), 0.6)
glassM = mat("Glass", (0.12, 0.16, 0.22), 0.1, emit=(1.0, 0.75, 0.45), es=0.55)
doorM  = mat("Door", (0.22, 0.045, 0.035), 0.4)
asphM  = mat("Asphalt", (0.14, 0.14, 0.15), 0.95)
paveM  = mat("Pave", (0.42, 0.40, 0.37), 0.9)
ironM  = mat("Iron", (0.05, 0.05, 0.06), 0.5)

# main tenement: 10 wide, 7 deep, 8.5 tall, front plane y=0
street_objs.append(box("Tenement", S(0, 3.5, 4.25), (10, 7, 8.5), stoneM, 0.05))
street_objs.append(box("Plinth", S(0, -0.05, 0.5), (10.2, 0.5, 1.0), stoneD, 0.02))
street_objs.append(box("Cornice", S(0, 3.4, 7.9), (10.3, 7.2, 0.35), trimM, 0.03))
# pitched slate roof: two slabs + gable infill
for sx in (-1, 1):
    rb = box("Roof", S(sx*2.4, 3.5, 9.3), (5.6, 7.4, 0.25), slateM, 0.0)
    rb.rotation_euler = (0, math.radians(sx*28), 0); street_objs.append(rb)
street_objs.append(box("Gable", S(0, 3.5, 8.9), (9.6, 6.6, 1.6), stoneM, 0.0))
for cx in (-3.2, 3.2):
    street_objs.append(box("Chimney", S(cx, 4.0, 9.5), (1.1, 1.1, 2.4), stoneM, 0.02))
    for px in (-0.25, 0.25):
        street_objs.append(cyl("Pot", S(cx+px, 4.0, 10.9), 0.16, 0.7, stoneD, 10))
# windows: 4 bays x 3 floors; ground floor centre bays make way for the door
for iz, fz in enumerate([2.2, 4.4, 6.6]):
    for wx in (-3.6, -1.2, 1.2, 3.6):
        if iz == 0 and abs(wx) < 2.0:
            continue
        street_objs.append(box("Frame", S(wx, -0.06, fz+0.4), (1.0, 0.18, 1.7), trimM, 0.02))
        street_objs.append(box("Glass", S(wx, -0.08, fz+0.4), (0.78, 0.2, 1.45), glassM, 0.01))
        street_objs.append(box("Sill", S(wx, -0.12, fz-0.5), (1.15, 0.3, 0.12), trimM, 0.02))
        street_objs.append(box("MullionV", S(wx, -0.1, fz+0.4), (0.07, 0.22, 1.45), trimM, 0.0))
        street_objs.append(box("MullionH", S(wx, -0.1, fz+0.4), (0.78, 0.22, 0.07), trimM, 0.0))
# door surround: two jambs + lintel (a real opening) + fanlight; threshold on step 2
for jx in (-0.85, 0.85):
    street_objs.append(box("Jamb", S(jx, -0.08, 1.61), (0.35, 0.25, 2.48), trimM, 0.02))
street_objs.append(box("Lintel", S(0, -0.08, 3.1), (2.05, 0.25, 0.5), trimM, 0.02))
street_objs.append(box("FanGlass", S(0, -0.1, 2.85), (1.35, 0.2, 0.42), glassM, 0.01))
street_objs.append(box("Step1", S(0, -0.5, 0.09), (2.2, 0.9, 0.18), paveM, 0.02))
street_objs.append(box("Step2", S(0, -0.25, 0.27), (1.8, 0.5, 0.18), paveM, 0.02))
# railings flanking steps
for rx in (-1.35, 1.35):
    for rz in (0.35, 0.75, 1.15):
        street_objs.append(cyl("Rail", S(rx, -0.55, rz), 0.03, 0.08, ironM, 8))
    street_objs.append(box("RailTop", S(rx, -0.55, 1.2), (0.06, 1.0, 0.06), ironM, 0.0))
# door on pivot (opens at the end) + warm hall behind
# door: bmesh-authored mesh (zero operators), origin IS the hinge, panel spans local x 0..1.1
_dme = bpy.data.meshes.new("DoorMesh")
_dbm = bmesh.new()
bmesh.ops.create_cube(_dbm, size=1.0)
for _vv in _dbm.verts:
    _vv.co = ((_vv.co.x + 0.5) * 1.1, _vv.co.y * 0.12, (_vv.co.z + 0.5) * 2.3)
_dbm.to_mesh(_dme); _dbm.free()
door = bpy.data.objects.new("Door", _dme)
bpy.context.collection.objects.link(door)
door.location = S(-0.55, -0.12, 0.36)  # origin = hinge-bottom corner; panel spans z 0.36..2.66
door.data.materials.append(doorM)
street_objs.append(door)
brassM = mat("Brass", (0.72, 0.52, 0.2), 0.3)
knob = sphere("Knob", S(0.35, -0.22, 1.51), 0.05, brassM)
knob.parent = door; knob.location = (0.9, -0.10, 1.15)
street_objs.append(knob)
door.rotation_euler = (0, 0, 0); door.keyframe_insert("rotation_euler", frame=458)
door.rotation_euler = (0, 0, math.radians(-60)); door.keyframe_insert("rotation_euler", frame=480)
# warm hall glow just inside the opening + a small lamp that wakes as the door opens
hallM = mat("Hall", (1.0, 0.72, 0.42), 0.6, emit=(1.0, 0.7, 0.4), es=2.4)
hall = box("HallGlow", S(0, -0.03, 1.45), (1.05, 0.04, 2.3), hallM, 0.0); street_objs.append(hall)
key(hall, 1, hide=True); key(hall, 456, hide=False); key(hall, END, hide=False)
hd = bpy.data.lights.new("HallLamp", 'POINT'); hd.energy = 30.0; hd.color = (1.0, 0.72, 0.45)
ho = bpy.data.objects.new("HallLamp", hd); bpy.context.collection.objects.link(ho)
ho.location = S(0, 0.8, 2.0); street_objs.append(ho)
key(ho, 1, hide=True); key(ho, 456, hide=False); key(ho, END, hide=False)
# flanking buildings (darker, simpler)
for fx, fw, fh, fc in ((-9.5, 9, 7.0, (0.45,0.42,0.38)), (9.5, 9, 9.5, (0.5,0.44,0.38))):
    street_objs.append(box("Neigh", S(fx, 3.5, fh/2), (fw, 7, fh), mat(f"NeighM{fx}", fc, 0.9), 0.0))
    for wz in (2.2, 4.4, 6.4):
        if wz > fh-0.8: continue
        for wx in (fx-2.2, fx+2.2):
            street_objs.append(box("NGlass", S(wx, -0.05, wz), (1.0, 0.15, 1.5), glassM, 0.0))
# street: asphalt + pavements + lamp
street_objs.append(box("Road", S(0, -7.5, -0.05), (44, 13, 0.1), asphM, 0.0))
street_objs.append(box("Pave", S(0, -1.9, 0.02), (44, 2.6, 0.08), paveM, 0.0))
street_objs.append(cyl("LampPost", S(-5.5, -4.5, 2.5), 0.09, 5.0, ironM, 10))
lampM = mat("Lamp", (1.0, 0.8, 0.5), 0.4, emit=(1.0, 0.78, 0.5), es=3.0)
street_objs.append(sphere("LampHead", S(-5.5, -4.5, 5.2), 0.28, lampM))
ld = bpy.data.lights.new("LampLight", 'POINT'); ld.energy = 60; ld.color = (1.0, 0.78, 0.55)
lo = bpy.data.objects.new("LampLight", ld); bpy.context.collection.objects.link(lo)
lo.location = S(-5.5, -4.5, 5.0); street_objs.append(lo)
# street sun (daylight, swapped in after the flash)
sd2 = bpy.data.lights.new("SunStreet", 'SUN'); sd2.energy = 3.0
so2 = bpy.data.objects.new("SunStreet", sd2); bpy.context.collection.objects.link(so2)
so2.rotation_euler = (math.radians(50), 0, math.radians(-30))
key(so2, 1, hide=True); key(so2, CUT-6, hide=False); key(so2, END, hide=False)
key(so, CUT, hide=False); key(so, CUT+1, hide=True)

# visibility: street hidden during space phase, space hidden after cut
for o in street_objs:
    if o == hall: continue
    key(o, 1, hide=True); key(o, CUT-6, hide=False); key(o, END, hide=False)
for o in space_objs:
    key(o, CUT, hide=False); key(o, CUT+1, hide=True)
# world daylight transition
world_bg.inputs[1].default_value = 0.5; world_bg.inputs[1].keyframe_insert("default_value", frame=1)
world_bg.inputs[1].default_value = 0.5; world_bg.inputs[1].keyframe_insert("default_value", frame=CUT)
world_bg.inputs[1].default_value = 1.1; world_bg.inputs[1].keyframe_insert("default_value", frame=320)
world_bg.inputs[0].default_value = (0.004, 0.005, 0.012, 1)
world_bg.inputs[0].keyframe_insert("default_value", frame=CUT)
world_bg.inputs[0].default_value = (0.55, 0.62, 0.75, 1)
world_bg.inputs[0].keyframe_insert("default_value", frame=320)
so.data.energy = 4.0

# ================= CAMERA =================
cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 42
cam_data.clip_start = 0.01; cam_data.clip_end = 300
cam = bpy.data.objects.new("Camera", cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam
D0 = (E0.normalized() + Vector((0.55, -0.5, 0.4))).normalized()
D1 = E0.normalized()
d0, d1A = 7*R, R*1.3
SPIN = math.radians(10)
# phase A: orbital descent
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
# phase B: street swoop to the door (dense keys on a cubic path: no euler flips)
P0, P1, P2, P3 = (Vector(S(-16,-30,16)), Vector(S(-4,-9,4.5)),
                  Vector(S(-0.6,-2.4,1.9)), Vector(S(0.9,-1.75,1.7)))
T0, T1 = Vector(S(0,0,2.2)), Vector(S(-0.15,0.3,1.45))
for f in range(CUT, END+1, 4):
    t = (f-CUT)/(END-CUT)
    u = 1-t
    pos = u**3*P0 + 3*u*u*t*P1 + 3*u*t*t*P2 + t**3*P3
    s = t*t*(3-2*t)
    tgt = T0 + (T1-T0)*s
    cam.location = pos; look(cam, tgt)
    cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_euler", frame=f)

# flash card (masks the cut)
flashM = mat("Flash", (1,1,1), 1.0, emit=(1,1,1), es=3.0, alpha=0.0)
flash = box("Flash", (0,0,-1.0), (1.4, 1.4, 0.02), flashM, 0.0)
flash.parent = cam; flash.location = (0, 0, -1.0); flash.rotation_euler = (0,0,0)
key_alpha(flashM, 1, 0.0); key_alpha(flashM, CUT-8, 0.0); key_alpha(flashM, CUT-2, 1.0)
key_alpha(flashM, CUT+4, 1.0); key_alpha(flashM, CUT+12, 0.0); key_alpha(flashM, END, 0.0)

# captions (all camera-glued HUD)
def hcap(body, f0, f1, y=-0.58, size=0.09, color=WHITE):
    t = text("Cap", body, (0, 0, 0), size, color)
    t.parent = cam; t.location = (0, y, -3.2)
    key(t, f0-1, hide=True); key(t, f0, hide=False); key(t, f1, hide=False); key(t, f1+1, hide=True)
    return t
title = text("Title", "FROM SPACE TO A FRONT DOOR", (0, 0, 0), 0.17, WHITE)
title.parent = cam; title.location = (0, 0.1, -3.2)
key(title, 1, hide=False); key(title, 50, hide=False); key(title, 51, hide=True)
hcap("1   EARTH FROM SPACE", 51, 115)
hcap("2   NORTHERN EUROPE", 116, 165, color=(0.6, 0.85, 1))
hcap("3   SCOTLAND", 166, 215, color=(0.75, 0.9, 1))
hcap("4   EDINBURGH", 216, CUT, color=(1, 0.6, 0.55))
hcap("EDINBURGH — OLD TOWN", 262, 350, color=(1, 0.85, 0.6))
hcap("No. 42 — right to the front door", 351, END, color=(0.55, 1, 0.55))

for o in bpy.data.objects:
    if o.animation_data and o.animation_data.action:
        for fc in o.animation_data.action.fcurves:
            for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'

# self-check: door mesh sanity + doorway ray at a closed-door frame
scene.frame_set(400); bpy.context.view_layer.update()
_dg = bpy.context.evaluated_depsgraph_get()
_do = bpy.data.objects["Door"]
_ev = _do.evaluated_get(_dg)
_bbx = [tuple(round(v, 3) for v in vtx) for vtx in _ev.bound_box]
print("door eval bounds:", _bbx)
print("door prop loc:", tuple(round(v, 3) for v in _do.location),
      "matrix_world t:", tuple(round(v, 3) for v in _do.matrix_world.translation),
      "eval matrix t:", tuple(round(v, 3) for v in _ev.matrix_world.translation))
_hit, _loc, _n, _i, _obj, _m = scene.ray_cast(_dg, Vector(S(0, -3, 1.5)), Vector((0, 1, 0)), distance=10)
print("doorway ray hits:", _obj.name if _hit else None)
if not _hit or _obj.name != "Door":
    raise RuntimeError("DOOR SELF-CHECK FAILED")
scene.frame_set(1); bpy.context.view_layer.update()

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "zoom2_scene.blend"))
if TESTFRAME:
    scene.frame_set(TESTFRAME)
    scene.render.filepath = f"/tmp/zoom2_preview_{TESTFRAME}.png"
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("DONE zoom2 frames 1-480 ->", scene.render.filepath)
