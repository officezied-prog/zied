"""Weight-free segmentation backend.

Not a mock that returns canned data: it really segments, by finding horizontal
bands of perceptually uniform colour and assigning a garment label from vertical
position. That is enough to drive the whole pipeline — cutouts, colour, tagging,
dedupe, promotion — in CI and local development with no model download, and it
produces correct results on flat-lay and studio images where garments occupy
distinct horizontal bands.

Production uses `yolo.py`. This exists so the pipeline is testable end to end.
"""
from __future__ import annotations

import numpy as np

from ..color import ciede2000, rgb_to_lab
from .base import Segment

# Vertical centre of a band -> the label it most likely carries.
_ZONES: tuple[tuple[float, float, str, float], ...] = (
    (0.00, 0.12, "hat", 0.62),
    (0.12, 0.48, "shirt", 0.74),
    (0.48, 0.80, "trousers", 0.72),
    (0.80, 1.01, "shoes", 0.68),
)


class StubSegmenter:
    name = "stub-segmenter"
    version = "0.1.0"

    def __init__(self, *, rows: int = 96, delta_e: float = 9.0,
                 min_band_ratio: float = 0.06, min_fill: float = 0.12) -> None:
        self.rows = rows
        self.delta_e = delta_e
        self.min_band_ratio = min_band_ratio
        self.min_fill = min_fill

    def segment(self, image_rgb: np.ndarray) -> list[Segment]:
        img = np.asarray(image_rgb)
        h, w = img.shape[:2]
        step = max(1, h // self.rows)
        sample_rows = np.arange(0, h, step)
        row_mean_rgb = img[sample_rows].reshape(len(sample_rows), -1, 3).mean(axis=1)
        row_lab = rgb_to_lab(row_mean_rgb)

        # Split where consecutive row colours differ perceptibly.
        bands: list[list[int]] = [[0]]
        for i in range(1, len(row_lab)):
            if float(ciede2000(row_lab[i], row_lab[i - 1])) > self.delta_e:
                bands.append([i])
            else:
                bands[-1].append(i)

        segments: list[Segment] = []
        for band in bands:
            y0 = int(sample_rows[band[0]])
            y1 = int(min(h, sample_rows[band[-1]] + step))
            if (y1 - y0) / h < self.min_band_ratio:
                continue

            region = img[y0:y1]
            region_lab = rgb_to_lab(region.reshape(-1, 3))
            centre = region_lab.mean(axis=0)
            close = (ciede2000(region_lab, centre[None, :]) < self.delta_e * 1.6)
            mask_region = close.reshape(region.shape[:2])
            if mask_region.mean() < self.min_fill:
                continue

            mask = np.zeros((h, w), dtype=bool)
            mask[y0:y1] = mask_region

            cols = np.where(mask.any(axis=0))[0]
            rows_idx = np.where(mask.any(axis=1))[0]
            if not len(cols) or not len(rows_idx):
                continue
            x0, x1 = int(cols[0]), int(cols[-1] + 1)
            ry0, ry1 = int(rows_idx[0]), int(rows_idx[-1] + 1)

            centre_y = ((y0 + y1) / 2) / h
            label, conf = next(
                ((lab, c) for lo, hi, lab, c in _ZONES if lo <= centre_y < hi),
                ("shirt", 0.55),
            )
            fill = float(mask_region.mean())
            segments.append(Segment(
                label=label,
                confidence=round(min(0.95, conf * (0.75 + 0.25 * fill)), 3),
                bbox=(x0 / w, ry0 / h, (x1 - x0) / w, (ry1 - ry0) / h),
                mask=mask,
                attributes={"backend": "stub", "band_fill": round(fill, 3)},
            ))
        return segments
