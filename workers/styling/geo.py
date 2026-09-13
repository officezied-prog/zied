"""Geohash encoding.

Weather is cached per geohash-5 cell (about 5 x 5 km), so everyone in the same
neighbourhood shares one upstream call instead of one call per user per request.
"""
from __future__ import annotations

_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash_encode(lat: float, lon: float, precision: int = 5) -> str:
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("coordinates out of range")

    lat_range, lon_range = [-90.0, 90.0], [-180.0, 180.0]
    out: list[str] = []
    bits, bit, even = 0, 0, True

    while len(out) < precision:
        if even:
            mid = sum(lon_range) / 2
            if lon > mid:
                bits = (bits << 1) | 1
                lon_range[0] = mid
            else:
                bits <<= 1
                lon_range[1] = mid
        else:
            mid = sum(lat_range) / 2
            if lat > mid:
                bits = (bits << 1) | 1
                lat_range[0] = mid
            else:
                bits <<= 1
                lat_range[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(_BASE32[bits])
            bits, bit = 0, 0
    return "".join(out)
