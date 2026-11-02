"""
Clip 3 (12 s, 288 f @ 24 fps): cinematic zoom from space down to Edinburgh, Scotland.
  0-2.5s  whole Earth + cloud layer + stars
 2.5-5.5s push toward northern Europe
 5.5-8.5s through/past the cloud layer toward the British Isles, Scotland resolves
 8.5-12s  Edinburgh pin + label, hero hold
Run: blender -b --factory-startup --python-exit-code 1 -P build_zoom.py
Outputs (next to this script): space_to_edinburgh_12s.mp4, zoom_scene.blend
Needs: tex/earth_day.jpg, tex/earth_clouds.png (three.js planet textures)
"""
import bpy, math, random, os, sys
from mathutils import Vector

OUT = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(OUT, "tex")
FPS, END = 24, 288
rng = random.Random(11)
TESTFRAME = 0
for _a in sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []:
    if _a.startswith("testframe="): TESTFRAME = int(_a.split("=")[1])

R = 2.0
LAT, LON = math.radians(55.948), math.radians(-3.190)  # Edinburgh
E0 = Vector((math.cos(LAT)*math.cos(LON), math.cos(LAT)*math.sin(LON), math.sin(LAT))) * R

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
    s.render.filepath = os.path.join(OUT, "space_to_edinburgh_12s.mp4")
    s.world = bpy.data.worlds.new("W"); s.world.use_nodes = True
    s.world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.005, 0.012, 1)
    s.world.node_tree.nodes["Background"].inputs[1].default_value = 0.5
    for o in bpy.data.objects:
        if o.type == 'CAMERA' and o.data: o.data.clip_end = 300
    return s

def mat(name, color=(1,1,1), rough=0.6, emit=None, es=0.0, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Alpha"].default_value = alpha
    if emit: b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = es
    return m

def text(name, body, loc, size=0.3, color=(1,1,1), align='CENTER'):
    bpy.ops.object.text_add(location=loc)
    o = bpy.context.object; o.name = name; o.data.body = body
    o.data.size = size; o.data.align_x = align; o.data.align_y = 'CENTER'
    o.data.materials.append(mat(name+"_m", color, 0.4, emit=color, es=0.55)); return o

def look(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def key(o, f, loc=None, scale=None, hide=None, rot=None):
    if loc is not None: o.location = loc; o.keyframe_insert("location", frame=f)
    if rot is not None: o.rotation_euler = rot; o.keyframe_insert("rotation_euler", frame=f)
    if scale is not None: o.scale = scale; o.keyframe_insert("scale", frame=f)
    if hide is not None: o.hide_render = hide; o.keyframe_insert("hide_render", frame=f)

def pop(o, f, s=1.0):
    key(o, max(1, f-1), scale=(0.001,)*3, hide=False)
    key(o, f+4, scale=(s*1.2,)*3); key(o, f+8, scale=(s,)*3)

scene = clean()
WHITE = (0.92, 0.93, 0.95)

# ---------- stars ----------
import bmesh
sme = bpy.data.meshes.new("Stars"); sbm = bmesh.new()
faces = [(0,1,2),(0,2,3),(0,3,4),(0,4,1),(5,2,1),(5,3,2),(5,4,3),(5,1,4)]
for _ in range(1300):
    v = Vector((rng.gauss(0,1), rng.gauss(0,1), rng.gauss(0,1)))
    if v.length == 0: continue
    v.normalize(); p = v * rng.uniform(35, 70); r = rng.uniform(0.05, 0.16)
    tint = rng.choice([(1,1,1)]*7 + [(0.7,0.85,1),(1,0.9,0.75)])
    vs = [sbm.verts.new((p.x+dx*r, p.y+dy*r, p.z+dz*r)) for dx,dy,dz in
          [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
    for fc in faces: sbm.faces.new([vs[i] for i in fc])
sbm.to_mesh(sme)
stars = bpy.data.objects.new("Stars", sme); bpy.context.collection.objects.link(stars)
stars.data.materials.append(mat("StarM", (1,1,1), 0.5, emit=(1,1,1), es=1.6))

# ---------- earth with custom equirectangular UVs (u = (lon+180)/360, v = (lat+90)/180) ----------
bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=R, location=(0,0,0))
earth = bpy.context.object; earth.name = "Earth"
me = earth.data
uvl = me.uv_layers.new(name="EQ")
for poly in me.polygons:
    for li in poly.loop_indices:
        co = me.vertices[me.loops[li].vertex_index].co
        lon = math.degrees(math.atan2(co.y, co.x))
        lat = math.degrees(math.asin(max(-1, min(1, co.z / R))))
        uvl.data[li].uv = ((lon+180.0)/360.0, (lat+90.0)/180.0)
bpy.ops.object.shade_smooth()

day_img = bpy.data.images.load(os.path.join(TEX, "earth_day.jpg"))
day_img.colorspace_settings.name = 'sRGB'
em = mat("EarthM", (1,1,1), rough=0.62)
nt = em.node_tree; bsdf = nt.nodes["Principled BSDF"]
tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = day_img; tx.interpolation = 'Linear'
nt.links.new(tx.outputs["Color"], bsdf.inputs["Base Color"])
earth.data.materials.append(em)
earth.rotation_euler = (0, 0, 0)

# ---------- cloud layer ----------
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, radius=R*1.02, location=(0,0,0))
clouds = bpy.context.object; clouds.name = "Clouds"
cme = clouds.data
cuv = cme.uv_layers.new(name="EQ")
for poly in cme.polygons:
    for li in poly.loop_indices:
        co = cme.vertices[cme.loops[li].vertex_index].co
        lon = math.degrees(math.atan2(co.y, co.x))
        lat = math.degrees(math.asin(max(-1, min(1, co.z / (R*1.02)))))
        cuv.data[li].uv = ((lon+180.0)/360.0, (lat+90.0)/180.0)
bpy.ops.object.shade_smooth()
cl_img = bpy.data.images.load(os.path.join(TEX, "earth_clouds.png"))
cl_img.colorspace_settings.name = 'sRGB'
cm = mat("CloudM", (1,1,1), rough=0.9, alpha=1.0)
cnt = cm.node_tree; cbsdf = cnt.nodes["Principled BSDF"]
ctx = cnt.nodes.new("ShaderNodeTexImage"); ctx.image = cl_img
cnt.links.new(ctx.outputs["Color"], cbsdf.inputs["Base Color"])
cnt.links.new(ctx.outputs["Alpha"], cbsdf.inputs["Alpha"])
clouds.data.materials.append(cm)

# ---------- atmosphere rim ----------
bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=40, radius=R*1.045, location=(0,0,0))
atmo = bpy.context.object; atmo.name = "Atmo"
bpy.ops.object.shade_smooth()
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
atmo.data.materials.append(am)

# ---------- sun + fill ----------
sun_dir = (E0.normalized() + Vector((0.25, -0.2, 0.35))).normalized()
sd = bpy.data.lights.new("Sun", 'SUN'); sd.energy = 4.0
so = bpy.data.objects.new("Sun", sd); bpy.context.collection.objects.link(so)
so.rotation_euler = (-sun_dir).to_track_quat('-Z', 'Y').to_euler()
fd = bpy.data.lights.new("Fill", 'SUN'); fd.energy = 0.35; fd.color = (0.5, 0.65, 1.0)
fo = bpy.data.objects.new("Fill", fd); bpy.context.collection.objects.link(fo)
fo.rotation_euler = (sun_dir).to_track_quat('-Z', 'Y').to_euler()

# ---------- Edinburgh pin (child of earth so it rides the spin) ----------
pinM = mat("PinM", (1, 0.2, 0.25), 0.35, emit=(1, 0.2, 0.25), es=2.2)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.028, location=E0*1.005)
pin = bpy.context.object; pin.name = "Pin"; pin.data.materials.append(pinM)
pin.parent = earth; pin.matrix_parent_inverse.identity()
bpy.ops.mesh.primitive_torus_add(major_radius=0.05, minor_radius=0.008,
                                 location=E0*1.008, rotation=(0, 0, 0))
ring = bpy.context.object; ring.name = "PinRing"
ring.rotation_euler = (E0.normalized()).to_track_quat('Z', 'Y').to_euler()
ring.data.materials.append(pinM); ring.parent = earth; ring.matrix_parent_inverse.identity()
pop(ring, 225, 1.0)
# ring pulse at the end
key(ring, 240, scale=(1.0,)*3); key(ring, 262, scale=(3.2,)*3); key(ring, 263, scale=(0.001,)*3)
pop(ring, 264, 1.0); key(ring, 288, scale=(1.4,)*3)

# ---------- camera: exponential dolly, slerp direction D0 -> Edinburgh ----------
cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 40; cam_data.clip_end = 300; cam_data.clip_start = 0.01
cam = bpy.data.objects.new("Camera", cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam
D0 = (E0.normalized() + Vector((0.55, -0.5, 0.4))).normalized()
D1 = E0.normalized()
d0, d1 = 7*R, R*1.07
SPIN = math.radians(18)  # earth slow spin over the clip
for f in list(range(1, END+1, 12)) + [END]:
    t = (f-1)/(END-1)
    ang = SPIN * t
    ca, sa = math.cos(ang), math.sin(ang)
    E = Vector((E0.x*ca - E0.y*sa, E0.x*sa + E0.y*ca, E0.z))
    # slerp D0->D1
    dd = max(-1, min(1, D0.dot(D1)))
    om = math.acos(dd)
    if om < 1e-4: D = D1.copy()
    else: D = (D0*math.sin((1-t)*om) + D1*math.sin(t*om)) / math.sin(om)
    D.normalize()
    d = math.exp(math.log(d0)*(1-t) + math.log(d1)*t)
    pos = E + D * d
    tgt = E * (t**2)  # origin early, Edinburgh late
    cam.location = pos; look(cam, tgt)
    cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_euler", frame=f)
    earth.rotation_euler = (0, 0, ang); earth.keyframe_insert("rotation_euler", frame=f)
    clouds.rotation_euler = (0, 0, ang*1.6 + 0.15); clouds.keyframe_insert("rotation_euler", frame=f)

# Edinburgh floating label: follows E(t), +Z face kept toward the camera
elab = text("EdiLabel", "EDINBURGH  55.95N  3.19W", (0,0,0), 0.11, (1,0.45,0.5))
def cam_pose_at(f):
    t = (f-1)/(END-1)
    ang = SPIN * t
    ca, sa = math.cos(ang), math.sin(ang)
    E = Vector((E0.x*ca - E0.y*sa, E0.x*sa + E0.y*ca, E0.z))
    dd = max(-1, min(1, D0.dot(D1)))
    om = math.acos(dd)
    D = D1.copy() if om < 1e-4 else (D0*math.sin((1-t)*om) + D1*math.sin(t*om)) / math.sin(om)
    D.normalize()
    d = math.exp(math.log(d0)*(1-t) + math.log(d1)*t)
    return E + D*d, E
for f in list(range(200, END+1, 8)) + [END]:
    cpos, E = cam_pose_at(f)
    elab.location = E*1.06 + Vector((0.12, 0.05, 0.1))
    elab.rotation_euler = (cpos - elab.location).to_track_quat('Z', 'Y').to_euler()
    elab.keyframe_insert("location", frame=f); elab.keyframe_insert("rotation_euler", frame=f)
key(elab, 1, hide=True); key(elab, 205, hide=False); key(elab, 288, hide=False)

# thin-down clouds at the very end so the ground reads
cbsdf.inputs["Alpha"].default_value = 1.0
cbsdf.inputs["Alpha"].keyframe_insert("default_value", frame=230)
cbsdf.inputs["Alpha"].default_value = 0.45
cbsdf.inputs["Alpha"].keyframe_insert("default_value", frame=280)

# ---------- captions / titles (parented to camera so they track the dive) ----------
def caption(body, f0, f1, y=-0.72, size=0.11, color=WHITE):
    t = text("Cap", body, (0, 0, 0), size, color)
    t.parent = cam; t.location = (0, y, -3.2)
    key(t, f0-1, hide=True); key(t, f0, hide=False); key(t, f1, hide=False); key(t, f1+1, hide=True)
    return t

title = text("Title", "FROM SPACE TO SCOTLAND", (0, 0, 0), 0.19, WHITE)
title.parent = cam; title.location = (0, 0.15, -3.2)
key(title, 1, hide=False); key(title, 46, hide=False); key(title, 47, hide=True)
caption("1   EARTH — blue marble + cloud layer", 48, 100)
caption("2   NORTHERN EUROPE", 101, 165, color=(0.6, 0.85, 1))
caption("3   THROUGH THE CLOUDS — the British Isles", 166, 222, color=(0.75, 0.9, 1))
caption("4   SCOTLAND — EDINBURGH", 223, 288, color=(1, 0.55, 0.55))

for o in bpy.data.objects:
    if o.animation_data and o.animation_data.action:
        for fc in o.animation_data.action.fcurves:
            for kp in fc.keyframe_points: kp.interpolation = 'BEZIER'

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "zoom_scene.blend"))
if TESTFRAME:
    scene.frame_set(TESTFRAME)
    scene.render.filepath = f"/tmp/zoom_preview_{TESTFRAME}.png"
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("DONE zoom frames 1-288 ->", scene.render.filepath)
