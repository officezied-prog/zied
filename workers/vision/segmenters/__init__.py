from __future__ import annotations

from .base import Segment, SegmentationBackend
from .stub import StubSegmenter

__all__ = ["Segment", "SegmentationBackend", "StubSegmenter", "build_segmenter"]


def build_segmenter(kind: str, **kwargs) -> SegmentationBackend:
    if kind == "stub":
        return StubSegmenter()
    if kind == "yolo":
        from .yolo import YoloSegmenter

        return YoloSegmenter(weights=kwargs.get("weights", "yolo11x-seg.pt"))
    raise ValueError(f"unknown segmenter: {kind}")
