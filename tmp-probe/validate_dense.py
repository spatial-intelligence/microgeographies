"""Scratch: dense stereo + fusion + voting on real binaries (repo-local).

Uses the conda COLMAP 4.2.1 CLI with a hand-built sparse model (true
pure-translation poses), proving the dense product path end to end.
"""
import math
import os
import random
import shutil
import sys

sys.path.insert(0, "backend")
os.environ["PATH"] = ("/home/phil/miniconda3/envs/colmap-probe/bin:"
                       + os.environ["PATH"])
os.environ["HF_HUB_OFFLINE"] = "1"

import sfm  # noqa: E402
import server  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

ROOT = "tmp-probe/dense"
shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(os.path.join(ROOT, "images"))

random.seed(4242)


def make_view(sbg, sdoor):
    img = Image.new("RGB", (640, 480), (225, 222, 210))
    d = ImageDraw.Draw(img)
    for _ in range(520):
        cx = random.uniform(0, 640) - sbg
        cy = random.uniform(0, 480)
        n = random.randint(3, 7)
        r0 = random.uniform(6, 26)
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n + random.uniform(-0.4, 0.4)
            r = r0 * random.uniform(0.55, 1.0)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        g = random.randint(15, 235)
        d.polygon(pts, fill=(g, max(0, g - 30), max(0, g - 60)))
    x0 = 300 - sdoor
    d.rectangle([x0, 130, x0 + 130, 430], fill=(101, 67, 33),
                outline=(40, 25, 10), width=5)
    d.rectangle([x0 + 18, 150, x0 + 112, 270], outline=(60, 40, 18), width=3)
    d.rectangle([x0 + 18, 290, x0 + 112, 410], outline=(60, 40, 18), width=3)
    d.ellipse([x0 + 96, 272, x0 + 112, 288], fill=(220, 190, 120))
    return img


make_view(0, 0).save(os.path.join(ROOT, "images", "a.jpg"), quality=90)
make_view(60, 110).save(os.path.join(ROOT, "images", "b.jpg"), quality=90)

binary = sfm.colmap_binary()
assert binary, "no colmap CLI"
WS = os.path.join(ROOT, "ws")
os.makedirs(os.path.join(WS, "images"))
for n in ("a.jpg", "b.jpg"):
    shutil.copy(os.path.join(ROOT, "images", n),
                os.path.join(WS, "images", n))
sfm._run([binary, "feature_extractor", "--database_path",
          os.path.join(WS, "sfm.db"), "--image_path",
          os.path.join(WS, "images"),
          *sfm._sift_gpu_flags(binary, False)[0]], [])
print("extract OK")

import pycolmap  # noqa: E402

rec = pycolmap.Reconstruction()
cam = pycolmap.Camera(model="SIMPLE_PINHOLE", width=640, height=480,
                      params=[768.0, 320.0, 240.0])
rec.add_camera_with_trivial_rig(cam)
cid = cam.camera_id
for name, tx in (("a.jpg", 0.0), ("b.jpg", -1.0)):
    im = pycolmap.Image(name=name, camera_id=cid)
    rec.add_image_with_trivial_frame(im)
    fr = rec.frame(im.frame_id)
    pose = pycolmap.Rigid3d()
    pose.translation = [tx, 0.0, 0.0]
    fr.set_cam_from_world(pose)
    rec.register_frame(fr.frame_id)
model_dir = os.path.join(WS, "sparse", "0")
os.makedirs(model_dir)
rec.write_text(model_dir)
print("sparse format files:", sorted(os.listdir(model_dir)))

fused, warns = sfm.run_dense_cli(binary, WS, False)
print("fused:", fused, warns)
pts, cols = sfm.read_ply_points(fused)
print("dense points:", len(pts))

pil = {n: Image.open(os.path.join(WS, "images", n)).convert("RGB")
       for n in ("a.jpg", "b.jpg")}
dets, errs = server.detect_concepts_no_depth(pil, ["door"], detector="clip")
print("dets:", {k: len(v) for k, v in dets.items()}, "errors:", errs)
cams = [{"image": "a.jpg", "qvec": [1.0, 0.0, 0.0, 0.0],
         "tvec": [0.0, 0.0, 0.0], "width": 640, "height": 480,
         "model": "SIMPLE_PINHOLE", "params": [768.0, 320.0, 240.0]},
        {"image": "b.jpg", "qvec": [1.0, 0.0, 0.0, 0.0],
         "tvec": [-1.0, 0.0, 0.0], "width": 640, "height": 480,
         "model": "SIMPLE_PINHOLE", "params": [768.0, 320.0, 240.0]}]
labels = sfm.vote_point_labels_numpy(pts, cams, dets)
got = sorted({v["label"] for v in labels.values()})
print("labeled points:", len(labels), "labels:", got)
assert len(pts) > 100, "dense cloud unexpectedly tiny"
assert got == ["door"], got
print("DENSE E2E OK")
