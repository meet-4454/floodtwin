"""Paths, keys and cache policy — everything environment-dependent, in one place."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.resolve()

# Load BASE_DIR/.env into os.environ if present. Silent no-op when the file or
# python-dotenv is missing, so prod (vars from the process manager) and dev
# (vars from .env) both work.
try:  # pragma: no cover - environment plumbing
    from dotenv import load_dotenv

    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass

CHUNKS_DIR = BASE_DIR / "chunks"
DEM_TILES_DIR = BASE_DIR / "static" / "dem_tiles"
DRAINAGE_DIR = BASE_DIR / "drainage" / "web"
SIM_DIR = BASE_DIR / "drainage" / "sim"
LIVE_DIR = BASE_DIR / "drainage" / "live"
STATIC_DIR = BASE_DIR / "static"
# Vite writes the React bundle here (`npm run build` in web/).
DIST_DIR = STATIC_DIR / "dist"

DEFAULT_MAPPLS_KEY = "07ed2c801ad7e2fd64b3fdffd084b0be"
ONE_WEEK_SECONDS = 60 * 60 * 24 * 7
ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

DEBUG_MODE = os.environ.get("FLASK_DEBUG", "0") == "1"


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


# Set when a reverse proxy (nginx, Caddy, a load balancer) terminates TLS in
# front of gunicorn — it makes Flask trust X-Forwarded-For/Proto, which the login
# lockout needs for real client IPs and the session cookie needs to go Secure.
BEHIND_PROXY = _flag("FLOODTWIN_BEHIND_PROXY")
# Only send the session cookie over HTTPS. Default on whenever a proxy is
# declared, because that is the deployment where TLS actually terminates; set it
# explicitly to override either way.
SESSION_COOKIE_SECURE = _flag("FLOODTWIN_SECURE_COOKIE", "1" if BEHIND_PROXY else "0")
# Hashed asset filenames make the bundle safe to cache hard; index.html must not
# be, or a deploy never reaches an open tab.
STATIC_MAX_AGE = 0


def mappls_api_key() -> str:
    return os.environ.get("MAPPLS_API_KEY", DEFAULT_MAPPLS_KEY)


def google_places_api_key() -> str:
    return os.environ.get("GOOGLE_PLACES_API_KEY", "")


# ── Console access ──────────────────────────────────────────────────────────
CONSOLE_USER = os.environ.get("FLOODTWIN_CONSOLE_USER", "mcg")
CONSOLE_PASSWORD = os.environ.get("FLOODTWIN_CONSOLE_PASSWORD", "mcgiitgandhinagar")
SESSION_LIFETIME_HOURS = int(os.environ.get("FLOODTWIN_SESSION_HOURS", "12"))


def console_credentials() -> tuple[str, str]:
    return CONSOLE_USER, CONSOLE_PASSWORD


def secret_key() -> bytes:
    """Key that signs the session cookie.

    Persisted to a file rather than generated per boot: a fresh key on every
    restart silently signs every open console out, which reads as the login
    being broken. Set FLOODTWIN_SECRET_KEY in production and this never runs.
    """
    env = os.environ.get("FLOODTWIN_SECRET_KEY", "")
    if env:
        return env.encode("utf-8")
    path = BASE_DIR / ".session_secret"
    if not path.exists():
        path.write_bytes(os.urandom(32))
        try:
            path.chmod(0o600)
        except OSError:      # non-POSIX filesystem; the key is still private enough
            pass
    return path.read_bytes()


PARTNER_BASE_URL = os.environ.get("FLOODTWIN_PARTNER_BASE_URL", "https://mcgapi.floodresq.com")
PARTNER_API_KEY = os.environ.get("FLOODTWIN_PARTNER_API_KEY", "")

GURUGRAM_CENTER = (28.4595, 77.0266)
# Deliberately tighter than the district so critical-asset markers stay in-city
# and don't pull prominent south-Delhi POIs into a Gurugram console.
DEFAULT_ASSET_BBOX = "28.37,76.95,28.51,77.10"
