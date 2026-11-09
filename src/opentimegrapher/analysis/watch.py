"""Watch analysis: beat rate detection, beat timing, rate, beat error, amplitude.

Math (standard horology, see docs/SPEC.md):

    rate (s/d)  = 86400 * (T_nom / T_meas - 1)
    BE (ms)     = |a - b| / 2          a = tick->tock, b = tock->tick
    amplitude   = LA / (2 * sin(pi * f * dt))
                  f = balance frequency (A/h / 7200), dt = unlock-to-drop time
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .. import dsp

STANDARD_BPH = (14_400, 18_000, 19_800, 21_600, 25_200, 28_800, 36_000, 43_200)
SECONDS_PER_DAY = 86_400.0


@dataclass
class Beat:
    time: float        # seconds, unlock sound
    drop_dt: float     # seconds from unlock to drop
    index: int         # beat number counted from the first beat
    tick: bool         # True for even beats


@dataclass
class WindowReading:
    start: float
    rate: float
    beat_error_ms: float
    amplitude: float


@dataclass
class WatchResult:
    bph: int
    lift_angle: float
    ppm_correction: float
    rate: float                 # s/d
    beat_error_ms: float
    amplitude: float            # degrees
    beats_found: int
    beats_expected: int
    quality: float              # 0..1, share of expected beats found
    windows: list[WindowReading] = field(default_factory=list)

    def summary(self) -> str:
        return (
            f"{self.bph} A/h | rate {self.rate:+.1f} s/d | "
            f"amplitude {self.amplitude:.0f} deg | beat error {self.beat_error_ms:.1f} ms | "
            f"LA {self.lift_angle:g} | signal quality {self.quality:.0%}"
        )


def detect_bph(x: np.ndarray, sr: int, candidates=STANDARD_BPH, max_seconds: float = 20.0) -> int:
    """Pick the beat rate whose full-cycle lag shows the strongest self-similarity."""
    seg = x[: int(max_seconds * sr)]
    env = dsp.smooth(dsp.envelope(dsp.highpass(seg, sr), sr), sr, 0.006)
    step = max(1, sr // 4_000)
    env = env[::step] - np.mean(env[::step])
    fs = sr / step
    n = len(env)
    spec = np.fft.rfft(env, 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    ac /= ac[0] if ac[0] else 1.0

    def peak_at(lag_s: float) -> float:
        lag = lag_s * fs
        pad = lag * 0.01 + 0.002 * fs  # absorbs rate offset and beat error
        lo, hi = int(lag - pad), int(lag + pad) + 1
        return float(np.max(ac[lo:hi])) if hi < n // 2 else float("nan")

    scores = {}
    for bph in candidates:
        beat = 3600.0 / bph
        # A true rate repeats at one beat AND at a full tick-tock cycle.
        # Checking both stops a 36,000 A/h guess matching an 18,000 A/h watch.
        s = min(peak_at(beat), peak_at(2 * beat))
        if not np.isnan(s):
            scores[bph] = s
    if not scores:
        raise ValueError("Recording too short to detect beat rate")
    best = max(scores.values())
    # Multiples of the true period also score high, so take the fastest strong one.
    return max(b for b, s in scores.items() if s >= 0.6 * best)


def find_beats(x: np.ndarray, sr: int, bph: int) -> list[Beat]:
    t_nom = 3600.0 / bph
    hp = dsp.highpass(x, sr)
    fine = dsp.envelope(hp, sr)
    coarse = dsp.smooth(fine, sr, 0.003)

    noise_floor = 3.0 * np.median(fine)
    floor = np.percentile(coarse, 99.5)
    centers = dsp.local_peaks(coarse, 0.25 * floor, int(0.6 * t_nom * sr))

    half = int(min(0.03, 0.4 * t_nom) * sr)
    raw: list[tuple[float, float]] = []
    for c in centers:
        lo, hi = max(0, c - half), min(len(fine), c + half)
        w = fine[lo:hi]
        if len(w) < 3:
            continue
        pk = dsp.local_peaks(w, max(0.3 * np.max(w), noise_floor), int(0.0005 * sr))
        if len(pk) < 2:
            continue
        unlock = lo + dsp.parabolic_peak(w, pk[0])
        drop = lo + dsp.parabolic_peak(w, pk[-1])
        raw.append((unlock / sr, (drop - unlock) / sr))

    if len(raw) < 4:
        return []

    # The nominal beat period is within about 1% of the real one for any watch
    # worth measuring, which is plenty to count the beats in a gap.
    period = t_nom
    # Count beats step by step so small period errors never accumulate,
    # and missed beats skip an index instead of flipping tick/tock.
    beats: list[Beat] = [Beat(float(raw[0][0]), float(raw[0][1]), 0, True)]
    for t, d in raw[1:]:
        step = int(round((t - beats[-1].time) / period))
        if step < 1:
            continue
        n = beats[-1].index + step
        beats.append(Beat(time=float(t), drop_dt=float(d), index=n, tick=(n % 2 == 0)))
    return beats


def _fit(beats: list[Beat], bph: int, lift_angle: float, ppm: float) -> tuple[float, float, float]:
    scale = 1.0 + ppm * 1e-6
    t = np.array([b.time for b in beats]) * scale
    n = np.array([b.index for b in beats], dtype=float)
    odd = np.array([0.0 if b.tick else 1.0 for b in beats])
    design = np.column_stack([np.ones_like(n), n, odd])
    keep = np.ones(len(t), dtype=bool)
    for _ in range(3):  # robust fit: drop beats far off the line, refit
        (t0, period, offset), *_ = np.linalg.lstsq(design[keep], t[keep], rcond=None)
        resid = t - design @ np.array([t0, period, offset])
        mad = np.median(np.abs(resid[keep] - np.median(resid[keep]))) or 1e-9
        new_keep = np.abs(resid - np.median(resid[keep])) < 4 * 1.4826 * mad
        if new_keep.sum() < 6 or np.array_equal(new_keep, keep):
            break
        keep = new_keep

    t_nom = 3600.0 / bph
    rate = SECONDS_PER_DAY * (t_nom / period - 1.0)
    beat_error_ms = abs(offset) * 1000.0

    dt = np.median([b.drop_dt for b in beats]) * scale
    f = bph / 7200.0
    s = np.sin(np.pi * f * dt)
    amplitude = lift_angle / (2.0 * s) if s > 0 else float("nan")
    return float(rate), float(beat_error_ms), float(amplitude)


def analyze(
    x: np.ndarray,
    sr: int,
    bph: int | None = None,
    lift_angle: float = 52.0,
    ppm: float = 0.0,
    window_s: float = 10.0,
) -> WatchResult:
    """Analyze a mono recording. ppm is the calibration correction for this audio device."""
    x = np.asarray(x, dtype=np.float64)
    if bph is None:
        bph = detect_bph(x, sr)
    beats = find_beats(x, sr, bph)
    if len(beats) < 6:
        raise ValueError("Not enough clean beats found; check pickup placement and gain")

    rate, be, amp = _fit(beats, bph, lift_angle, ppm)

    duration = len(x) / sr
    expected = max(1, int((beats[-1].time - beats[0].time) / (3600.0 / bph)) + 1)

    windows: list[WindowReading] = []
    if window_s and duration >= 2 * window_s:
        start = beats[0].time
        while start + window_s <= beats[-1].time:
            chunk = [b for b in beats if start <= b.time < start + window_s]
            if len(chunk) >= 6:
                r, e, a = _fit(chunk, bph, lift_angle, ppm)
                windows.append(WindowReading(start, r, e, a))
            start += window_s

    return WatchResult(
        bph=bph,
        lift_angle=lift_angle,
        ppm_correction=ppm,
        rate=rate,
        beat_error_ms=be,
        amplitude=amp,
        beats_found=len(beats),
        beats_expected=expected,
        quality=min(1.0, len(beats) / expected),
        windows=windows,
    )
