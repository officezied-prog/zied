"""Perceptual hashing for near-duplicate detection.

Users re-import the same camera roll and re-post the same photo across
platforms. sha256 catches byte-identical files; pHash catches the same image
after a resize, re-encode or crop-free filter, which is the common case.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np


@lru_cache(maxsize=8)
def _dct_matrix(n: int) -> np.ndarray:
    """Orthonormal DCT-II basis (avoids a scipy dependency in the worker image)."""
    k = np.arange(n)
    m = np.cos(np.pi * (2 * k[None, :] + 1) * k[:, None] / (2 * n))
    m *= np.sqrt(2.0 / n)
    m[0] *= 1 / np.sqrt(2)
    return m


def phash(gray: np.ndarray, hash_size: int = 8, highfreq_factor: int = 4) -> int:
    """64-bit perceptual hash of a 2-D grayscale array."""
    img_size = hash_size * highfreq_factor
    resized = _resize_area(np.asarray(gray, dtype=np.float64), img_size, img_size)
    d = _dct_matrix(img_size)
    coeffs = d @ resized @ d.T
    low = coeffs[:hash_size, :hash_size].flatten()
    # Drop the DC term before taking the median — it encodes overall brightness,
    # which is exactly the thing that should not affect the hash.
    med = np.median(low[1:])
    bits = low > med
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def _resize_area(a: np.ndarray, h: int, w: int) -> np.ndarray:
    """Box-filter (area-average) downscale.

    Nearest-neighbour would alias, and aliasing is precisely what makes a hash
    of an image differ from a hash of the same image at another resolution —
    the failure mode pHash exists to avoid.
    """
    src_h, src_w = a.shape
    y_edges = np.linspace(0, src_h, h + 1)
    x_edges = np.linspace(0, src_w, w + 1)
    # Integral image makes every box sum O(1) regardless of the scale factor.
    integral = np.zeros((src_h + 1, src_w + 1), dtype=np.float64)
    integral[1:, 1:] = a.cumsum(axis=0).cumsum(axis=1)
    y0 = np.floor(y_edges[:-1]).astype(int)
    y1 = np.maximum(np.ceil(y_edges[1:]).astype(int), y0 + 1)
    x0 = np.floor(x_edges[:-1]).astype(int)
    x1 = np.maximum(np.ceil(x_edges[1:]).astype(int), x0 + 1)
    total = (integral[np.ix_(y1, x1)] - integral[np.ix_(y0, x1)]
             - integral[np.ix_(y1, x0)] + integral[np.ix_(y0, x0)])
    area = np.outer(y1 - y0, x1 - x0)
    return total / area


def hamming(a: int, b: int) -> int:
    return int((a ^ b).bit_count())


def to_signed_64(value: int) -> int:
    """Postgres bigint is signed; wrap so the value survives a round trip."""
    return value - (1 << 64) if value >= (1 << 63) else value


def from_signed_64(value: int) -> int:
    return value + (1 << 64) if value < 0 else value
