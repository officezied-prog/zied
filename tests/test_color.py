"""Colour maths: agreement with the SQL implementation, and real extraction."""
from __future__ import annotations

import numpy as np
import pytest
from sqlalchemy import text

from workers.vision.color import (
    ciede2000,
    extract_palette,
    hex_to_lab,
    lab_to_lch,
    nearest_family,
    rgb_to_lab,
)

# Sharma, Wu & Dalal (2005) — the canonical CIEDE2000 test pairs.
SHARMA = [
    ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0009), 7.1792),
    ((50.0000, 2.5000, 0.0000), (50.0000, 0.0000, -2.5000), 4.3065),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
]


@pytest.mark.parametrize(("lab1", "lab2", "expected"), SHARMA)
def test_ciede2000_matches_reference(lab1, lab2, expected):
    assert float(ciede2000(np.array(lab1), np.array(lab2))) == pytest.approx(expected, abs=1e-4)


def test_srgb_to_lab_known_values():
    assert rgb_to_lab(np.array([255, 255, 255], dtype=np.uint8)) == pytest.approx([100, 0, 0], abs=1e-3)
    assert rgb_to_lab(np.array([0, 0, 0], dtype=np.uint8)) == pytest.approx([0, 0, 0], abs=1e-6)
    assert rgb_to_lab(np.array([255, 0, 0], dtype=np.uint8)) == pytest.approx(
        [53.2408, 80.0925, 67.2032], abs=1e-3)


async def test_python_and_sql_colour_maths_agree(engine):
    """The engine scores colours in SQL and the worker extracts them in Python.

    If the two implementations drift, a garment's stored family stops matching
    what the recommender computes — so pin them to each other.
    """
    samples = ["#1B2A4A", "#B08245", "#DC2626", "#0F766E", "#F3C9C6", "#36393F"]
    async with engine.connect() as conn:
        for hex_a in samples:
            row = (await conn.execute(
                text("select * from public.hex_to_color_row(:h)"), {"h": hex_a})).mappings().one()
            lab = hex_to_lab(hex_a)
            chroma, hue = (float(v) for v in lab_to_lch(lab))
            assert float(row["lab_l"]) == pytest.approx(lab[0], abs=1e-3)
            assert float(row["lab_a"]) == pytest.approx(lab[1], abs=1e-3)
            assert float(row["lab_b"]) == pytest.approx(lab[2], abs=1e-3)
            assert float(row["lch_h"]) == pytest.approx(hue, abs=1e-2)
            assert float(row["lch_c"]) == pytest.approx(chroma, abs=1e-2)

        for hex_a in samples:
            for hex_b in samples:
                la, lb = hex_to_lab(hex_a), hex_to_lab(hex_b)
                sql_value = (await conn.execute(
                    text("select public.ciede2000(:l1,:a1,:b1,:l2,:a2,:b2) as d"),
                    {"l1": la[0], "a1": la[1], "b1": la[2],
                     "l2": lb[0], "a2": lb[1], "b2": lb[2]})).scalar_one()
                assert float(sql_value) == pytest.approx(
                    float(ciede2000(la, lb)), abs=1e-6)


def test_extract_palette_finds_dominant_colour():
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    img[:, :70] = (27, 42, 74)        # navy, 70%
    img[:, 70:] = (176, 130, 69)      # camel, 30%
    palette = extract_palette(img, k=4)
    assert len(palette) == 2
    assert palette[0][1] == pytest.approx(0.70, abs=0.02)
    assert float(ciede2000(np.array(palette[0][2]), hex_to_lab("#1B2A4A"))) < 3
    assert float(ciede2000(np.array(palette[1][2]), hex_to_lab("#B08245"))) < 3


def test_extract_palette_respects_mask():
    img = np.zeros((60, 60, 3), dtype=np.uint8)
    img[:, :] = (200, 30, 30)         # red background — must not appear
    img[20:40, 20:40] = (27, 42, 74)  # navy garment
    mask = np.zeros((60, 60), dtype=bool)
    mask[20:40, 20:40] = True
    palette = extract_palette(img, mask, k=3)
    assert len(palette) == 1
    assert float(ciede2000(np.array(palette[0][2]), hex_to_lab("#1B2A4A"))) < 2


def test_extract_palette_merges_near_identical_clusters():
    """A shirt with a fold is one colour, not two."""
    rng = np.random.default_rng(3)
    base = np.array([27, 42, 74])
    img = np.clip(base + rng.normal(0, 4, (80, 80, 3)), 0, 255).astype(np.uint8)
    assert len(extract_palette(img, k=5)) == 1


def test_extract_palette_ignores_deep_shadow_and_blowout():
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    img[:80] = (27, 42, 74)
    img[80:90] = (2, 2, 3)            # shadow
    img[90:] = (253, 253, 253)        # blown highlight
    palette = extract_palette(img, k=5)
    assert palette[0][1] > 0.9


async def test_nearest_family_uses_ciede2000(engine):
    async with engine.connect() as conn:
        rows = (await conn.execute(
            text("select slug, anchor_hex, is_neutral from public.color_families"))).mappings().all()
    families = [dict(r) for r in rows]
    for hex_value, expected in [("#1B2A4A", "navy"), ("#B08245", "camel"),
                                ("#FFFFFF", "white"), ("#DC2626", "red"),
                                ("#0F766E", "teal")]:
        assert nearest_family(hex_to_lab(hex_value), families)[0] == expected
    assert nearest_family(hex_to_lab("#FFFFFF"), families)[1] is True   # white is neutral
