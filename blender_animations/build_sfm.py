"""
Clip 1 (15 s, 360 f @ 24 fps): How Structure-from-Motion builds a point cloud.
  0-3s   cameras orbit a house+tree taking overlapping photos
  3-6s   feature points detected, matched between views
  6-10s  triangulation rays from cameras converge -> sparse points
 10-15s  densification: solid scene fades, dense point cloud remains, orbiting hero shot
Run: blender -b --factory-startup --python-exit-code 1 -P build_sfm.py
Outputs (next to this script): sfm_pointcloud_15s.mp4, sfm_scene.blend
"""
import bpy, math, random, os, sys
from mathutils import Vector
TESTFRAME = 0
for _a in sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []:
    if _a.startswith("testframe="): TESTFRAME = int(_a.split("=")[1])

OUT = os.path.dirname(os.path.abspath(__file__))
FPS, END = 24, 360
rng = random.Random(42)

# ---------- helpers ----------
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
    s.render.fps = FPS
    s.frame_start, s.frame_end = 1, END
    s.render.image_settings.file_format = 'FFMPEG'
    s.render.ffmpeg.format = 'MPEG4'; s.render.ffmpeg.codec = 'H264'
    s.render.ffmpeg.constant_rate_factor = 'HIGH'; s.render.ffmpeg.ffmpeg_preset = 'GOOD'
    s.render.filepath = os.path.join(OUT, "sfm_pointcloud_15s.mp4")
    s.render.film_transparent = False
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

def box(name, loc, size, material, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object; o.name = name; o.dimensions = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new("b", 'BEVEL'); mod.width = bevel; mod.segments = 2
    o.data.materials.append(material); return o

def cyl(name, loc, r, h, material, verts=20):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc)
    o = bpy.context.object; o.name = name; o.data.materials.append(material); return o

def sphere(name, loc, r, material, scale=(1,1,1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=20, ring_count=12)
    o = bpy.context.object; o.name = name; o.scale = scale; o.data.materials.append(material)
    bpy.ops.object.shade_smooth(); return o

def cone(name, loc, r, h, material):
    bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=0, depth=h, location=loc, vertices=4)
    o = bpy.context.object; o.name = name; o.data.materials.append(material); return o

def text(name, body, loc, size=0.32, color=(1,1,1), align='LEFT'):
    bpy.ops.object.text_add(location=loc)
    o = bpy.context.object; o.name = name; o.data.body = body
    o.data.size = size; o.data.align_x = align; o.data.align_y = 'CENTER'
    o.rotation_euler = (math.radians(90), 0, 0)
    m = mat(name+"_m", color, rough=0.4, emit=color, es=0.55)
    o.data.materials.append(m); return o

def look(o, target):
    o.rotation_euler = (Vector(target) - o.location).to_track_quat('-Z', 'Y').to_euler()

def key(o, f, loc=None, scale=None, hide=None):
    if loc is not None: o.location = loc; o.keyframe_insert("location", frame=f)
    if scale is not None: o.scale = scale; o.keyframe_insert("scale", frame=f)
    if hide is not None: o.hide_render = hide; o.keyframe_insert("hide_render", frame=f)

def pop(o, f, s=1.0):
    """scale 0 -> s at frame f (with a 6-frame ease by keying an overshoot)."""
    key(o, max(1, f-1), scale=(0.001,)*3, hide=False)
    key(o, f+4, scale=(s*1.25,)*3); key(o, f+8, scale=(s,)*3)

def beam(name, a, b, r, material):
    """thin cylinder between two points"""
    a, b = Vector(a), Vector(b); mid = (a+b)/2; d = b-a
    o = cyl(name, mid, r, d.length, material, verts=8)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler(); return o

def point_cloud(name, pts, radius=0.05):
    """pts: [(x,y,z,(r,g,b))] -> one merged octahedra mesh with vertex colours."""
    import bmesh
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    col = None
    faces = [(0,1,2),(0,2,3),(0,3,4),(0,4,1),(5,2,1),(5,3,2),(5,4,3),(5,1,4)]
    for (x, y, z, c) in pts:
        vs = [bm.verts.new((x+dx*radius, y+dy*radius, z+dz*radius))
              for dx, dy, dz in [(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]]
        for f in faces: bm.faces.new([vs[i] for i in f])
        for v in vs: v.tag = True
    bm.to_mesh(me)
    # vertex colours via attribute after build (per-vertex from nearest centre is overkill:
    # colour by face centroid lookup)
    attr = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    # rebuild colour by matching vertex position to point centre grid
    lut = {}
    for (x, y, z, c) in pts: lut[(round(x,2), round(y,2), round(z,2))] = c
    # octahedron verts are offset; colour by closest point centre
    import math as _m
    for i, v in enumerate(me.vertices):
        best, bd = (0.8,0.8,0.8), 1e9
        for (x, y, z, c) in pts:
            d = (v.co.x-x)**2 + (v.co.y-y)**2 + (v.co.z-z)**2
            if d < bd: bd, best = d, c
        attr.data[i].color = (*best, 1)
    m = bpy.data.materials.new(name+"_m"); m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]; bsdf.inputs["Roughness"].default_value = 0.5
    vc = m.node_tree.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "Col"
    m.node_tree.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    o.data.materials.append(m); return o

# ---------- scene ----------
scene = clean()
WHITE=(0.92,0.93,0.95); YEL=(1,0.75,0.1); CYAN=(0.2,0.85,1); ORANGE=(1,0.45,0.15)

# ground + grid feel
ground = box("Ground", (0,0,-0.06), (16,16,0.12), mat("GroundM",(0.05,0.07,0.06),0.95), bevel=0)

# house: walls, roof (prism via cone 4-sided rotated), door, windows
wallM = mat("Wall",(0.82,0.78,0.70),0.7); roofM = mat("Roof",(0.62,0.22,0.14),0.6)
winM  = mat("Win",(0.25,0.55,0.75),0.15,0.1,emit=(0.3,0.6,0.9),es=0.4)
house = []
house.append(box("Walls",(0,0,1.0),(3.2,2.6,2.0),wallM,0.04))
roof = cone("Roof",(0,0,2.75),2.55,1.5,roofM); roof.rotation_euler=(0,0,math.radians(45)); roof.scale=(1.05,0.85,1); house.append(roof)
house.append(box("Door",(0,-1.32,0.65),(0.6,0.06,1.3),mat("Door",(0.3,0.18,0.1),0.6),0.02))
for wx in (-0.9,0.9):
    house.append(box("Window", (wx,-1.32,1.35),(0.62,0.06,0.62),winM,0.02))
    house.append(box("WindowS",(wx,1.32,1.35),(0.62,0.06,0.62),winM,0.02))
house.append(cyl("Chimney",(0.9,0.5,3.3),0.18,0.9,wallM))

# tree
tree=[]
tree.append(cyl("Trunk",(2.9,1.4,0.7),0.14,1.4,mat("Bark",(0.32,0.2,0.11),0.9)))
leafM = mat("Leaf",(0.16,0.5,0.2),0.8)
for loc,r in [((2.9,1.4,2.1),0.95),((2.35,1.25,1.75),0.6),((3.45,1.55,1.8),0.62)]:
    tree.append(sphere("Leaves",loc,r,leafM,scale=(1,1,0.9)))
# low wall / fence for extra features
for i in range(5):
    house.append(box("Fence",(-3.4+i*0.55,2.2,0.35),(0.42,0.08,0.7),mat("Fence",(0.55,0.42,0.3),0.8),0.02))

# lights + hero camera
def light(name, loc, energy, size=4, color=(1,1,1)):
    d = bpy.data.lights.new(name,'AREA'); d.energy=energy; d.shape='DISK'; d.size=size; d.color=color
    o = bpy.data.objects.new(name,d); bpy.context.collection.objects.link(o); o.location=loc; look(o,(0,0,1)); return o
light("Key",(5,-6,9),900,6); light("Fill",(-7,-3,5),350,5,(0.6,0.75,1)); light("Rim",(2,7,6),500,4,(1,0.8,0.6))

cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 42
cam = bpy.data.objects.new("Camera", cam_data); bpy.context.collection.objects.link(cam)
scene.camera = cam
# camera: mostly fixed 3/4 view, slow push-in, final orbit in last phase (set below per-phase)
cam_keys = [(1,(8.5,-10.5,5.5)),(150,(8.5,-10.5,5.5)),(250,(7.5,-9.5,5.0)),
            (300,(9,-7,4.2)),(330,(10.5,-1,4.6)),(360,(8.5,6.5,5.2))]
for f,loc in cam_keys: cam.location=loc; look(cam,(0,0,1.2)); cam.keyframe_insert("location",frame=f); cam.keyframe_insert("rotation_euler",frame=f)

# titles / captions (facing camera: rotation x=90 makes text stand in XZ? text_add faces +Z; rotate to face -Y camera)
def caption(body, f0, f1, size=0.3, y=-4.2, z=0.7, color=WHITE, x=0.0):
    t = text("Cap", body, (x,y,z), size, color, align='CENTER')
    t.rotation_euler = (math.radians(90),0,0)  # stand up, face camera at -Y
    key(t, f0-1, hide=True); key(t, f0, hide=False); key(t, f1, hide=False); key(t, f1+1, hide=True)
    return t
title = text("Title","STRUCTURE FROM MOTION",(0,0,4.6),0.52,WHITE,align='CENTER')
key(title,1,hide=False); key(title,52,hide=False); key(title,53,hide=True)
sub = text("Sub","overlapping photos  ->  3D point cloud",(0,0,3.95),0.27,CYAN,align='CENTER')
key(sub,1,hide=False); key(sub,52,hide=False); key(sub,53,hide=True)

caption("1   CAPTURE — cameras take overlapping photos", 54, 118)
caption("2   MATCH — same features found in many views", 119, 183, color=YEL)
caption("3   TRIANGULATE — rays intersect in 3D", 184, 263, color=CYAN)
c4 = caption("4   DENSIFY — a full point cloud", 264, 360, color=(0.55,1,0.55))
c4.parent = cam; c4.location = (0,-0.55,-3.2); c4.rotation_euler = (0,0,0); c4.data.size = 0.09

# --- orbiting photo cameras (rigs) ---
camBodyM = mat("CamBody",(0.08,0.09,0.11),0.35,0.4)
frustumM = mat("Frustum",(0.3,0.7,1),0.4,alpha=0.16,emit=(0.3,0.7,1),es=0.3)
lensM = mat("Lens",(0.1,0.2,0.35),0.1,0.6,emit=(0.4,0.7,1),es=1.2)
rigs=[]
NCAM=6
for i in range(NCAM):
    g = bpy.data.objects.new(f"Rig{i}", None); bpy.context.collection.objects.link(g)
    body = box(f"CamBody{i}",(0,0,0),(0.55,0.35,0.35),camBodyM,0.05); body.parent=g
    lens = cyl(f"Lens{i}",(0,-0.25,0),0.11,0.18,lensM); lens.rotation_euler=(math.radians(90),0,0); lens.parent=g
    # frustum: cone pointing -Y (towards scene centre when rig looks at centre)
    fr = cone(f"Frustum{i}",(0,-1.05,0),0.95,1.8,frustumM); fr.rotation_euler=(math.radians(-90),0,0); fr.parent=g
    flash = sphere(f"Flash{i}",(0,-0.35,0.25),0.16,mat(f"FlashM{i}",(1,0.95,0.7),0.3,emit=(1,0.95,0.7),es=6)); flash.parent=g
    flash.scale=(0.001,)*3
    # photo thumbnail plane that pops at capture
    ph = box(f"Photo{i}",(0.0,0,0.75),(0.85,0.04,0.55),mat(f"PhotoM{i}",(0.75,0.8,0.85),0.3,emit=(0.5,0.65,0.8),es=0.35),0.01); ph.parent=g
    ph.scale=(0.001,)*3
    rigs.append((g,flash,ph))

# animate rigs around circle, staggered; freeze after frame 184 (triangulation uses final poses)
rig_pose={}
for i,(g,flash,ph) in enumerate(rigs):
    phase = i*(360/NCAM)
    for f in range(1, 190, 12):
        ang = math.radians(phase + (f-1)*0.9)   # slow orbit
        loc = (5.6*math.cos(ang), 5.6*math.sin(ang), 3.1+0.5*math.sin(math.radians(phase)+f*0.03))
        g.location=loc; look(g,(0,0,1.1)); g.keyframe_insert("location",frame=f); g.keyframe_insert("rotation_euler",frame=f)
        if f==181: rig_pose[i]=loc
    # hold final pose to end
    g.location=rig_pose[i]; look(g,(0,0,1.1)); g.keyframe_insert("location",frame=360); g.keyframe_insert("rotation_euler",frame=360)
    # captures: flash + photo pop 3 times during phase 1
    for cf in (58+i*9, 84+i*9, 108+i*6):
        if cf>116: cf=116
        key(flash, cf-2, scale=(0.001,)*3); key(flash, cf, scale=(1.6,)*3); key(flash, cf+5, scale=(0.001,)*3)
        pop(ph, cf+2, 1.0); key(ph, cf+26, scale=(1,)*3); key(ph, cf+30, scale=(0.001,)*3)
    # frustums+rigs fade out in phase 4 (scale down)
    key(g, 268, scale=(1,)*3); key(g, 285, scale=(0.001,)*3)

# --- feature points on house/tree/fence surfaces ---
featM = mat("Feat",(1,0.8,0.15),0.3,emit=(1,0.75,0.1),es=2.5)
features=[]
feat_pts=[(-1.6,-1.31,1.9),(1.6,-1.31,1.9),(-1.6,-1.31,0.15),(1.6,-1.31,0.15),
 (-0.9,-1.36,1.66),(0.9,-1.36,1.66),(-0.9,-1.36,1.04),(0.9,-1.36,1.04),
 (0,-1.36,1.3),(0,-1.36,0.05),(-1.2,-1.05,2.55),(1.2,-1.05,2.55),(0,0,3.45),
 (0.9,0.5,3.75),(2.9,1.0,2.6),(2.3,1.1,1.9),(3.5,1.7,2.0),(2.9,0.75,1.5),
 (-3.4,2.15,0.7),(-2.3,2.15,0.7),(-1.2,2.15,0.7),(1.55,0.9,1.9),(-1.55,0.9,1.9)]
for i,p in enumerate(feat_pts):
    s = sphere(f"Feat{i}", p, 0.075, featM); s.scale=(0.001,)*3
    pop(s, 122+i*2); key(s, 262, scale=(1,)*3); key(s, 272, scale=(0.001,)*3)
    features.append(p)

# match lines between feature pairs (thin yellow beams, phase 2)
matchM = mat("Match",(1,0.75,0.2),0.4,alpha=0.55,emit=(1,0.7,0.15),es=0.8)
pairs=[(0,4),(4,6),(1,5),(5,7),(2,8),(3,9),(10,12),(11,12),(14,15),(15,17),(18,19),(19,20)]
for i,(a,b) in enumerate(pairs):
    bm_ = beam(f"Match{i}", feat_pts[a], feat_pts[b], 0.016, matchM); bm_.scale=(0.001,)*3
    pop(bm_, 140+i*3); key(bm_, 180, scale=(1,)*3); key(bm_, 188, scale=(0.001,)*3)

# --- triangulation rays (phase 3): from 3 rigs to subset of features ---
rayM = mat("Ray",(0.25,0.85,1),0.4,alpha=0.5,emit=(0.25,0.8,1),es=0.9)
sparse_pts=[]
for i,p in enumerate(feat_pts):
    for ri in (0,2,4):
        if (i+ri) % 3: continue
        r = beam(f"Ray{i}_{ri}", rig_pose[ri], p, 0.013, rayM); r.scale=(0.001,)*3
        pop(r, 190+i*2); key(r, 252, scale=(1,)*3); key(r, 262, scale=(0.001,)*3)
    # sparse point (slightly bigger, cyan) appears as rays converge
    sp = sphere(f"Sparse{i}", p, 0.09, mat(f"SparseM{i}",(0.3,0.9,1),0.3,emit=(0.3,0.85,1),es=1.6))
    sp.scale=(0.001,)*3; pop(sp, 196+i*2); key(sp, 262, scale=(1,)*3); key(sp,274, scale=(0.001,)*3)
    sparse_pts.append(p)

# --- dense point cloud: sample house/tree/fence/ground surfaces ---
def sample_cloud():
    pts=[]
    def add(p,c): pts.append((p[0],p[1],p[2],c))
    wallC=(0.85,0.80,0.72); roofC=(0.68,0.26,0.16); leafC=(0.2,0.58,0.24); trunkC=(0.4,0.27,0.15)
    # walls (front/back/sides grid)
    for x in [i*0.32-1.6 for i in range(11)]:
        for z in [0.15+i*0.3 for i in range(7)]:
            add((x,-1.31,z),wallC); add((x,1.31,z),wallC)
    for y in [i*0.32-1.28 for i in range(9)]:
        for z in [0.15+i*0.3 for i in range(7)]:
            add((-1.61,y,z),wallC); add((1.61,y,z),wallC)
    # roof slopes
    for t in [i/12 for i in range(13)]:
        for y in [i*0.3-1.25 for i in range(9)]:
            add((-1.75+1.75*t, y, 2.0+1.45*t), roofC); add((1.75-1.75*t, y, 2.0+1.45*t), roofC)
    add((0.9,0.5,3.6),wallC)
    # windows glow points
    for wx in (-0.9,0.9):
        for dx in (-0.2,0,0.2):
            for dz in (-0.2,0,0.2): add((wx+dx,-1.35,1.35+dz),(0.45,0.75,1.0))
    # tree foliage blobs + trunk
    for cx,cy,cz,r in [(2.9,1.4,2.1,0.9),(2.35,1.25,1.75,0.55),(3.45,1.55,1.8,0.57)]:
        for _ in range(55):
            v=Vector((rng.gauss(0,1),rng.gauss(0,1),rng.gauss(0,1)))
            if v.length==0: continue
            v.normalize(); p=(cx+v.x*r*rng.uniform(0.55,1),cy+v.y*r*rng.uniform(0.55,1),cz+v.z*r*0.9*rng.uniform(0.55,1))
            add(p,leafC)
    for z in [0.15+i*0.25 for i in range(6)]: add((2.9,1.4,z),trunkC)
    # fence + ground ring
    for i in range(5):
        for dz in (0.1,0.4,0.65): add((-3.4+i*0.55,2.2,dz),(0.62,0.48,0.34))
    for _ in range(130):
        add((rng.uniform(-5,5),rng.uniform(-4.5,4.5),0.02),(0.16,0.22,0.16))
    return pts

cloud = sample_cloud()
CH=8
for ci in range(CH):
    chunk = cloud[ci::CH]
    o = point_cloud(f"Cloud{ci}", chunk, radius=0.05)
    o.scale=(0.001,)*3
    f0 = 268+ci*7
    pop(o, f0); key(o, 360, scale=(1,)*3)

# solid scene fades: scale house/tree down just as cloud completes (keeps silhouette readable)
for o in house+tree:
    key(o, 296, scale=(1,)*3 if not hasattr(o,'_s') else o.scale)
    # store base scale then shrink
for o in house+tree:
    base = tuple(o.scale)
    key(o, 296, scale=base); key(o, 318, scale=(base[0]*0.001, base[1]*0.001, base[2]*0.001))

# end card
end = text("End","POINT CLOUD  —  every point triangulated from photos",(0,0,4.4),0.3,(0.55,1,0.55),align='CENTER')
key(end,1,hide=True); key(end,322,hide=False); key(end,360,hide=False)
end.parent = cam; end.location = (0,0.3,-3.2); end.rotation_euler = (0,0,0); end.data.size = 0.1
cnt = text("Count", f"{len(cloud)} points  •  {NCAM} cameras  •  {len(feat_pts)} tracked features",(0,0,3.85),0.24,WHITE,align='CENTER')
key(cnt,1,hide=True); key(cnt,322,hide=False); key(cnt,360,hide=False)
cnt.parent = cam; cnt.location = (0,-0.05,-3.2); cnt.rotation_euler = (0,0,0); cnt.data.size = 0.07

# smooth interpolation
for o in bpy.data.objects:
    if o.animation_data and o.animation_data.action:
        for fc in o.animation_data.action.fcurves:
            for kp in fc.keyframe_points: kp.interpolation='BEZIER'

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,"sfm_scene.blend"))
if TESTFRAME:
    scene.frame_set(TESTFRAME)
    scene.render.filepath = f"/tmp/sfm_preview_{TESTFRAME}.png"
    scene.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)
print("DONE sfm frames 1-360 ->", scene.render.filepath, "cloud points:", len(cloud))
