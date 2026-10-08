"""The available speech-to-text services, by name.

To add one, write a class implementing `Service` (base.py) and register a factory in FACTORIES.
Factories read their settings from the environment (or recording-to-text/.env) when the service
is first used, so a missing setting only matters for the service that needs it.
"""

from __future__ import annotations

import os

from ..types import ServiceError
from .base import Service


def _setting(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if not value:
        raise ServiceError(f"the setting {name} is missing (environment or recording-to-text/.env)")
    return value


def _google() -> Service:
    from .google import GoogleSpeech

    return GoogleSpeech(project=_setting("GOOGLE_PROJECT"), location=_setting("GOOGLE_LOCATION", "us-central1"))


def _whisper() -> Service:
    from .whisper import Whisper

    return Whisper(
        base_url=_setting("WHISPER_BASE_URL", "https://api.openai.com/v1"),
        api_key=os.getenv("WHISPER_API_KEY") or _setting("OPENAI_API_KEY"),
        model=_setting("WHISPER_MODEL", "whisper-1"),
    )


FACTORIES = {
    "google": _google,
    "whisper": _whisper,
}

_services: dict[str, Service] = {}


def get_service(name: str) -> Service:
    """The service with this name, created on first use and then reused."""
    if name not in FACTORIES:
        raise ServiceError(f"unknown service {name!r}; available: {', '.join(FACTORIES)}")
    if name not in _services:
        _services[name] = FACTORIES[name]()
    return _services[name]


async def close_all() -> None:
    for service in _services.values():
        await service.close()
    _services.clear()
