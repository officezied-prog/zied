"""Where each garment goes on the body, and how big it is.

The first version mapped every role to a single body zone and centred the
cutout inside it. That is wrong in ways you see immediately: a full-length
garment — a jilbab, an abaya, a thobe, a maxi dress — was squeezed onto the
chest, a bag was drawn across the stomach, and a coat was the same width as the
shirt underneath it.

Placement is now a rule per role, expressed in the terms a tailor uses:
which part of the body the garment spans, how wide it sits relative to that
part, where it hangs from, and what it covers up.
"""
from __future__ import annotations

from dataclasses import dataclass

from .preprocess import BodyZones


@dataclass(frozen=True)
class Placement:
    """How one garment role sits on the body.

    span:     the body zones the garment covers, first to last.
    width:    fraction of the span's measured body width. Over 1.0 for layers
              worn on top of something else.
    anchor_x: 0 = left edge of the body, 0.5 = centred, 1 = right edge.
    anchor_y: 0 = hangs from the top of its span, 1 = rests on the bottom.
    z:        draw order — larger is nearer the viewer.
    stretch:  a garment that should fill its span vertically rather than keep
              its own aspect ratio (trousers on long legs, a maxi dress).
    """
    span: tuple[str, ...]
    width: float = 1.0
    anchor_x: float = 0.5
    anchor_y: float = 0.0
    z: int = 5
    stretch: bool = False


# Ordered by how clothes are actually worn, innermost first.
PLACEMENTS: dict[str, Placement] = {
    "hosiery":   Placement(("legs",),                  width=0.95, z=0, stretch=True),
    "base_top":  Placement(("torso",),                 width=1.00, z=1),
    # A jilbab, abaya, thobe, kaftan or maxi dress hangs from the shoulders to
    # the ankles — the single most common garment shape this app has to get
    # right, and the one the old single-zone mapping got most wrong.
    "full_body": Placement(("torso", "hips", "legs"),  width=1.10, z=1, stretch=True),
    "bottom":    Placement(("hips", "legs"),           width=1.02, z=2, stretch=True),
    "belt":      Placement(("hips",),                  width=1.04, anchor_y=0.1, z=3),
    "mid_layer": Placement(("torso",),                 width=1.08, z=4),
    "outerwear": Placement(("torso", "hips"),          width=1.16, z=5, stretch=True),
    "scarf":     Placement(("torso",),                 width=0.72, anchor_y=0.0, z=6),
    "footwear":  Placement(("feet",),                  width=1.00, anchor_y=1.0, z=7),
    # Carried, not worn: a bag hangs at one side, at hip height, small.
    "bag":       Placement(("hips",),  width=0.42, anchor_x=0.04, anchor_y=0.45, z=8),
    "headwear":  Placement(("head",),  width=1.06, anchor_y=0.0,  z=9),
    "eyewear":   Placement(("head",),  width=0.62, anchor_y=0.42, z=10),
    "jewelry":   Placement(("torso",), width=0.30, anchor_y=0.02, z=10),
    "watch":     Placement(("hips",),  width=0.13, anchor_x=0.98, anchor_y=0.15, z=10),
    "other_accessory": Placement(("torso",), width=0.34, anchor_y=0.30, z=10),
}

DEFAULT = Placement(("torso",))

# A full-length garment hides what a separate top and bottom would show, so the
# engine must not draw both. Keys are covered by the value's role.
SUPPRESSED_BY: dict[str, frozenset[str]] = {
    "full_body": frozenset({"base_top", "bottom"}),
}


def placement_for(role: str) -> Placement:
    return PLACEMENTS.get(role, DEFAULT)


def draw_order(roles: list[str]) -> list[str]:
    return sorted(roles, key=lambda r: placement_for(r).z)


def suppressed_roles(roles: set[str]) -> set[str]:
    """Roles that another garment in the look already covers."""
    hidden: set[str] = set()
    for role in roles:
        hidden |= SUPPRESSED_BY.get(role, frozenset())
    return hidden & roles


def target_box(zones: BodyZones, role: str, width: int, height: int
               ) -> tuple[int, int, int, int]:
    """Pixel box (x, y, w, h) this role should be drawn into.

    The span's vertical extent comes from its first and last zone; its width is
    the *body's* measured width across that span, so a garment tracks the
    shoulders where it is worn on the shoulders and the ankles where it reaches
    the ankles, instead of being scaled to one bounding box.
    """
    rule = placement_for(role)
    boxes = [zones.pixel_box(zone, width, height) for zone in rule.span
             if zone in zones.zones]
    if not boxes:
        boxes = [zones.pixel_box("torso", width, height)]

    top = min(b[1] for b in boxes)
    bottom = max(b[1] + b[3] for b in boxes)
    # Width is taken from the widest point the garment actually spans: a coat
    # follows the shoulders, trousers follow the hips.
    body_w = max(b[2] for b in boxes)
    body_x = min(b[0] for b in boxes)

    span_h = max(1, bottom - top)
    box_w = max(1, round(body_w * rule.width))

    # anchor_x slides the garment across the body: 0.5 keeps it centred, 0.04
    # tucks a bag against the left hip.
    x = round(body_x + (body_w - box_w) * rule.anchor_x)
    return x, top, box_w, span_h
