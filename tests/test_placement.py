"""Where garments land on the body.

The rules here decide whether a jilbab reaches the ankles or sits on the chest,
so they are asserted in the terms a tailor would use rather than in pixels.
"""
from __future__ import annotations

import numpy as np
import pytest

from workers.vton.placement import (
    PLACEMENTS,
    draw_order,
    placement_for,
    suppressed_roles,
    target_box,
)
from workers.vton.preprocess import GeometricBodyParser
from workers.vton.providers import CompositeProvider, GarmentLayer, RenderRequest

W, H = 230, 470


def _person() -> np.ndarray:
    img = np.full((H, W, 3), 238, dtype=np.uint8)
    cx = W // 2
    img[int(H * .06):int(H * .16), cx - 27:cx + 27] = (228, 193, 163)   # head
    img[int(H * .16):int(H * .52), cx - 44:cx + 44] = (214, 214, 214)   # torso
    img[int(H * .52):int(H * .90), cx - 33:cx + 33] = (208, 208, 208)   # legs
    img[int(H * .90):int(H * .97), cx - 38:cx + 38] = (70, 70, 70)      # feet
    return img


def _cutout(w: int, h: int, rgb: tuple[int, int, int], pad: int = 5) -> np.ndarray:
    a = np.zeros((h, w, 4), dtype=np.uint8)
    a[..., :3] = rgb
    a[pad:h - pad, pad:w - pad, 3] = 255
    return a


@pytest.fixture(scope="module")
def zones():
    return GeometricBodyParser().parse(_person())[1]


# ── geometry ────────────────────────────────────────────────────────────────
def test_a_full_length_garment_reaches_the_ankles(zones):
    """A jilbab, abaya, thobe or maxi dress hangs shoulder to ankle.

    The first version mapped this role to the torso alone, which drew a
    floor-length garment as a crop top.
    """
    gown = target_box(zones, "full_body", W, H)
    top = target_box(zones, "base_top", W, H)
    feet = target_box(zones, "footwear", W, H)

    assert gown[3] > top[3] * 2, "it must be far longer than a shirt"
    assert gown[1] <= top[1] + 4, "it hangs from the shoulders"
    assert gown[1] + gown[3] >= feet[1] - 10, "and reaches the feet"


def test_layers_sit_wider_than_what_they_cover(zones):
    top = target_box(zones, "base_top", W, H)
    mid = target_box(zones, "mid_layer", W, H)
    coat = target_box(zones, "outerwear", W, H)
    assert top[2] < mid[2] < coat[2]


def test_trousers_start_at_the_hips_not_the_shoulders(zones):
    top = target_box(zones, "base_top", W, H)
    trousers = target_box(zones, "bottom", W, H)
    assert trousers[1] > top[1] + top[3] * 0.5


def test_shoes_rest_on_the_ground(zones):
    shoes = target_box(zones, "footwear", W, H)
    assert shoes[1] > H * 0.8
    assert placement_for("footwear").anchor_y == 1.0


def test_a_bag_is_small_and_to_one_side(zones):
    bag = target_box(zones, "bag", W, H)
    torso = target_box(zones, "base_top", W, H)
    assert bag[2] < torso[2] * 0.55, "a bag is not the width of a shirt"
    assert bag[0] < torso[0] + torso[2] * 0.35, "it hangs at one hip"


def test_headwear_covers_the_head(zones):
    hat = target_box(zones, "headwear", W, H)
    assert hat[1] < H * 0.2


def test_draw_order_dresses_from_the_inside_out():
    order = draw_order(["bag", "outerwear", "base_top", "footwear", "bottom", "belt"])
    assert order.index("base_top") < order.index("outerwear")
    assert order.index("bottom") < order.index("outerwear")
    assert order.index("outerwear") < order.index("bag")


def test_a_full_length_garment_hides_the_separates():
    assert suppressed_roles({"full_body", "base_top", "bottom", "footwear"}) \
        == {"base_top", "bottom"}
    assert suppressed_roles({"base_top", "bottom", "footwear"}) == set()


def test_every_placement_is_within_the_body():
    for role in PLACEMENTS:
        rule = placement_for(role)
        assert 0 <= rule.anchor_x <= 1, role
        assert 0 <= rule.anchor_y <= 1, role
        assert 0 < rule.width <= 1.3, role
        assert rule.span, role


# ── the render ──────────────────────────────────────────────────────────────
def test_a_full_outfit_lands_on_the_right_parts_of_the_body(zones):
    body = _person()
    mask = GeometricBodyParser().parse(body)[0]
    navy, camel, white = (27, 42, 74), (176, 130, 69), (250, 250, 250)

    result = CompositeProvider().render(RenderRequest(
        person_rgb=body, person_mask=mask, zones=zones,
        layers=[
            GarmentLayer("1", "base_top", _cutout(90, 120, navy)),
            GarmentLayer("2", "bottom", _cutout(80, 150, camel)),
            GarmentLayer("3", "footwear", _cutout(70, 34, white)),
        ],
    ))
    out = result.image_rgb
    assert result.metadata["covered"] == []

    def near(sample, target, tolerance=42):
        return all(abs(int(a) - int(b)) < tolerance for a, b in zip(sample, target))

    torso = target_box(zones, "base_top", W, H)
    legs = target_box(zones, "bottom", W, H)
    assert near(out[torso[1] + torso[3] // 2, W // 2], navy), "the shirt is on the chest"
    assert near(out[legs[1] + legs[3] // 2, W // 2], camel), "the trousers are on the legs"


def test_a_jilbab_replaces_the_separates_in_the_render(zones):
    body = _person()
    mask = GeometricBodyParser().parse(body)[0]
    green = (34, 58, 42)

    result = CompositeProvider().render(RenderRequest(
        person_rgb=body, person_mask=mask, zones=zones,
        layers=[
            GarmentLayer("1", "base_top", _cutout(90, 120, (27, 42, 74))),
            GarmentLayer("2", "bottom", _cutout(80, 150, (176, 130, 69))),
            GarmentLayer("3", "full_body", _cutout(96, 260, green)),
            GarmentLayer("4", "footwear", _cutout(70, 34, (60, 45, 35))),
        ],
    ))

    assert set(result.metadata["covered"]) == {"base_top", "bottom"}
    assert "full_body" in result.metadata["drawn"]

    out = result.image_rgb
    # The gown's colour should be present on the chest *and* down at the knees.
    gown = target_box(zones, "full_body", W, H)
    for fraction in (0.2, 0.55, 0.85):
        y = gown[1] + int(gown[3] * fraction)
        pixel = out[y, W // 2]
        assert all(abs(int(a) - int(b)) < 48 for a, b in zip(pixel, green)), \
            f"the gown should cover the body at {int(fraction * 100)}% of its length"


def test_the_face_survives_a_full_outfit(zones):
    body = _person()
    mask = GeometricBodyParser().parse(body)[0]
    result = CompositeProvider().render(RenderRequest(
        person_rgb=body, person_mask=mask, zones=zones,
        layers=[
            GarmentLayer("1", "full_body", _cutout(96, 260, (34, 58, 42))),
            GarmentLayer("2", "headwear", _cutout(60, 40, (200, 162, 104))),
            GarmentLayer("3", "bag", _cutout(46, 52, (110, 27, 46))),
        ],
        preserve_face=True,
    ))
    fx, fy, fw, fh = zones.pixel_box("head", W, H)
    assert np.array_equal(result.image_rgb[fy:fy + fh, fx:fx + fw],
                          body[fy:fy + fh, fx:fx + fw])
