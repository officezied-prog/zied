"""Automated quality control on every render.

A try-on that silently changes someone's face, or leaves a hole where a garment
should be, is worse than a failed job — the user loses trust in the product, not
in the request. These checks run before a render is ever shown, and a failing
render is marked `needs_review` rather than delivered.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .preprocess import BodyZones, zone_for_role


@dataclass
class QaReport:
    score: float
    flags: list[str] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return "face_altered" not in self.flags and self.score >= 0.5


def inspect(before: np.ndarray, after: np.ndarray, zones: BodyZones,
            roles: list[str], *, face_tolerance: float = 1.0,
            min_coverage: float = 0.02) -> QaReport:
    h, w = after.shape[:2]
    flags: list[str] = []
    metrics: dict[str, float] = {}

    # 1. Identity: the head region must be untouched.
    fx, fy, fw, fh = zones.pixel_box("head", w, h)
    face_before = before[fy:fy + fh, fx:fx + fw].astype(np.float32)
    face_after = after[fy:fy + fh, fx:fx + fw].astype(np.float32)
    face_delta = float(np.abs(face_before - face_after).mean()) if face_before.size else 0.0
    metrics["face_delta"] = round(face_delta, 4)
    if face_delta > face_tolerance:
        flags.append("face_altered")

    # 2. Something actually changed in each target zone.
    for role in set(roles):
        zx, zy, zw, zh = zones.pixel_box(zone_for_role(role), w, h)
        a = before[zy:zy + zh, zx:zx + zw].astype(np.float32)
        b = after[zy:zy + zh, zx:zx + zw].astype(np.float32)
        if a.size == 0:
            continue
        changed = float((np.abs(a - b).max(axis=2) > 8).mean())
        metrics[f"coverage_{role}"] = round(changed, 4)
        if changed < min_coverage:
            flags.append(f"garment_not_applied:{role}")

    # 3. Clipping: a render that is mostly blown out or crushed is broken.
    extreme = float(((after >= 254).all(axis=2) | (after <= 1).all(axis=2)).mean())
    metrics["extreme_pixel_ratio"] = round(extreme, 4)
    if extreme > 0.5:
        flags.append("degenerate_output")

    # 4. Edge density spike is the usual signature of warping artefacts.
    metrics["edge_ratio"] = round(_edge_ratio(after) / max(_edge_ratio(before), 1e-6), 3)
    if metrics["edge_ratio"] > 3.0:
        flags.append("possible_warp_artefacts")

    penalty = {"face_altered": 1.0, "degenerate_output": 0.6,
               "possible_warp_artefacts": 0.25}
    score = 1.0
    for flag in flags:
        score -= penalty.get(flag.split(":")[0], 0.3)
    return QaReport(score=round(max(0.0, score), 3), flags=flags, metrics=metrics)


def _edge_ratio(image: np.ndarray) -> float:
    gray = image.astype(np.float32).mean(axis=2)
    gx = np.abs(np.diff(gray, axis=1)).mean()
    gy = np.abs(np.diff(gray, axis=0)).mean()
    return float((gx + gy) / 2)
