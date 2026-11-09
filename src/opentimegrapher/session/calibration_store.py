"""Saved calibrations, one per audio device + sample rate.

Rules from the spec:
* no valid calibration for the device and sample rate -> measuring is blocked
* older than 30 days -> the user is prompted to recalibrate
* manual ppm entry is allowed as an override but every result is flagged
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

MAX_AGE_DAYS = 30


def store_path() -> Path:
    base = Path(os.environ.get("OTG_HOME", Path.home() / ".opentimegrapher"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "calibrations.json"


@dataclass
class SavedCalibration:
    device: str
    sample_rate: int
    method: str
    ppm: float
    created: str            # ISO 8601 UTC

    @property
    def age_days(self) -> float:
        then = datetime.fromisoformat(self.created)
        return (datetime.now(timezone.utc) - then).total_seconds() / 86_400

    @property
    def stale(self) -> bool:
        return self.age_days > MAX_AGE_DAYS


class CalibrationRequired(RuntimeError):
    pass


def _key(device: str, sample_rate: int) -> str:
    return f"{device}@{sample_rate}"


def _load() -> dict:
    p = store_path()
    return json.loads(p.read_text()) if p.exists() else {}


def save(device: str, sample_rate: int, method: str, ppm: float) -> SavedCalibration:
    data = _load()
    cal = SavedCalibration(device, sample_rate, method, ppm, datetime.now(timezone.utc).isoformat())
    data[_key(device, sample_rate)] = asdict(cal)
    store_path().write_text(json.dumps(data, indent=2))
    return cal


def get(device: str, sample_rate: int) -> SavedCalibration | None:
    raw = _load().get(_key(device, sample_rate))
    return SavedCalibration(**raw) if raw else None


def require(device: str, sample_rate: int) -> SavedCalibration:
    """Return the device's calibration or raise. Measuring must not start without one."""
    cal = get(device, sample_rate)
    if cal is None:
        raise CalibrationRequired(
            f"No calibration for '{device}' at {sample_rate} Hz. "
            "Run calibration (quartz watch or GPS 1 PPS) before measuring."
        )
    return cal
