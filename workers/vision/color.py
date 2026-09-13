"""Colour extraction in CIELAB.

Why LAB and not RGB: k-means in RGB splits clusters where the eye sees one
colour and merges clusters where it sees two. LAB is roughly perceptually
uniform, so cluster distances mean what a stylist means by "these are the same
colour". The family assignment then uses CIEDE2000, which corrects LAB's
remaining non-uniformity in the blue and saturated regions.

Mirrors the SQL implementations in db/migrations/0009 — the two are checked
against each other in tests/test_color.py.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# D65, 2° observer
_WHITE = np.array([0.95047, 1.00000, 1.08883])
_M_RGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])


@dataclass(frozen=True)
class ColorCluster:
    hex: str
    ratio: float
    lab: tuple[float, float, float]
    lch: tuple[float, float]      # (chroma, hue degrees)
    family: str
    is_neutral: bool


# ── conversions ─────────────────────────────────────────────────────────────
def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    rgb = np.asarray(rgb, dtype=np.float64)
    return np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)


def rgb_to_lab(rgb_u8: np.ndarray) -> np.ndarray:
    """(..., 3) uint8 sRGB -> (..., 3) float64 CIELAB."""
    linear = srgb_to_linear(np.asarray(rgb_u8, dtype=np.float64) / 255.0)
    xyz = linear @ _M_RGB2XYZ.T / _WHITE
    eps, kappa = 216 / 24389, 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    eps = 216 / 24389
    kappa = 24389 / 27

    def finv(t):
        t3 = t ** 3
        return np.where(t3 > eps, t3, (116 * t - 16) / kappa)

    xyz = np.stack([finv(fx), finv(fy), finv(fz)], axis=-1) * _WHITE
    linear = xyz @ np.linalg.inv(_M_RGB2XYZ).T
    srgb = np.where(linear > 0.0031308, 1.055 * np.abs(linear) ** (1 / 2.4) - 0.055, 12.92 * linear)
    return np.clip(np.rint(srgb * 255), 0, 255).astype(np.uint8)


def lab_to_lch(lab: np.ndarray) -> np.ndarray:
    """-> (..., 2) chroma, hue in [0, 360)."""
    a, b = lab[..., 1], lab[..., 2]
    return np.stack([np.hypot(a, b), np.degrees(np.arctan2(b, a)) % 360.0], axis=-1)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    v = value.lstrip("#")
    return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)


def rgb_to_hex(rgb) -> str:
    r, g, b = (round(float(c)) for c in rgb)
    return f"#{r:02X}{g:02X}{b:02X}"


def hex_to_lab(value: str) -> np.ndarray:
    return rgb_to_lab(np.array(hex_to_rgb(value), dtype=np.uint8))


# ── CIEDE2000 ───────────────────────────────────────────────────────────────
def ciede2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """Vectorised CIEDE2000. Broadcasts, so (n,1,3) vs (1,m,3) gives an n-by-m matrix."""
    lab1 = np.asarray(lab1, dtype=np.float64)
    lab2 = np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]

    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    G = 0.5 * (1 - np.sqrt(Cbar ** 7 / (Cbar ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)

    h1p = np.where((a1p == 0) & (b1 == 0), 0.0, np.degrees(np.arctan2(b1, a1p)) % 360.0)
    h2p = np.where((a2p == 0) & (b2 == 0), 0.0, np.degrees(np.arctan2(b2, a2p)) % 360.0)

    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dhp = np.where(C1p * C2p == 0, 0.0,
                   np.where(np.abs(dh) <= 180, dh, np.where(dh > 180, dh - 360, dh + 360)))
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2))

    Lbar = (L1 + L2) / 2
    Cbarp = (C1p + C2p) / 2
    hsum = h1p + h2p
    hbarp = np.where(
        C1p * C2p == 0, hsum,
        np.where(np.abs(h1p - h2p) <= 180, hsum / 2,
                 np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2)),
    )

    T = (1 - 0.17 * np.cos(np.radians(hbarp - 30))
           + 0.24 * np.cos(np.radians(2 * hbarp))
           + 0.32 * np.cos(np.radians(3 * hbarp + 6))
           - 0.20 * np.cos(np.radians(4 * hbarp - 63)))
    dTheta = 30 * np.exp(-(((hbarp - 275) / 25) ** 2))
    RC = 2 * np.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25.0 ** 7))
    SL = 1 + (0.015 * (Lbar - 50) ** 2) / np.sqrt(20 + (Lbar - 50) ** 2)
    SC = 1 + 0.045 * Cbarp
    SH = 1 + 0.015 * Cbarp * T
    RT = -np.sin(np.radians(2 * dTheta)) * RC

    return np.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2
                   + RT * (dCp / SC) * (dHp / SH))


# ── k-means (deterministic) ─────────────────────────────────────────────────
def _kmeans(points: np.ndarray, k: int, *, seed: int = 0, iters: int = 40
            ) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    n = len(points)
    k = min(k, n)

    # k-means++ seeding: reproducible and far better than random init on
    # garments, where one colour usually dominates.
    centers = [points[rng.integers(n)]]
    for _ in range(1, k):
        d2 = np.min(((points[:, None, :] - np.array(centers)[None, :, :]) ** 2).sum(-1), axis=1)
        total = d2.sum()
        probs = np.full(n, 1 / n) if total <= 0 else d2 / total
        centers.append(points[rng.choice(n, p=probs)])
    centers = np.array(centers, dtype=np.float64)

    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        dist = ((points[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        new_labels = dist.argmin(axis=1)
        if np.array_equal(new_labels, labels) and _ > 0:
            break
        labels = new_labels
        for j in range(k):
            members = points[labels == j]
            if len(members):
                centers[j] = members.mean(axis=0)
    return centers, labels


def extract_palette(
    rgb: np.ndarray,
    mask: np.ndarray | None = None,
    *,
    k: int = 5,
    min_ratio: float = 0.05,
    max_colors: int = 5,
    seed: int = 0,
    sample_limit: int = 20000,
    merge_threshold: float = 8.0,
) -> list[tuple[str, float, tuple[float, float, float]]]:
    """Dominant colours of the masked region, largest share first.

    Returns ``(hex, ratio, lab)``. Extreme shadow and blown highlight pixels are
    dropped first — they are lighting, not the garment — and clusters closer
    than ``merge_threshold`` ΔE2000 are merged, so a single shirt with a fold
    does not come back as two near-identical navies.
    """
    rgb = np.asarray(rgb)
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("expected an (h, w, 3) RGB array")

    pixels = rgb.reshape(-1, 3)
    if mask is not None:
        pixels = pixels[np.asarray(mask).reshape(-1).astype(bool)]
    if len(pixels) == 0:
        return []

    lab = rgb_to_lab(pixels)
    keep = (lab[:, 0] > 8) & (lab[:, 0] < 96)
    if keep.sum() >= max(30, 0.1 * len(lab)):
        lab, pixels = lab[keep], pixels[keep]

    if len(lab) > sample_limit:                       # deterministic subsample
        idx = np.random.default_rng(seed).choice(len(lab), sample_limit, replace=False)
        lab = lab[idx]

    centers, labels = _kmeans(lab, k, seed=seed)
    counts = np.bincount(labels, minlength=len(centers)).astype(float)
    order = np.argsort(-counts)

    merged: list[tuple[np.ndarray, float]] = []
    for j in order:
        if counts[j] == 0:
            continue
        c, w = centers[j], counts[j]
        for i, (mc, mw) in enumerate(merged):
            if float(ciede2000(c, mc)) < merge_threshold:
                merged[i] = ((mc * mw + c * w) / (mw + w), mw + w)
                break
        else:
            merged.append((c, w))

    total = sum(w for _, w in merged) or 1.0
    out = []
    for c, w in sorted(merged, key=lambda t: -t[1])[:max_colors]:
        ratio = w / total
        if ratio < min_ratio and out:
            continue
        out.append((rgb_to_hex(lab_to_rgb(c)), round(float(ratio), 4),
                    tuple(round(float(x), 3) for x in c)))
    return out


def nearest_family(lab: np.ndarray, families: list[dict]) -> tuple[str, bool]:
    """Closest colour family by CIEDE2000 against each family's anchor colour."""
    if not families:
        return "unknown", False
    anchors = np.array([hex_to_lab(f["anchor_hex"]) for f in families])
    d = ciede2000(np.asarray(lab, dtype=np.float64)[None, :], anchors)
    j = int(np.argmin(d))
    return families[j]["slug"], bool(families[j].get("is_neutral", False))
