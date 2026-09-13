"""Image decode / normalise / encode helpers.

Every uploaded byte passes through :func:`load_normalised` before anything else
touches it: orientation applied, EXIF (including GPS) dropped, colour space
forced to sRGB, and the long side capped. That last cap is a cost control —
segmentation time scales with pixels, and no wardrobe decision improves above
2048 px.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 80_000_000       # decompression-bomb guard


@dataclass(frozen=True)
class LoadedImage:
    rgb: np.ndarray            # (h, w, 3) uint8
    width: int
    height: int
    original_width: int
    original_height: int
    sha256: str


def load_normalised(data: bytes, *, max_side: int = 2048) -> LoadedImage:
    digest = hashlib.sha256(data).hexdigest()
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)          # honour orientation…
        ow, oh = im.size
        im = im.convert("RGB")                    # …then drop everything else
        scale = min(1.0, max_side / max(im.size))
        if scale < 1.0:
            im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                           Image.LANCZOS)
        rgb = np.asarray(im, dtype=np.uint8)
    return LoadedImage(rgb=rgb, width=rgb.shape[1], height=rgb.shape[0],
                       original_width=ow, original_height=oh, sha256=digest)


def to_grayscale(rgb: np.ndarray) -> np.ndarray:
    # Rec. 601 luma — what perceptual hashing conventionally uses.
    return rgb.astype(np.float64) @ np.array([0.299, 0.587, 0.114])


def cutout_png(rgb: np.ndarray, mask: np.ndarray, *, pad: int = 8,
               max_side: int = 1024) -> tuple[bytes, int, int]:
    """Tight RGBA crop of the masked region — the flat-lay image VTON consumes."""
    ys, xs = np.where(mask)
    if len(ys) == 0:
        raise ValueError("empty mask")
    y0, y1 = max(0, ys.min() - pad), min(mask.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(mask.shape[1], xs.max() + 1 + pad)

    crop_rgb = rgb[y0:y1, x0:x1]
    crop_mask = mask[y0:y1, x0:x1]
    rgba = np.dstack([crop_rgb, (crop_mask * 255).astype(np.uint8)])

    im = Image.fromarray(rgba, mode="RGBA")
    if max(im.size) > max_side:
        scale = max_side / max(im.size)
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                       Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), im.width, im.height


def thumbnail_jpeg(rgb: np.ndarray, *, size: int = 512, quality: int = 82) -> bytes:
    im = Image.fromarray(rgb)
    im.thumbnail((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def mask_to_rle(mask: np.ndarray) -> dict:
    """COCO-style column-major RLE — compact, and re-croppable later."""
    flat = np.asarray(mask, dtype=bool).T.flatten()
    changes = np.flatnonzero(np.diff(flat)) + 1
    bounds = np.concatenate(([0], changes, [flat.size]))
    counts = np.diff(bounds).tolist()
    if flat.size and flat[0]:
        counts.insert(0, 0)            # RLE always starts with a run of zeros
    return {"size": [int(mask.shape[0]), int(mask.shape[1])], "counts": counts}


def rle_to_mask(rle: dict) -> np.ndarray:
    h, w = rle["size"]
    flat = np.zeros(h * w, dtype=bool)
    pos, value = 0, False
    for count in rle["counts"]:
        if value and count:
            flat[pos:pos + count] = True
        pos += count
        value = not value
    return flat.reshape(w, h).T
