"""Photo DA3 requests select the intended model without requiring COLMAP."""
import io
import json
import os
import zipfile
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient

import da3
import server
import sfm
from photo_cloud import MODELS


def photos():
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,"w") as archive:
        for i in range(3):
            image=io.BytesIO(); Image.new("RGB",(64,48),(80,140,200)).save(image,format="PNG")
            archive.writestr(f"photo{i}.png",image.getvalue())
    return stream.getvalue()


@pytest.mark.parametrize("engine",["da3-small","da3-giant"])
@pytest.mark.parametrize("labels",[True,False])
def test_photo_da3_model_selection_clean_images_and_pixel_frames(engine,labels,monkeypatch):
    calls=[]
    def estimate(frames,**kwargs):
        calls.append(kwargs)
        # A processed resolution smaller than the original photos.
        scene=da3._mock_scene([Image.new("RGB",(32,24),(80,140,200)) for _ in frames])
        scene.update(model=kwargs["model_id"],device="cpu",is_metric=False)
        return scene
    def detect(images,concepts,detector,**kwargs):
        assert all(image.size==(64,48) for image in images.values())
        for image in images.values(): image.putpixel((0,0),(255,0,0))
        return {name:[{"label":"door","box":[0,0,64,48],"score":.9}] for name in images},[]
    monkeypatch.setattr(sfm,"sfm_backend_available",lambda:False)
    monkeypatch.setattr(sfm,"gpu_available",lambda:False)
    with patch.object(da3,"estimate_scene",side_effect=estimate), patch.object(server,"detect_concepts_no_depth",side_effect=detect) as detector:
        response=TestClient(server.app).post('/api/sfm',files={"zipfile":("photos.zip",photos(),"application/zip")},
            data={"reconstruction_engine":engine,"label_objects":"1" if labels else "0", "concepts":'["door"]',"use_gpu":"0"})
    assert response.status_code==200
    events=[json.loads(line) for line in response.text.splitlines() if line.strip()]
    result=next(event["data"] for event in events if event["type"]=="result")
    assert "error" not in result,result
    assert calls[0]["model_id"]==MODELS[engine]
    assert calls[0]["force_cpu"]
    assert result["engine"]==engine and result["point_count"]>0
    assert detector.call_count==int(labels)
    assert bool(result["point_labels"])==labels
    assert not result["georeference"]["available"]
    camera=result["cameras"][0]
    assert camera["width"]==64 and camera["params"][0]==pytest.approx(54.4)
    assert result["colmap_inputs_annotated"] is False
    assert len(result["source_frames"]) == len(result["cameras"])
    assert result["source_frames"][0]["image"] == result["cameras"][0]["image"]
    assert len(result["source_frames"][0]["depth"]) == 1024
    assert result["source_frames"][0]["url"].startswith("data:image/jpeg;base64,")


def test_unknown_reconstruction_engine_is_rejected():
    response=TestClient(server.app).post('/api/sfm',files={"zipfile":("photos.zip",photos(),"application/zip")},
        data={"reconstruction_engine":"invalid"})
    assert response.status_code==400
