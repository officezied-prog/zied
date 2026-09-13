"""Segmentation backend contract.

Everything downstream (colour, tagging, cutouts, VTON) depends only on this
interface, so swapping the stub for YOLO — or YOLO for Grounding DINO + SAM 2 —
touches one factory function and nothing else.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np


@dataclass
class Segment:
    """One detected garment instance in one image."""
    label: str                              # raw model label
    confidence: float
    bbox: tuple[float, float, float, float]  # normalised x, y, w, h
    mask: np.ndarray                        # bool (h, w), full image size
    attributes: dict = field(default_factory=dict)

    @property
    def area_ratio(self) -> float:
        return float(self.mask.mean())


class SegmentationBackend(Protocol):
    name: str
    version: str

    def segment(self, image_rgb: np.ndarray) -> list[Segment]: ...
