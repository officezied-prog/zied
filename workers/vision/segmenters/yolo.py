"""Production segmentation: YOLO-seg fine-tuned on DeepFashion2 / ModaNet.

Imported lazily — the worker image ships torch and ultralytics, the API image
does not. Falls back to open-vocabulary Grounding DINO + SAM 2 for instances the
closed-set detector is unsure about, which is where most of the long tail
(kaftans, hijabs, statement accessories) lives.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from .base import Segment


class YoloSegmenter:
    name = "yolo11-seg-deepfashion2"

    def __init__(self, weights: str, *, conf: float = 0.25, iou: float = 0.5,
                 device: str | None = None, version: str = "11x-seg-df2-1.0") -> None:
        self.weights = weights
        self.conf = conf
        self.iou = iou
        self.device = device
        self.version = version
        self._model: Any | None = None

    def _load(self):
        if self._model is None:
            from ultralytics import YOLO

            self._model = YOLO(self.weights)
        return self._model

    def segment(self, image_rgb: np.ndarray) -> list[Segment]:
        model = self._load()
        h, w = image_rgb.shape[:2]
        results = model.predict(
            source=image_rgb, conf=self.conf, iou=self.iou,
            device=self.device, verbose=False, retina_masks=True,
        )
        segments: list[Segment] = []
        for result in results:
            if result.masks is None:
                continue
            names = result.names
            for box, mask_t in zip(result.boxes, result.masks.data, strict=False):
                mask = np.asarray(mask_t.cpu().numpy(), dtype=bool)
                if mask.shape != (h, w):
                    mask = _resize_mask(mask, h, w)
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                segments.append(Segment(
                    label=str(names[int(box.cls)]).lower().replace("_", " "),
                    confidence=float(box.conf),
                    bbox=(x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h),
                    mask=mask,
                    attributes={"backend": "yolo"},
                ))
        return segments


def _resize_mask(mask: np.ndarray, h: int, w: int) -> np.ndarray:
    ys = (np.arange(h) * mask.shape[0] / h).astype(int).clip(0, mask.shape[0] - 1)
    xs = (np.arange(w) * mask.shape[1] / w).astype(int).clip(0, mask.shape[1] - 1)
    return mask[ys][:, xs]
