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

from ..placement import draw_order, placement_for, suppressed_roles, target_box
from .base import RenderRequest, RenderResult


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

        # A jilbab, abaya or maxi dress covers the top and the bottom: drawing
        # those underneath it wastes a pass and bleeds at the edges.
        hidden = suppressed_roles({item.role for item in request.layers})
        visible = [item for item in request.layers if item.role not in hidden]

        order = draw_order([item.role for item in visible])
        visible.sort(key=lambda item: order.index(item.role))

        drawn: list[str] = []
        for layer in visible:
            rule = placement_for(layer.role)
            x, y, box_w, box_h = target_box(request.zones, layer.role, w, h)
            self._paste(canvas, layer.cutout_rgba, x, y, box_w, box_h,
                        stretch=rule.stretch, anchor_y=rule.anchor_y)
            drawn.append(layer.role)

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
            metadata={"drawn": drawn, "covered": sorted(hidden),
                      "technique": "geometric_composite"},
        )

    def _paste(self, canvas: np.ndarray, rgba: np.ndarray,
               x: int, y: int, box_w: int, box_h: int, *,
               stretch: bool = False, anchor_y: float = 0.0) -> None:
        h, w = canvas.shape[:2]
        if rgba.ndim != 3 or rgba.shape[2] != 4 or box_w <= 0 or box_h <= 0:
            return

        src_h, src_w = rgba.shape[:2]
        if stretch:
            # Trousers on long legs and a full-length dress have to reach the
            # ankles; keeping their photographed aspect ratio would leave the
            # hem floating. Width still follows the body, so the garment is
            # lengthened, never widened out of proportion.
            new_w = box_w
            new_h = box_h
        else:
            # Everything else keeps its own proportions — a stretched shirt
            # reads as fake instantly.
            scale = min(box_w / src_w, box_h / src_h)
            new_w, new_h = max(1, int(src_w * scale)), max(1, int(src_h * scale))
        resized = _resize_rgba(rgba, new_h, new_w)

        ox = x + (box_w - new_w) // 2
        # anchor_y decides what the garment hangs from: 0 the top of its span
        # (a coat from the shoulders), 1 the bottom (shoes on the ground).
        oy = y + round((box_h - new_h) * anchor_y)
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
