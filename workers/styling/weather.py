"""Weather input for the styling engine.

Cached in `weather_snapshots` keyed by (geohash-5, hour, provider) and shared
across users. A recommendation must never fail because a weather API is down:
`resolve()` degrades to the most recent cached row for the cell, and then to
None, in which case the engine falls back to season-only reasoning.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncConnection

from api.app.db import fetch_one

from .geo import geohash_encode

log = logging.getLogger("smartstylist.weather")


@dataclass(frozen=True)
class Weather:
    temp_c: float
    feels_like_c: float | None = None
    temp_min_c: float | None = None
    temp_max_c: float | None = None
    humidity_pct: int | None = None
    wind_kph: float | None = None
    precip_prob: float = 0.0
    uv_index: float | None = None
    condition: str | None = None
    is_daylight: bool | None = None
    valid_at: datetime | None = None

    def as_dict(self) -> dict:
        d = asdict(self)
        d["valid_at"] = self.valid_at.isoformat() if self.valid_at else None
        return d

    @property
    def effective_temp_c(self) -> float:
        """What the body experiences — what layering should be chosen against."""
        return self.feels_like_c if self.feels_like_c is not None else self.temp_c


class WeatherProvider(Protocol):
    name: str

    async def fetch(self, lat: float, lon: float, at: datetime) -> Weather | None: ...


class StaticWeatherProvider:
    """Deterministic provider for tests and offline development."""

    name = "static"

    def __init__(self, weather: Weather | None = None) -> None:
        self.weather = weather or Weather(temp_c=21.0, feels_like_c=21.0, precip_prob=0.0,
                                          condition="clear", is_daylight=True)
        self.calls = 0

    async def fetch(self, lat: float, lon: float, at: datetime) -> Weather | None:
        self.calls += 1
        return Weather(**{**self.weather.as_dict(), "valid_at": at})


class OpenWeatherProvider:
    """OpenWeather One Call. httpx is imported lazily so tests need no network stack."""

    name = "openweather"

    def __init__(self, api_key: str, timeout: float = 4.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    async def fetch(self, lat: float, lon: float, at: datetime) -> Weather | None:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.get("https://api.openweathermap.org/data/3.0/onecall",
                                     params={"lat": lat, "lon": lon, "appid": self.api_key,
                                             "units": "metric", "exclude": "minutely,alerts"})
                r.raise_for_status()
                payload = r.json()
        except Exception:
            log.warning("weather fetch failed for %.3f,%.3f", lat, lon, exc_info=True)
            return None

        target = at.replace(minute=0, second=0, microsecond=0)
        hourly = payload.get("hourly") or []
        slot = min(hourly, key=lambda h: abs(h["dt"] - target.timestamp()), default=None) \
            or payload.get("current")
        if not slot:
            return None

        daily = (payload.get("daily") or [{}])[0]
        return Weather(
            temp_c=float(slot["temp"]),
            feels_like_c=float(slot.get("feels_like", slot["temp"])),
            temp_min_c=float((daily.get("temp") or {}).get("min", slot["temp"])),
            temp_max_c=float((daily.get("temp") or {}).get("max", slot["temp"])),
            humidity_pct=slot.get("humidity"),
            wind_kph=round(float(slot.get("wind_speed", 0)) * 3.6, 2),
            precip_prob=float(slot.get("pop", 0.0)),
            uv_index=slot.get("uvi"),
            condition=(slot.get("weather") or [{}])[0].get("main", "").lower() or None,
            is_daylight=bool(payload.get("current", {}).get("sunrise", 0)
                             <= slot["dt"]
                             <= payload.get("current", {}).get("sunset", 0)) or None,
            valid_at=datetime.fromtimestamp(slot["dt"], tz=UTC),
        )


class WeatherService:
    def __init__(self, provider: WeatherProvider, *, ttl_minutes: int = 60,
                 stale_hours: int = 6) -> None:
        self.provider = provider
        self.ttl = timedelta(minutes=ttl_minutes)
        self.stale = timedelta(hours=stale_hours)

    async def resolve(self, conn: AsyncConnection, lat: float, lon: float,
                      at: datetime | None = None) -> tuple[Weather | None, int | None]:
        """Return (weather, weather_snapshot_id). Both may be None."""
        at = (at or datetime.now(UTC)).astimezone(UTC)
        slot = at.replace(minute=0, second=0, microsecond=0)
        cell = geohash_encode(lat, lon, 5)

        cached = await fetch_one(conn, """
            select * from public.weather_snapshots
             where geohash5 = :cell and provider = :p and valid_at = :slot
        """, {"cell": cell, "p": self.provider.name, "slot": slot})
        if cached and (datetime.now(UTC) - cached["fetched_at"]) < self.ttl:
            return _from_row(cached), cached["id"]

        fresh = await self.provider.fetch(lat, lon, slot)
        if fresh is None:
            fallback = await fetch_one(conn, """
                select * from public.weather_snapshots
                 where geohash5 = :cell and valid_at > :floor
                 order by valid_at desc limit 1
            """, {"cell": cell, "floor": at - self.stale})
            if fallback:
                log.info("serving stale weather for %s", cell)
                return _from_row(fallback), fallback["id"]
            return None, None

        # Written through a SECURITY DEFINER validator (migration 0012): the cache
        # is shared across users, so a client must not be able to write it directly.
        row = await fetch_one(conn, """
            select public.upsert_weather_snapshot(
                cast(:cell as char(5)), :slot, :p, :t, :fl, :tmin, :tmax,
                cast(:hum as smallint), :wind, :pop, :uv, :cond, :day) as id
        """, {"cell": cell, "slot": slot, "p": self.provider.name, "t": fresh.temp_c,
              "fl": fresh.feels_like_c, "tmin": fresh.temp_min_c, "tmax": fresh.temp_max_c,
              "hum": fresh.humidity_pct, "wind": fresh.wind_kph, "pop": fresh.precip_prob,
              "uv": fresh.uv_index, "cond": fresh.condition, "day": fresh.is_daylight})
        return fresh, row["id"]


def _from_row(row) -> Weather:
    return Weather(
        temp_c=float(row["temp_c"]),
        feels_like_c=float(row["feels_like_c"]) if row["feels_like_c"] is not None else None,
        temp_min_c=float(row["temp_min_c"]) if row["temp_min_c"] is not None else None,
        temp_max_c=float(row["temp_max_c"]) if row["temp_max_c"] is not None else None,
        humidity_pct=row["humidity_pct"],
        wind_kph=float(row["wind_kph"]) if row["wind_kph"] is not None else None,
        precip_prob=float(row["precip_prob"] or 0),
        uv_index=float(row["uv_index"]) if row["uv_index"] is not None else None,
        condition=row["condition"], is_daylight=row["is_daylight"], valid_at=row["valid_at"],
    )
