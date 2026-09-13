"""Try-on provider contract."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from ..preprocess import BodyZones


@dataclass
class GarmentLayer:
    garment_id: str
    role: str
    cutout_rgba: np.ndarray          # (h, w, 4) uint8
    category: str | None = None


@dataclass
class RenderRequest:
    person_rgb: np.ndarray           # (h, w, 3) uint8 — may be a previous pass's output
    person_mask: np.ndarray          # (h, w) bool
    zones: BodyZones
    layers: list[GarmentLayer]
    params: dict = field(default_factory=dict)
    seed: int = 0
    preserve_face: bool = True


@dataclass
class RenderResult:
    image_rgb: np.ndarray
    provider: str
    model_id: str
    duration_ms: int
    cost_usd: float = 0.0
    metadata: dict = field(default_factory=dict)


class VtonProvider(Protocol):
    model_id: str
    provider: str
    supports_multi_garment: bool

    def render(self, request: RenderRequest) -> RenderResult: ...
