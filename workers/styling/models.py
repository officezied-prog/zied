"""Value objects shared by the styling engine."""
from __future__ import annotations

from dataclasses import dataclass, field
from uuid import UUID

import numpy as np


@dataclass
class Candidate:
    """One wearable garment, with everything the scorer needs already loaded."""
    garment_id: UUID
    role: str
    category_id: int
    category: str
    formality: int
    warmth: int
    pattern: str
    material: list[str]
    is_layerable: bool
    primary_hex: str | None
    color_family: str | None
    lab: tuple[float, float, float] | None
    lch_h: float | None
    lch_c: float | None
    is_neutral: bool
    wear_count: int
    days_since_worn: int
    name: str | None = None
    embedding: np.ndarray | None = None

    @property
    def is_accessory(self) -> bool:
        return self.role in {"jewelry", "watch", "belt", "eyewear", "scarf",
                             "headwear", "bag", "hosiery", "other_accessory"}


@dataclass
class Look:
    """A candidate outfit: one garment per filled role."""
    items: dict[str, Candidate] = field(default_factory=dict)
    score: float = 0.0
    breakdown: dict[str, float] = field(default_factory=dict)
    rationale: str | None = None

    @property
    def garments(self) -> list[Candidate]:
        return list(self.items.values())

    @property
    def signature(self) -> tuple:
        return tuple(sorted(str(c.garment_id) for c in self.items.values()))

    def with_item(self, role: str, candidate: Candidate) -> Look:
        return Look(items={**self.items, role: candidate})

    @property
    def mean_formality(self) -> float:
        core = [c.formality for c in self.garments if not c.is_accessory]
        return sum(core) / len(core) if core else 3.0

    @property
    def total_warmth(self) -> int:
        return sum(c.warmth for c in self.garments if not c.is_accessory)
