"""Synthetic test signals with known ground truth.

Everything here is generated from first principles so the analyzer can be
checked against exact answers:

* watch ticks with a set rate, beat error, amplitude and lift angle
* quartz watch step pulses (1 per second, optional known offset)
* GPS 1 PPS pulses on a second channel

`clock_ppm` simulates a sound card whose sample clock is off. A positive value
means the card's clock runs fast, so it records more samples per real second
and every interval looks longer than it really is.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

SECONDS_PER_DAY = 86_400.0


@dataclass
class WatchParams:
    bph: int = 28_800             # beats per hour (A/h)
    rate: float = 0.0             # s/d, positive = gaining
    beat_error_ms: float = 0.0    # ms
    amplitude: float = 280.0      # degrees
    lift_angle: float = 52.0      # degrees


def unlock_to_drop_seconds(bph: int, amplitude: float, lift_angle: float) -> float:
    """Time the balance takes to cross the lift angle at a given amplitude.

    Balance motion is theta(t) = A * sin(2*pi*f*t). The escapement is engaged
    while theta is between -LA/2 and +LA/2, which it crosses in
    arcsin(LA / 2A) / (pi * f) seconds.
    """
    f = bph / 7200.0
    return float(np.arcsin(lift_angle / (2.0 * amplitude)) / (np.pi * f))


def _burst(sr: int, freq: float, decay_s: float, length_s: float) -> np.ndarray:
    t = np.arange(int(length_s * sr)) / sr
    return np.sin(2 * np.pi * freq * t) * np.exp(-t / decay_s)


def _place(out: np.ndarray, start: float, burst: np.ndarray, gain: float) -> None:
    """Add a burst at a fractional sample position using linear interpolation."""
    i = int(np.floor(start))
    frac = start - i
    n = len(burst)
    if i < 0 or i + n + 1 >= len(out):
        return
    out[i:i + n] += gain * (1 - frac) * burst
    out[i + 1:i + n + 1] += gain * frac * burst


def watch_ticks(
    params: WatchParams,
    duration: float = 30.0,
    sr: int = 48_000,
    noise: float = 0.02,
    clock_ppm: float = 0.0,
    seed: int | None = 0,
) -> np.ndarray:
    """Return a mono float32 signal of a ticking watch."""
    rng = np.random.default_rng(seed)
    n_samples = int(duration * sr)
    out = np.zeros(n_samples, dtype=np.float64)

    t_nom = 3600.0 / params.bph
    t_beat = t_nom / (1.0 + params.rate / SECONDS_PER_DAY)
    be = params.beat_error_ms / 1000.0
    dt_drop = unlock_to_drop_seconds(params.bph, params.amplitude, params.lift_angle)
    dt_impulse = dt_drop * 0.45

    unlock = _burst(sr, 6_200, 0.00025, 0.002)
    impulse = _burst(sr, 4_800, 0.00035, 0.002)
    drop = _burst(sr, 5_500, 0.0004, 0.003)

    samples_per_real_second = sr * (1.0 + clock_ppm * 1e-6)
    t = 0.05
    k = 0
    while t < duration - 0.05:
        s = t * samples_per_real_second
        g = 1.0 + rng.normal(0, 0.05)
        _place(out, s, unlock, 0.6 * g)
        _place(out, s + dt_impulse * samples_per_real_second, impulse, 0.4 * g)
        _place(out, s + dt_drop * samples_per_real_second, drop, 1.0 * g)
        t += t_beat + (be if k % 2 == 0 else -be)
        k += 1

    out += rng.normal(0, noise, n_samples)
    out /= max(1.0, np.max(np.abs(out)) * 1.1)
    return out.astype(np.float32)


def pulse_train(
    duration: float = 60.0,
    sr: int = 48_000,
    offset_sd: float = 0.0,
    clock_ppm: float = 0.0,
    noise: float = 0.02,
    sharp: bool = False,
    seed: int | None = 0,
) -> np.ndarray:
    """1 Hz pulses. sharp=False sounds like a quartz step; sharp=True is a GPS PPS edge.

    offset_sd is how fast the reference itself runs (quartz watches drift a bit).
    """
    rng = np.random.default_rng(seed)
    n_samples = int(duration * sr)
    out = np.zeros(n_samples, dtype=np.float64)
    period = 1.0 / (1.0 + offset_sd / SECONDS_PER_DAY)
    if sharp:
        pulse = np.zeros(int(0.002 * sr))
        pulse[: int(0.0001 * sr) + 1] = 1.0
    else:
        pulse = _burst(sr, 3_000, 0.0006, 0.004)
    samples_per_real_second = sr * (1.0 + clock_ppm * 1e-6)
    t = 0.2
    while t < duration - 0.1:
        _place(out, t * samples_per_real_second, pulse, 1.0)
        t += period
    out += rng.normal(0, noise, n_samples)
    out /= max(1.0, np.max(np.abs(out)) * 1.1)
    return out.astype(np.float32)


def with_pps(watch: np.ndarray, sr: int, clock_ppm: float, seed: int | None = 1) -> np.ndarray:
    """Stack a watch signal (channel 0) with a GPS PPS signal (channel 1)."""
    pps = pulse_train(len(watch) / sr, sr, 0.0, clock_ppm, noise=0.005, sharp=True, seed=seed)
    n = min(len(watch), len(pps))
    return np.stack([watch[:n], pps[:n]], axis=1)
