"""Sound card clock calibration against a 1 Hz reference.

Every 1 ppm of sample-clock error is 0.0864 s/d of rate error, so the app
refuses to show rates until the audio device has a calibration.

The correction is defined so that   true_interval = measured_interval * (1 + ppm * 1e-6)

Two references are supported, both 1 pulse per second:
* quartz: a quartz watch's step pulse (optionally with its own known offset)
* pps:    a GPS module's 1 PPS output, usually on input channel 2
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .. import dsp

SECONDS_PER_DAY = 86_400.0
STABILITY_LIMIT_PPM = 0.5        # about 0.04 s/d
MIN_DURATION = {"quartz": 600.0, "pps": 60.0}


@dataclass
class Calibration:
    method: str
    ppm: float
    sd_equivalent: float          # s/d this correction removes
    pulses: int
    duration: float
    spread_ppm: float             # max - min across sub-windows
    stable: bool
    valid: bool                   # stable AND long enough
    chunk_ppm: list[float] = field(default_factory=list)

    def summary(self) -> str:
        state = "VALID" if self.valid else ("stable, keep running" if self.stable else "not stable yet")
        return (
            f"{self.method}: correction {self.ppm:+.2f} ppm ({self.sd_equivalent:+.2f} s/d), "
            f"{self.pulses} pulses over {self.duration:.0f} s, spread {self.spread_ppm:.2f} ppm -> {state}"
        )


def find_pulses(x: np.ndarray, sr: int) -> np.ndarray:
    """Return fractional sample positions of 1 Hz pulses."""
    hp = dsp.highpass(np.asarray(x, dtype=np.float64), sr, 1_000.0)
    env = dsp.envelope(hp, sr)
    height = 0.3 * np.percentile(env, 99.9)
    peaks = dsp.local_peaks(env, height, int(0.7 * sr))
    return np.array([dsp.parabolic_peak(env, int(p)) for p in peaks])


def _ppm_from_positions(pos: np.ndarray, sr: int, real_period: float) -> float:
    t = pos / sr
    n = np.round((t - t[0]) / np.median(np.diff(t)))
    slope = np.polyfit(n, t, 1)[0]
    return (real_period / slope - 1.0) * 1e6


def calibrate(
    x: np.ndarray,
    sr: int,
    method: str = "quartz",
    reference_offset_sd: float = 0.0,
    min_duration: float | None = None,
) -> Calibration:
    """Measure the sound card correction from a 1 Hz reference recording.

    reference_offset_sd: known rate of the quartz watch itself (s/d, + = gaining).
    Leave at 0 for GPS PPS.
    """
    if method not in MIN_DURATION:
        raise ValueError("method must be 'quartz' or 'pps'")
    if method == "pps":
        reference_offset_sd = 0.0
    pos = find_pulses(x, sr)
    if len(pos) < 10:
        raise ValueError("Fewer than 10 reference pulses found; check the reference signal")

    real_period = 1.0 / (1.0 + reference_offset_sd / SECONDS_PER_DAY)
    ppm = _ppm_from_positions(pos, sr, real_period)

    chunks = np.array_split(pos, 4) if len(pos) >= 40 else [pos]
    chunk_ppm = [_ppm_from_positions(c, sr, real_period) for c in chunks if len(c) >= 10]
    spread = float(max(chunk_ppm) - min(chunk_ppm)) if len(chunk_ppm) > 1 else float("inf")
    stable = spread <= STABILITY_LIMIT_PPM

    duration = (pos[-1] - pos[0]) / sr
    needed = MIN_DURATION[method] if min_duration is None else min_duration
    return Calibration(
        method=method,
        ppm=float(ppm),
        sd_equivalent=float(ppm * 1e-6 * SECONDS_PER_DAY),
        pulses=len(pos),
        duration=float(duration),
        spread_ppm=spread,
        stable=stable,
        valid=stable and duration >= needed,
        chunk_ppm=[float(c) for c in chunk_ppm],
    )
