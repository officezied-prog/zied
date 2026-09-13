"""Detector vocabulary -> taxonomy, against the real seeded taxonomy."""
from __future__ import annotations

import pytest
from sqlalchemy import text

from workers.vision.labels import build_mapper


@pytest.fixture
async def mapper(engine):
    async with engine.connect() as conn:
        rows = (await conn.execute(text("""
            select id, slug, display_name, level, default_role::text as default_role, synonyms
              from public.garment_categories where is_active
        """))).mappings().all()
    return build_mapper(rows)


@pytest.mark.parametrize(("label", "expected"), [
    # DeepFashion2 class names
    ("short_sleeved_shirt", "t_shirt"),
    ("long_sleeved_shirt", "shirt"),
    ("long_sleeved_outwear", "jacket"),
    ("short_sleeved_dress", "dress"),
    ("sling_dress", "dress"),
    ("trousers", "trousers"),
    ("shorts", "shorts"),
    ("skirt", "skirt"),
    # ModaNet / Fashionpedia
    ("footwear", "sneakers"),
    ("headwear", "hat"),
    ("bag", "handbag"),
    ("outer", "jacket"),
    # natural language
    ("white sneakers", "minimal_sneakers"),
    ("chelsea boots", "ankle_boots"),
    ("jean jacket", "denim_jacket"),
    ("roll neck", "turtleneck"),
    ("hijab", "hijab"),
    ("kaftan", "abaya"),
])
def test_known_labels_map(mapper, label, expected):
    match = mapper.map(label)
    assert match is not None, f"{label} did not map"
    assert match.category.slug == expected


def test_specific_category_beats_generic(mapper):
    assert mapper.map("denim jacket").category.slug == "denim_jacket"
    assert mapper.map("jacket").category.slug == "jacket"


def test_unknown_label_returns_none(mapper):
    """Unmapped labels must fall through to review, never guess."""
    for label in ("banana", "office chair", ""):
        assert mapper.map(label) is None


def test_mapping_carries_a_score(mapper):
    match = mapper.map("short sleeve top")
    assert match.score == 1.0 and match.matched_on == "exact"
