"""Process-wide styling engine, wired from settings."""
from __future__ import annotations

from .config import Settings, get_settings

_engine = None


def get_engine(settings: Settings | None = None):
    global _engine
    if _engine is None:
        from workers.styling.engine import StylingEngine
        from workers.styling.weather import (
            OpenWeatherProvider,
            StaticWeatherProvider,
            WeatherService,
        )

        s = settings or get_settings()
        provider = (OpenWeatherProvider(s.weather_api_key) if s.weather_api_key
                    else StaticWeatherProvider())
        _engine = StylingEngine(weather_service=WeatherService(provider))
    return _engine


def reset_engine() -> None:
    """Test hook."""
    global _engine
    _engine = None
