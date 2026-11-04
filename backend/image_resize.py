"""Resize reconstruction photos one at a time, retaining EXIF/GPS metadata."""
import os
from pathlib import PurePosixPath
import re
import shutil
import tempfile
import zipfile as ziplib

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from PIL import Image, ImageOps

router = APIRouter()
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def output_name(filename):
    name = re.split(r"[/\\]", filename or "images.zip")[-1]
    stem = name[:-4] if name.lower().endswith(".zip") else name
    return (stem or "images") + "_resize.zip"


def resize_archive(source, destination, max_side=1280, quality=85):
    if type(max_side) is not int or not 256 <= max_side <= 4096:
        raise ValueError("Longest edge must be 256–4096 pixels")
    if type(quality) is not int or not 40 <= quality <= 100:
        raise ValueError("JPEG/WebP quality must be 40–100")
    counts = {"resized": 0, "unchanged": 0, "skipped": 0}
    with ziplib.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 1024 ** 3:
            raise ValueError("ZIP exceeds 2000 entries or 1 GB of uncompressed files")
        seen = set()
        with ziplib.ZipFile(destination, "w", compression=ziplib.ZIP_DEFLATED) as result:
            for entry in entries:
                name = entry.filename.replace("\\", "/")
                path = PurePosixPath(name)
                if path.is_absolute() or ".." in path.parts or not path.parts or ":" in path.parts[0] or "\x00" in name:
                    raise ValueError("ZIP contains an unsafe file path")
                if entry.is_dir():
                    continue
                if "__MACOSX" in path.parts or path.name.startswith(".") or path.suffix.lower() not in IMAGE_SUFFIXES:
                    counts["skipped"] += 1
                    continue
                if name in seen:
                    raise ValueError("ZIP contains duplicate image filenames")
                seen.add(name)
                try:
                    with archive.open(entry) as raw, Image.open(raw) as photo:
                        if photo.width * photo.height > 80000000:
                            raise ValueError(f"Image exceeds 80 megapixels: {path.name}")
                        if max(photo.size) <= max_side:
                            # No resampling or re-encoding of already-small images.
                            with archive.open(entry) as original, result.open(name, "w") as target:
                                shutil.copyfileobj(original, target)
                            counts["unchanged"] += 1
                            continue
                        fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}[path.suffix.lower()]
                        icc = photo.info.get("icc_profile")
                        if photo.format == "JPEG":
                            photo.draft("RGB", (max_side, max_side))
                        image = ImageOps.exif_transpose(photo)
                        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS, reducing_gap=3)
                        exif = image.getexif()
                        if exif:
                            exif[274] = 1
                            exif[256], exif[257] = image.size
                            if 34665 in exif:
                                dimensions = exif.get_ifd(34665)
                                dimensions[40962], dimensions[40963] = image.size
                        options = {"exif": exif.tobytes()} if exif else {}
                        if icc:
                            options["icc_profile"] = icc
                        if fmt in ("JPEG", "WEBP"):
                            options["quality"] = quality
                        if fmt == "JPEG":
                            options["optimize"] = True
                            image = image.convert("RGB")
                        with result.open(name, "w") as target:
                            image.save(target, fmt, **options)
                        image.close()
                        counts["resized"] += 1
                except (OSError, RuntimeError, Image.DecompressionBombError) as error:
                    raise ValueError(f"Could not resize {path.name}; check that it is a valid, unencrypted image") from error
    if not counts["resized"] and not counts["unchanged"]:
        raise ValueError("No JPEG, PNG or WebP images were found in this ZIP")
    return counts


@router.post("/api/resize-images")
def resize_images(zipfile: UploadFile = File(...), max_side: int = Form(1280), quality: int = Form(85)):
    zipfile.file.seek(0, os.SEEK_END)
    if zipfile.file.tell() > 1024 ** 3:
        raise HTTPException(status_code=413, detail="Uploaded ZIP exceeds 1 GB")
    zipfile.file.seek(0)
    descriptor, path = tempfile.mkstemp(prefix="microgeo-resize-", suffix=".zip")
    os.close(descriptor)
    try:
        counts = resize_archive(zipfile.file, path, max_side, quality)
    except (ValueError, ziplib.BadZipFile) as error:
        os.unlink(path)
        raise HTTPException(status_code=422, detail=str(error)) from None
    except BaseException:
        os.unlink(path)
        raise
    return FileResponse(path, media_type="application/zip", filename=output_name(zipfile.filename),
                        headers={"X-Images-Resized": str(counts["resized"]),
                                 "X-Images-Unchanged": str(counts["unchanged"]),
                                 "X-Files-Skipped": str(counts["skipped"])},
                        background=BackgroundTask(os.unlink, path))
