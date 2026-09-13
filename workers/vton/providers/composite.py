"""Geometric compositing provider.

Not a diffusion model and not pretending to be one: it warps each garment cutout
onto the matching body zone and alpha-composites it, preserving the face. The
result is a real, deterministic try-on image — good enough for CI, for a free
tier, and as the fallback when GPU capacity is exhausted, which is exactly when
a product must still return *something*.

It is registered as `composite@1`, distinct from the diffusion models, so the
UI can label the output honestly.
"""
from __future__ import annotations

import time

import numpy as np

from ..preprocess import zone_for_role
from .base import RenderRequest, RenderResult

# Draw order: what goes on top when two garments overlap.
LAYER_ORDER = {
    "hosiery": 0, "base_top": 1, "full_body": 1, "bottom": 2, "mid_layer": 3,
    "outerwear": 4, "belt": 5, "footwear": 6, "scarf": 7, "bag": 8,
    "headwear": 9, "eyewear": 10, "jewelry": 11, "watch": 11,
}


class CompositeProvider:
    model_id = "composite@1"
    provider = "internal_gpu"
    supports_multi_garment = True

    def __init__(self, *, feather: int = 2) -> None:
        self.feather = feather

    def render(self, request: RenderRequest) -> RenderResult:
        started = time.perf_counter()
        canvas = request.person_rgb.astype(np.float32).copy()
        h, w = canvas.shape[:2]
        original = request.person_rgb.copy()

        for layer in sorted(request.layers, key=lambda item: LAYER_ORDER.get(item.role, 5)):
            zone = zone_for_role(layer.role)
            x, y, zw, zh = request.zones.pixel_box(zone, w, h)
            self._paste(canvas, layer.cutout_rgba, x, y, zw, zh)

        if request.preserve_face:
            # The face is never generated. A try-on that alters someone's face is
            # worse than no try-on, so it is copied back verbatim.
            fx, fy, fw, fh = request.zones.pixel_box("head", w, h)
            canvas[fy:fy + fh, fx:fx + fw] = original[fy:fy + fh, fx:fx + fw]

        out = np.clip(canvas, 0, 255).astype(np.uint8)
        return RenderResult(
            image_rgb=out, provider=self.provider, model_id=self.model_id,
            duration_ms=int((time.perf_counter() - started) * 1000),
            cost_usd=0.0,
            metadata={"layers": [item.role for item in request.layers],
                      "technique": "geometric_composite"},
        )

    def _paste(self, canvas: np.ndarray, rgba: np.ndarray,
               x: int, y: int, box_w: int, box_h: int) -> None:
        h, w = canvas.shape[:2]
        if rgba.ndim != 3 or rgba.shape[2] != 4 or box_w <= 0 or box_h <= 0:
            return

        # Fit inside the zone box while keeping the garment's aspect ratio —
        # stretching a shirt to a zone's exact proportions looks obviously fake.
        src_h, src_w = rgba.shape[:2]
        scale = min(box_w / src_w, box_h / src_h)
        new_w, new_h = max(1, int(src_w * scale)), max(1, int(src_h * scale))
        resized = _resize_rgba(rgba, new_h, new_w)

        ox = x + (box_w - new_w) // 2
        oy = y + (box_h - new_h) // 2
        x0, y0 = max(0, ox), max(0, oy)
        x1, y1 = min(w, ox + new_w), min(h, oy + new_h)
        if x1 <= x0 or y1 <= y0:
            return

        patch = resized[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
        alpha = (patch[..., 3:4].astype(np.float32) / 255.0)
        if self.feather:
            alpha = _feather(alpha, self.feather)
        region = canvas[y0:y1, x0:x1]
        canvas[y0:y1, x0:x1] = region * (1 - alpha) + patch[..., :3].astype(np.float32) * alpha


def _resize_rgba(rgba: np.ndarray, h: int, w: int) -> np.ndarray:
    ys = (np.arange(h) * rgba.shape[0] / h).astype(int).clip(0, rgba.shape[0] - 1)
    xs = (np.arange(w) * rgba.shape[1] / w).astype(int).clip(0, rgba.shape[1] - 1)
    return rgba[ys][:, xs]


def _feather(alpha: np.ndarray, radius: int) -> np.ndarray:
    """Soften the cut edge with a small box blur so the seam is not a hard line."""
    a = alpha[..., 0]
    pad = np.pad(a, radius, mode="edge")
    integral = np.zeros((pad.shape[0] + 1, pad.shape[1] + 1), dtype=np.float32)
    integral[1:, 1:] = pad.cumsum(0).cumsum(1)
    k = 2 * radius + 1
    total = (integral[k:, k:] - integral[:-k, k:] - integral[k:, :-k] + integral[:-k, :-k])
    return (total / (k * k))[..., None]
