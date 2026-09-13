"""Perceptual hashing: the invariances dedupe actually relies on."""
from __future__ import annotations

import numpy as np
import pytest

from workers.vision.phash import from_signed_64, hamming, phash, to_signed_64

DUPLICATE_THRESHOLD = 6


def _photo(seed: int = 0) -> np.ndarray:
    """A structured, photo-like image. Different seeds give different *content*,
    not just different noise — pHash is meant to ignore noise."""
    y, x = np.mgrid[0:400, 0:300]
    rng = np.random.default_rng(seed)
    freq_x, freq_y = 13 + 29 * ((seed * 7) % 5), 11 + 23 * ((seed * 3) % 5)
    img = 110 + 50 * np.sin(x / (freq_x / 4 + 3)) + 40 * np.cos(y / (freq_y / 4 + 3))
    box = rng.integers(0, 200, size=4)
    img[box[0]:box[0] + 120, box[1]:box[1] + 120] += 45
    img[box[2] + 150:box[2] + 250, box[3]:box[3] + 130] -= 40
    return np.clip(img + rng.normal(0, 1.5, img.shape), 0, 255)


@pytest.mark.parametrize(("name", "transform"), [
    ("half scale", lambda a: a[::2, ::2]),
    ("third scale", lambda a: a[::3, ::3]),
    ("brightness +20", lambda a: np.clip(a + 20, 0, 255)),
    ("contrast x1.15", lambda a: np.clip(a * 1.15, 0, 255)),
    ("quantised (jpeg-like)", lambda a: np.round(a / 8) * 8),
])
def test_same_image_hashes_within_threshold(name, transform):
    img = _photo()
    assert hamming(phash(img), phash(transform(img))) <= DUPLICATE_THRESHOLD, name


def test_different_images_are_far_apart():
    assert hamming(phash(_photo(0)), phash(_photo(11))) > 15


def test_signed_roundtrip_survives_postgres_bigint():
    """Postgres bigint is signed; an unconverted hash would overflow the column."""
    for value in (0, 1, 2**63 - 1, 2**63, 2**64 - 1):
        signed = to_signed_64(value)
        assert -(2**63) <= signed < 2**63
        assert from_signed_64(signed) == value
