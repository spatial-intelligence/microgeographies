import io
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from PIL.TiffImagePlugin import IFDRational
import pytest
import image_resize


def photo(size=(600, 400), fmt="JPEG", metadata=False):
    image = Image.new("RGBA" if fmt == "PNG" else "RGB", size, (50, 120, 200, 100) if fmt == "PNG" else (50, 120, 200))
    options = {}
    if metadata:
        exif = Image.Exif()
        exif[274] = 6
        exif[271] = "Test camera"
        exif[34853] = {1: "N", 2: (IFDRational(51), IFDRational(30), IFDRational(0)),
                       3: "W", 4: (IFDRational(0), IFDRational(7), IFDRational(30)),
                       16: "T", 17: IFDRational(90)}
        options["exif"] = exif
    result = io.BytesIO()
    image.save(result, fmt, **options)
    return result.getvalue()


def archive(files):
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as output:
        for name, data in files:
            output.writestr(name, data)
    result.seek(0)
    return result


def test_resize_preserves_names_orientation_gps_heading_and_small_originals(tmp_path):
    original = photo((40, 60))
    source = archive([("photos/Door.jpg", photo(metadata=True)), ("small.jpg", original),
                      ("alpha.png", photo(fmt="PNG")), ("notes.txt", b"not a photo"),
                      ("__MACOSX/._Door.jpg", b"metadata")])
    destination = tmp_path / "resized.zip"
    counts = image_resize.resize_archive(source, destination, 256, 85)
    assert counts == {"resized": 2, "unchanged": 1, "skipped": 2}
    with zipfile.ZipFile(destination) as resized:
        assert set(resized.namelist()) == {"photos/Door.jpg", "small.jpg", "alpha.png"}
        assert resized.read("small.jpg") == original
        image = Image.open(io.BytesIO(resized.read("photos/Door.jpg")))
        assert max(image.size) == 256 and image.height > image.width
        exif = image.getexif()
        assert exif[274] == 1 and exif[271] == "Test camera"
        gps = exif.get_ifd(34853)
        assert gps[1] == "N" and gps[3] == "W"
        assert float(gps[17]) == 90 and gps[16] == "T"
        assert exif[256] == image.width and exif[257] == image.height
        png = Image.open(io.BytesIO(resized.read("alpha.png")))
        assert png.mode == "RGBA" and max(png.size) == 256


def test_api_returns_same_stem_resize_zip_and_summary():
    app = FastAPI()
    app.include_router(image_resize.router)
    response = TestClient(app).post("/api/resize-images",
        files={"zipfile": ("Survey Photos.ZIP", archive([("a.jpg", photo())]), "application/zip")},
        data={"max_side": "256", "quality": "80"})
    assert response.status_code == 200
    assert "Survey%20Photos_resize.zip" in response.headers["content-disposition"]
    assert response.headers["X-Images-Resized"] == "1"
    with zipfile.ZipFile(io.BytesIO(response.content)) as resized:
        assert max(Image.open(io.BytesIO(resized.read("a.jpg"))).size) == 256


def test_rejects_invalid_archives_paths_and_settings(tmp_path):
    target = tmp_path / "out.zip"
    with pytest.raises(ValueError, match="unsafe"):
        image_resize.resize_archive(archive([("../escape.jpg", photo())]), target)
    with pytest.raises(ValueError, match="No JPEG"):
        image_resize.resize_archive(archive([("notes.txt", b"text")]), target)
    with pytest.raises(ValueError, match="256–4096"):
        image_resize.resize_archive(archive([("a.jpg", photo())]), target, 16)
    with pytest.raises(ValueError, match="valid, unencrypted"):
        image_resize.resize_archive(archive([("bad.jpg", b"not an image")]), target)
    app = FastAPI()
    app.include_router(image_resize.router)
    response = TestClient(app).post("/api/resize-images", files={"zipfile": ("bad.zip", b"not a zip")})
    assert response.status_code == 422
    assert image_resize.output_name("folder\\photos.zip") == "photos_resize.zip"
