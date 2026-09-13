"""Body-photo preparation.

Every try-on needs the same three things about the person: where they are, which
body zone each garment belongs on, and which pixels must never change (the
face). Computing that once per photo instead of once per render removes most of
the latency from the second and subsequent try-ons.

Two implementations, one interface: :class:`GeometricBodyParser` (weight-free,
used in CI and as a fallback) and the production stack (SCHP human parsing +
DensePose + ViTPose) in `parsers.py`.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np

# Anthropometric proportions of a standing figure, as fractions of body height.
# Used to place garments when a real parsing map is unavailable.
ZONE_BANDS: dict[str, tuple[float, float]] = {
    "head": (0.00, 0.13),
    "torso": (0.13, 0.50),
    "hips": (0.44, 0.58),
    "legs": (0.50, 0.92),
    "feet": (0.90, 1.00),
}

# Which body zone each outfit role is drawn onto.
ROLE_ZONES: dict[str, str] = {
    "base_top": "torso", "mid_layer": "torso", "outerwear": "torso",
    "bottom": "legs", "full_body": "torso", "footwear": "feet",
    "headwear": "head", "eyewear": "head", "scarf": "torso",
    "bag": "hips", "belt": "hips", "jewelry": "torso",
}


@dataclass
class BodyZones:
    """Normalised boxes (x, y, w, h in 0..1 of the whole image)."""
    person: tuple[float, float, float, float]
    zones: dict[str, tuple[float, float, float, float]] = field(default_factory=dict)
    quality_score: float = 1.0
    issues: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"person": list(self.person),
                "zones": {k: list(v) for k, v in self.zones.items()},
                "quality_score": self.quality_score, "issues": self.issues}

    @classmethod
    def from_dict(cls, data: dict) -> BodyZones:
        return cls(person=tuple(data["person"]),
                   zones={k: tuple(v) for k, v in data.get("zones", {}).items()},
                   quality_score=data.get("quality_score", 1.0),
                   issues=list(data.get("issues", [])))

    def pixel_box(self, zone: str, width: int, height: int) -> tuple[int, int, int, int]:
        x, y, w, h = self.zones.get(zone, self.person)
        return (int(x * width), int(y * height),
                max(1, int(w * width)), max(1, int(h * height)))


class GeometricBodyParser:
    """Finds the subject against the background, then splits it into body zones."""

    name = "geometric-parser"
    version = "0.1.0"

    def __init__(self, *, border: int = 6, threshold: float = 12.0,
                 min_person_ratio: float = 0.06) -> None:
        self.border = border
        self.threshold = threshold
        self.min_person_ratio = min_person_ratio

    def parse(self, rgb: np.ndarray) -> tuple[np.ndarray, BodyZones]:
        h, w = rgb.shape[:2]
        mask = self._person_mask(rgb)
        issues: list[str] = []

        ys, xs = np.where(mask)
        if len(ys) == 0:
            return mask, BodyZones(person=(0.0, 0.0, 1.0, 1.0), quality_score=0.0,
                                   issues=["no_person_detected"])

        y0, y1 = int(ys.min()), int(ys.max() + 1)
        x0, x1 = int(xs.min()), int(xs.max() + 1)
        ratio = mask.mean()

        if ratio < self.min_person_ratio:
            issues.append("subject_too_small")
        if y0 <= 1 or y1 >= h - 1:
            issues.append("subject_cropped_vertically")
        if (x1 - x0) / w > 0.98:
            issues.append("subject_fills_frame")

        person = (x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h)
        body_h = (y1 - y0) / h
        zones: dict[str, tuple[float, float, float, float]] = {}
        for name, (top, bottom) in ZONE_BANDS.items():
            zy0 = y0 / h + top * body_h
            zy1 = y0 / h + bottom * body_h
            # Re-measure the subject's width inside the band: shoulders are wider
            # than ankles, and a garment scaled to the full bbox would look wrong.
            band = mask[int(zy0 * h):max(int(zy1 * h), int(zy0 * h) + 1)]
            cols = np.where(band.any(axis=0))[0] if band.size else np.array([])
            if len(cols):
                bx0, bx1 = int(cols[0]), int(cols[-1] + 1)
            else:
                bx0, bx1 = x0, x1
            zones[name] = (bx0 / w, zy0, (bx1 - bx0) / w, zy1 - zy0)

        quality = float(np.clip(1.0 - 0.25 * len(issues), 0.0, 1.0))
        return mask, BodyZones(person=person, zones=zones, quality_score=quality,
                               issues=issues)

    def _person_mask(self, rgb: np.ndarray) -> np.ndarray:
        """Everything perceptibly different from the frame border is the subject."""
        from workers.vision.color import ciede2000, rgb_to_lab

        b = self.border
        border_px = np.concatenate([
            rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
            rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3),
        ])
        background = rgb_to_lab(np.median(border_px, axis=0))
        lab = rgb_to_lab(rgb.reshape(-1, 3))
        distance = ciede2000(lab, background[None, :])
        return (distance > self.threshold).reshape(rgb.shape[:2])


def zone_for_role(role: str) -> str:
    return ROLE_ZONES.get(role, "torso")


def zones_to_json(zones: BodyZones) -> dict:
    return asdict(zones) | zones.as_dict()
