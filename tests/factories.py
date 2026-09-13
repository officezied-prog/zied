"""Synthetic garment photos.

Deterministic images with clean horizontal colour bands — the shape the stub
segmenter is built for, and close enough to a flat-lay that the colour and
tagging assertions mean something.
"""
from __future__ import annotations

import hashlib
import io

import numpy as np
from PIL import Image

NAVY = (27, 42, 74)
CAMEL = (176, 130, 69)
WHITE = (247, 247, 247)
CHARCOAL = (54, 57, 63)
BURGUNDY = (110, 27, 46)


def outfit_image(top=NAVY, bottom=CAMEL, shoes=WHITE, *, size=(240, 400),
                 noise: float = 3.0, seed: int = 0) -> bytes:
    """Full-body-ish photo: top band, bottom band, shoe band on a light ground."""
    w, h = size
    img = np.full((h, w, 3), 236, dtype=np.uint8)
    img[int(h * 0.10):int(h * 0.45)] = top
    img[int(h * 0.48):int(h * 0.78)] = bottom
    img[int(h * 0.84):] = shoes

    if noise:                                    # break up perfectly flat colour
        rng = np.random.default_rng(seed)
        img = np.clip(img.astype(np.int16) + rng.normal(0, noise, img.shape), 0, 255).astype(np.uint8)

    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def single_garment_image(color=NAVY, *, size=(200, 260), seed: int = 0) -> bytes:
    w, h = size
    img = np.full((h, w, 3), 240, dtype=np.uint8)
    img[int(h * 0.15):int(h * 0.85)] = color
    rng = np.random.default_rng(seed)
    img = np.clip(img.astype(np.int16) + rng.normal(0, 2.5, img.shape), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def body_image(*, size=(220, 440), skin=(226, 190, 160), top=(210, 210, 210),
               bottom=(205, 205, 205), shoes=(60, 60, 60), background=238,
               seed: int = 0) -> bytes:
    """A standing figure on a plain ground — head, torso, legs, feet.

    Deliberately plain: the try-on assertions are about *where* garments land and
    whether the face survives, which needs a subject whose zones are knowable.
    """
    w, h = size
    img = np.full((h, w, 3), background, dtype=np.uint8)
    cx = w // 2
    img[int(h * .07):int(h * .17), cx - 26:cx + 26] = skin        # head
    img[int(h * .17):int(h * .52), cx - 42:cx + 42] = top          # torso
    img[int(h * .52):int(h * .90), cx - 32:cx + 32] = bottom       # legs
    img[int(h * .90):int(h * .98), cx - 36:cx + 36] = shoes        # feet
    rng = np.random.default_rng(seed)
    img = np.clip(img.astype(np.int16) + rng.normal(0, 2, img.shape), 0, 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="JPEG", quality=94)
    return buf.getvalue()
