"""Loads the settings files into the environment, where the services read them.

Order (first wins): real environment variables, then .env (secrets, ignored by git), then
settings.env (committed defaults). Both files are next to this package, in recording-to-text/.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


def load_settings() -> None:
    load_dotenv(ROOT / ".env", override=False)
    load_dotenv(ROOT / "settings.env", override=False)
