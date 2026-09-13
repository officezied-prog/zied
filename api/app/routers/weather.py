from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Query

from ..deps import ConnDep, PrincipalDep, SettingsDep
from ..errors import NotFound
from ..schemas import Weather
from ..styling_service import get_engine

router = APIRouter(prefix="/v1/weather", tags=["Styling"])


@router.get("", response_model=Weather)
async def get_weather(conn: ConnDep, principal: PrincipalDep, settings: SettingsDep,
                      lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                      at: datetime | None = None):
    service = get_engine(settings).weather_service
    weather, _ = await service.resolve(conn, lat, lon, at or datetime.now(UTC))
    if weather is None:
        raise NotFound("Weather", f"{lat},{lon}")
    return Weather(**weather.as_dict())
