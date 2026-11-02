"""
Clip 2 (10 s, 240 f @ 24 fps): SAM segments a photo, masks are lifted onto the 3D point cloud.
  0-2.5s  a photo of house/tree/car/road/sky; prompt points are clicked
 2.5-6s   SAM masks colour in one class at a time, with labels
  6-10s   beams carry each mask to the point cloud; points take the class colour; hero orbit + legend
Run: blender -b --factory-startup --python-exit-code 1 -P build_sam.py
Outputs (next to this script): sam_classification_10s.mp4, sam_scene.blend
"""
import bpy, math, random, os, sys
from mathutils import Vector
TESTFRAME = 0
for _a in sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []:
    if _a.startswith("testframe="): TESTFRAME = int(_a.split("=")[1])

OUT = os.path.dirname(os.path.abspath(__file__))
FPS, END = 24, 240
rng = random.Random(7)

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
    s.render.filepath = os.path.join(OUT, "sam_classification_10s.mp4")
    s.world = bpy.data.worlds.new("W"); s.world.use_nodes = True
    s.world.node_tree.nodes["Background"].inputs[0].default_value = (0.012, 0.016, 0.03, 1)
    s.world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    return s

def mat(name, color, rough=0.55, metal=0.0, emit=None, es=0.0, alpha=1.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    b.inputs["Alpha"].default_value = alpha
    if emit: b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = es
    if alpha < 1: m.surface_render_method = 'DITHERED'
    return m

def box(name, loc, size, material, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object; o.name = name; o.dimensions = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("b", 'BEVEL'); mod.width = bevel; mod.segments = 2
    o.data.materials.append(material); return o

def cyl(name, loc, r, h, material, verts=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc)
    o = bpy.context.object; o.name = name; o.data.materials.append(material); return o

def sphere(name, loc, r, material, scale=(1,1,1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=18, ring_count=10)
    o = bpy.context.object; o.name = name; o.scale = scale; o.data.materials.append(material)
    bpy.ops.object.shade_smooth(); return o

def text(name, body, loc, size=0.3, color=(1,1,1), align='LEFT'):
    bpy.ops.object.text_add(location=loc)
    o = bpy.context.object; o.name = name; o.data.body = body
    o.data.size = size; o.data.align_x = align; o.data.align_y = 'CENTER'
    m = mat(name+"_m", color, rough=0.4, emit=color, es=0.55); o.data.materials.append(m); return o

def look(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def key(o, f, loc=None, scale=None, hide=None):
    if loc is not None: o.location = loc; o.keyframe_insert("location", frame=f)
    if scale is not None: o.scale = scale; o.keyframe_insert("scale", frame=f)
    if hide is not None: o.hide_render = hide; o.keyframe_insert("hide_render", frame=f)

def pop(o, f, s=1.0):
    key(o, max(1, f-1), scale=(0.001,)*3, hide=False)
    key(o, f+4, scale=(s*1.2,)*3); key(o, f+8, scale=(s,)*3)

def beam(name, a, b, r, material):
    a, b = Vector(a), Vector(b); d = b-a
    o = cyl(name, (a+b)/2, r, d.length, material, verts=8)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler(); return o

def cloud_obj(name, pts, radius, material):
    """merged octahedra, single material (colour animated via material)."""
    import bmesh
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    faces = [(0,1,2),(0,2,3),(0,3,4),(0,4,1),(5,2,1),(5,3,2),(5,4,3),(5,1,4)]
    for (x,y,z) in pts:
        vs=[bm.verts.new((x+dx*radius,y+dy*radius,z+dz*radius)) for dx,dy,dz in [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
        for f in faces: bm.faces.new([vs[i] for i in f])
    bm.to_mesh(me)
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    o.data.materials.append(material); return o

def key_mat_color(m, f, color, es=None):
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Base Color"].keyframe_insert("default_value", frame=f)
    if es is not None:
        b.inputs["Emission Color"].default_value = (*color, 1)
        b.inputs["Emission Color"].keyframe_insert("default_value", frame=f)
        b.inputs["Emission Strength"].default_value = es
        b.inputs["Emission Strength"].keyframe_insert("default_value", frame=f)

scene = clean()
WHITE=(0.92,0.93,0.95)
# classes: name, colour, grey (photo before SAM)
CLASSES = [
    ("SKY",   (0.35,0.65,1.0)),
    ("HOUSE", (1.0,0.55,0.25)),
    ("TREE",  (0.35,0.9,0.4)),
    ("CAR",   (1.0,0.3,0.55)),
    ("ROAD",  (0.95,0.85,0.3)),
]
GREY = (0.42,0.44,0.47)

box("Ground",(0,0,-0.06),(18,16,0.12), mat("GroundM",(0.05,0.07,0.06),0.95), bevel=0)

def light(name, loc, energy, size=4, color=(1,1,1)):
    d=bpy.data.lights.new(name,'AREA'); d.energy=energy; d.shape='DISK'; d.size=size; d.color=color
    o=bpy.data.objects.new(name,d); bpy.context.collection.objects.link(o); o.location=loc; look(o,(0,0,1)); return o
light("Key",(5,-6,9),900,6); light("Fill",(-7,-3,5),350,5,(0.6,0.75,1))

cam_data=bpy.data.cameras.new("Cam"); cam_data.lens=42
cam=bpy.data.objects.new("Camera",cam_data); bpy.context.collection.objects.link(cam); scene.camera=cam
for f,loc in [(1,(0,-13.5,5.2)),(140,(0,-13.5,5.2)),(200,(6,-11,5.0)),(240,(9,-6,4.6))]:
    cam.location=loc; look(cam,(0.4,0,1.4)); cam.keyframe_insert("location",frame=f); cam.keyframe_insert("rotation_euler",frame=f)

def caption(body,f0,f1,size=0.3,color=WHITE):
    t=text("Cap",body,(0,-4.2,0.7),size,color,align='CENTER')
    t.rotation_euler = (math.radians(90),0,0)  # stand up, face camera at -Y
    key(t,f0-1,hide=True); key(t,f0,hide=False); key(t,f1,hide=False); key(t,f1+1,hide=True); return t
title=text("Title","SAM  ->  SEMANTIC POINT CLOUD",(0,0,5.15),0.46,WHITE,align='CENTER')
key(title,1,hide=False); key(title,44,hide=False); key(title,45,hide=True)
caption("1   PROMPT — click points on what you want",45,78)
caption("2   SEGMENT — SAM masks each region",79,143,color=(0.6,0.85,1))
c3 = caption("3   LIFT TO 3D — mask labels land on points",144,240,color=(0.55,1,0.55))
c3.parent = cam; c3.location = (0,-0.58,-3.2); c3.rotation_euler = (0,0,0); c3.data.size = 0.09

# ---------- LEFT: photo panel (x ~ -3.4, facing camera -Y) ----------
PX, PZ = -3.3, 2.15   # photo centre
panel = box("PhotoPanel",(PX,0,PZ),(4.6,0.08,3.2), mat("Panel",(0.16,0.18,0.22),0.4,emit=(0.1,0.12,0.16),es=0.4),0.03)
plabel = text("PhotoLabel","PHOTO",(PX,0,PZ+1.85),0.26,WHITE,align='CENTER')
# photo regions as flat plates on panel front (y=-0.07), initially grey, colour-in per class
# local coords within panel: x in [-2.1,2.1], z in [-1.4,1.4] rel to centre
regions = {
 "SKY":   [ (PX, -0.09, PZ+0.95, 4.2, 0.85) ],
 "HOUSE": [ (PX-0.75, -0.09, PZ-0.05, 1.9, 1.15), (PX-0.75,-0.09,PZ+0.72,1.4,0.5) ],  # walls + roof block
 "TREE":  [ (PX+1.25, -0.09, PZ+0.15, 1.0, 1.35) ],
 "CAR":   [ (PX+0.95, -0.09, PZ-0.85, 1.35, 0.62) ],
 "ROAD":  [ (PX, -0.09, PZ-1.28, 4.2, 0.42) ],
}
region_objs={}; class_mats={}
photo_anchor={}  # a 3D point on panel per class for beams
for cname, col in CLASSES:
    m = mat(f"Region_{cname}", GREY, 0.35, emit=GREY, es=0.15); class_mats[cname]=m
    objs=[]
    for (x,y,z,w,h) in regions[cname]:
        o = box(f"Reg_{cname}",(x,y,z),(w,0.05,h), m, 0.02); objs.append(o)
    region_objs[cname]=objs
    cx = sum(r[0] for r in regions[cname])/len(regions[cname]); cz = sum(r[2] for r in regions[cname])/len(regions[cname])
    photo_anchor[cname]=(cx,-0.15,cz)

# prompt clicks: white dot + ring pulse on each region, staggered in phase 1
ringM = mat("Ring",(1,1,1),0.3,emit=(1,1,1),es=2.0)
for i,(cname,col) in enumerate(CLASSES):
    a = photo_anchor[cname]
    dot = sphere(f"Prompt_{cname}",(a[0],-0.22,a[2]),0.07,ringM); dot.scale=(0.001,)*3
    f = 48+i*6
    pop(dot,f); key(dot,80,scale=(1,)*3); key(dot,86,scale=(0.001,)*3)
    # expanding ring: torus scaled up & repeated once
    bpy.ops.mesh.primitive_torus_add(major_radius=0.16, minor_radius=0.02, location=(a[0],-0.22,a[2]))
    ring=bpy.context.object; ring.name=f"Ring_{cname}"; ring.data.materials.append(ringM); ring.scale=(0.001,)*3
    key(ring,f,scale=(0.4,)*3); key(ring,f+10,scale=(2.2,)*3); key(ring,f+11,scale=(0.001,)*3)

# ---------- RIGHT: 3D point cloud scene (x ~ +2.6), grey -> class colours ----------
CX = 2.7  # cloud centre x offset
def house_pts():
    pts={"HOUSE":[],"TREE":[],"CAR":[],"ROAD":[],"SKY":[]}
    for x in [i*0.3-1.4 for i in range(10)]:
        for z in [0.15+i*0.28 for i in range(7)]:
            pts["HOUSE"].append((CX+x,-0.9,z)); pts["HOUSE"].append((CX+x,0.9,z))
    for t in [i/10 for i in range(11)]:
        for y in [i*0.28-1.1 for i in range(8)]:
            pts["HOUSE"].append((CX-1.5+1.5*t,y,1.95+1.3*t)); pts["HOUSE"].append((CX+1.5-1.5*t,y,1.95+1.3*t))
    for cx,cy,cz,r,n in [(CX+1.9,0.8,1.9,0.8,70),(CX+1.45,0.65,1.5,0.5,35),(CX+2.35,0.95,1.55,0.5,35)]:
        for _ in range(n):
            v=Vector((rng.gauss(0,1),rng.gauss(0,1),rng.gauss(0,1)))
            if v.length==0: continue
            v.normalize(); pts["TREE"].append((cx+v.x*r*rng.uniform(.5,1),cy+v.y*r*rng.uniform(.5,1),cz+v.z*r*.9*rng.uniform(.5,1)))
    for z in [0.12+i*0.22 for i in range(6)]: pts["TREE"].append((CX+1.9,0.8,z))
    # car: body box surface + cabin
    for x in [i*0.22-0.75 for i in range(8)]:
        for zz in (0.35,0.75): pts["CAR"].append((CX+0.4+x,1.6,zz))
        pts["CAR"].append((CX+0.4+x,1.25,0.75)); pts["CAR"].append((CX+0.4+x,1.95,0.75))
    for x in [i*0.22-0.4 for i in range(5)]:
        pts["CAR"].append((CX+0.4+x,1.6,1.05))
    for wx in (-0.55,0.55):
        for k in range(8):
            a=2*math.pi*k/8; pts["CAR"].append((CX+0.4+wx,1.28,0.32+0.3*math.sin(a)))  # wheel hint (x-z plane approx)
    # road: flat strip in front
    for _ in range(90): pts["ROAD"].append((CX+rng.uniform(-2.4,2.4), rng.uniform(1.8,3.0), 0.03))
    for _ in range(40): pts["ROAD"].append((CX+rng.uniform(-2.4,2.4), rng.uniform(-2.6,-1.6), 0.03))
    # sky: backdrop arc of points high behind
    for _ in range(45): pts["SKY"].append((CX+rng.uniform(-2.6,2.6), 2.6, rng.uniform(3.4,4.6)))
    return pts

pts_by_class = house_pts()
cloud_anchor={}
cloud_mats={}; cloud_objs={}
for cname,col in CLASSES:
    m = mat(f"Cloud_{cname}", GREY, 0.45, emit=GREY, es=0.12)
    o = cloud_obj(f"CloudPts_{cname}", pts_by_class[cname], 0.055, m)
    cloud_mats[cname]=m; cloud_objs[cname]=o
    pp=pts_by_class[cname]
    cloud_anchor[cname]=(sum(p[0] for p in pp)/len(pp), sum(p[1] for p in pp)/len(pp), sum(p[2] for p in pp)/len(pp))

cloudlabel = text("CloudLabel","POINT CLOUD",(CX,-0.5,4.0),0.26,WHITE,align='CENTER')
# grey cloud is present from start (dim), pulses as labels land

# ---------- animation of classes: mask colour-in, then beam, then cloud colour ----------
# phase2 frames: SKY 84, HOUSE 96, TREE 108, CAR 120, ROAD 132 ; phase3 beams offset +62
for i,(cname,col) in enumerate(CLASSES):
    f_mask = 84+i*12
    # region material grey -> class colour (animated)
    key_mat_color(class_mats[cname], f_mask-1, GREY, 0.15)
    key_mat_color(class_mats[cname], f_mask+6, col, 0.7)
    # class label next to photo region
    a=photo_anchor[cname]
    lab = text(f"Lab_{cname}", cname,(a[0],-0.3,a[2]+0.42),0.21,col,align='CENTER')
    key(lab,1,hide=True); key(lab,f_mask+4,hide=False); key(lab,240,hide=False)
    # beam photo -> cloud + cloud recolours
    f_beam = 150+i*13
    bm_ = beam(f"Beam_{cname}", photo_anchor[cname], cloud_anchor[cname], 0.03,
               mat(f"BeamM_{cname}", col, 0.4, alpha=0.65, emit=col, es=1.4))
    bm_.scale=(0.001,)*3; pop(bm_, f_beam); key(bm_, f_beam+16, scale=(1,)*3); key(bm_, f_beam+22, scale=(0.001,)*3)
    key_mat_color(cloud_mats[cname], f_beam+6, GREY, 0.12)
    key_mat_color(cloud_mats[cname], f_beam+14, col, 0.55)
    # legend HUD (bottom-left, glued to camera so the orbit can't lose it)
    ly = -0.02 - i*0.13
    sw = box(f"Legend_{cname}",(0,0,0),(0.07,0.02,0.07), mat(f"LegM_{cname}",col,0.4,emit=col,es=0.7),0.01)
    sw.parent = cam; sw.location = (-1.25,ly,-3.2)
    sw.scale=(0.001,)*3; pop(sw, f_beam+8)
    lt = text(f"LegT_{cname}", cname,(0,0,0),0.06,col,align='LEFT')
    lt.parent = cam; lt.location = (-1.19,ly,-3.2); lt.rotation_euler = (0,0,0)
    key(lt,1,hide=True); key(lt,f_beam+10,hide=False); key(lt,240,hide=False)

end = text("End","SEMANTIC POINT CLOUD — typed points",(0,0,5.15),0.3,(0.55,1,0.55),align='CENTER')
key(end,1,hide=True); key(end,222,hide=False); key(end,240,hide=False)
end.parent = cam; end.location = (0,0.3,-3.2); end.rotation_euler = (0,0,0); end.data.size = 0.1

for o in bpy.data.objects:
    if o.animation_data and o.animation_data.action:
        for fc in o.animation_data.action.fcurves:
            for kp in fc.keyframe_points: kp.interpolation='BEZIER'

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,"sam_scene.blend"))
if TESTFRAME:
    scene.frame_set(TESTFRAME)
    scene.render.filepath = f"/tmp/sam_preview_{TESTFRAME}.png"
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("DONE sam frames 1-240 ->", scene.render.filepath,
      "points:", {k: len(v) for k,v in pts_by_class.items()})
