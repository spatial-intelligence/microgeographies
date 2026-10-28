"""Offline CLIP text-to-image object identification.

CLIP answers "how much does this region look like the prompt" — it draws
no boxes itself. So this module proposes candidate windows (multi-scale
grid), scores every crop against every concept with CLIP cosine
similarity, and keeps the best after thresholding, top-k, and NMS.

Boxes are window-aligned and coarse — a genuinely offline fallback for
when neither the API nor the 930 MB browser SAM is available — but every
kept box earned its score against the actual pixels. Needs the
openai/clip-vit-base-patch32 weights once (~350 MB, then offline).
"""

import math

import merge as _merge

CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
CROP_SIZE = 224
SCORE_MIN = 0.22
TOP_K = 5
NMS_IOU = 0.4

_clip = None  # lazy (processor, model, device)


def _positions(length, win, stride):
    """Start offsets covering [0, length] with a final edge-flush window."""
    step = max(1.0, win * stride)
    pos = []
    x = 0.0
    while x + win < length:
        pos.append(int(round(x)))
        x += step
    pos.append(int(round(length - win)))
    return sorted(set(pos))


def propose_windows(img_w, img_h, scales=(0.3, 0.5, 0.75), stride=0.25):
    """Multi-scale sliding windows as xyxy pixel boxes covering the image."""
    out = []
    for s in scales:
        w, h = img_w * s, img_h * s
        if w < 8 or h < 8:
            continue
        for x in _positions(img_w, w, stride):
            for y in _positions(img_h, h, stride):
                x2, y2 = int(round(x + w)), int(round(y + h))
                if x2 - x >= 8 and y2 - y >= 8:
                    out.append([x, y, x2, y2])
    return out


def _load_clip(model_id=None):
    global _clip
    if _clip is not None:
        return _clip
    import torch
    from transformers import CLIPModel, CLIPProcessor
    device = "cuda" if torch.cuda.is_available() else "cpu"
    mid = model_id or CLIP_MODEL_ID
    processor = CLIPProcessor.from_pretrained(mid)
    model = CLIPModel.from_pretrained(mid).to(device)
    model.eval()
    _clip = (processor, model, device)
    return _clip


def clip_scores(pil_image, boxes, concepts, scorer=None, model_id=None):
    """Cosine(pool) similarity per (box, concept).

    ``scorer(crops, concepts)`` may be injected (tests); otherwise real
    CLIP runs batched. Returns ``[[s11, ...], ...]`` aligned with boxes.
    """
    crops = []
    for b in boxes:
        x1, y1, x2, y2 = [int(round(v)) for v in b]
        crops.append(pil_image.crop((x1, y1, x2, y2)))
    if scorer is not None:
        return scorer(crops, concepts)
    import torch
    processor, model, device = _load_clip(model_id)
    text = processor(text=list(concepts), return_tensors="pt",
                     padding=True).to(device)
    with torch.no_grad():
        tout = model.get_text_features(**text)
    txt = _pooled(tout)
    txt = txt / txt.norm(dim=-1, keepdim=True)
    sims = []
    for i in range(0, len(crops), 32):  # bounded batches for small RAM
        pix = processor(images=crops[i:i + 32], return_tensors="pt").to(device)
        with torch.no_grad():
            iout = model.get_image_features(**pix)
        img = _pooled(iout)
        img = img / img.norm(dim=-1, keepdim=True)
        sims.extend((img @ txt.T).clamp(-1, 1).tolist())
    return sims


def _pooled(out):
    """Unwrap pooled embeddings across transformers return conventions."""
    for attr in ("pooler_output", "image_embeds", "text_embeds"):
        if hasattr(out, attr):
            return getattr(out, attr)
    return out


def pick_boxes(boxes, sims, concepts, score_min=SCORE_MIN, top_k=TOP_K,
               nms_iou=NMS_IOU):
    """Threshold + per-concept top-k + NMS -> [{label, box, score}]."""
    dets = []
    for ci, label in enumerate(concepts):
        ranked = sorted(range(len(boxes)), key=lambda i: sims[i][ci], reverse=True)
        kept = []
        for i in ranked:
            s = sims[i][ci]
            if s < score_min or len(kept) >= top_k:
                break
            if all(_merge.box_iou(boxes[i], boxes[j]) < nms_iou for j in kept):
                kept.append(i)
        for i in kept:
            dets.append({"label": label, "box": [round(float(v)) for v in boxes[i]],
                         "score": round(float(sims[i][ci]), 3), "clip": True})
    return dets


def detect_clip(pil_image, concepts, scorer=None, model_id=None,
                score_min=SCORE_MIN):
    """Full offline pass: propose, score, pick. Stdlib+Pillow+torch only."""
    w, h = pil_image.size
    boxes = propose_windows(w, h)
    if not boxes or not concepts:
        return []
    sims = clip_scores(pil_image, boxes, concepts, scorer=scorer, model_id=model_id)
    return pick_boxes(boxes, sims, list(concepts), score_min=score_min)
