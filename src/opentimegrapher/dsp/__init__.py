"""Signal conditioning: filtering, envelopes and sub-sample peak timing."""

from __future__ import annotations

import numpy as np
from scipy import signal as sps


def highpass(x: np.ndarray, sr: int, cutoff: float = 2_000.0) -> np.ndarray:
    """4th-order zero-phase high-pass to remove hum, handling noise and rumble."""
    cutoff = min(cutoff, 0.4 * sr)
    sos = sps.butter(4, cutoff, btype="highpass", fs=sr, output="sos")
    return sps.sosfiltfilt(sos, x)


def envelope(x: np.ndarray, sr: int, smooth_s: float = 0.0002) -> np.ndarray:
    """Amplitude envelope: Hilbert magnitude, lightly smoothed."""
    env = np.abs(sps.hilbert(x))
    n = max(1, int(smooth_s * sr))
    if n > 1:
        env = np.convolve(env, np.ones(n) / n, mode="same")
    return env


def smooth(x: np.ndarray, sr: int, window_s: float) -> np.ndarray:
    n = max(1, int(window_s * sr))
    return np.convolve(x, np.ones(n) / n, mode="same")


def parabolic_peak(y: np.ndarray, i: int) -> float:
    """Refine an integer peak index to a fractional one with a parabola fit."""
    if i <= 0 or i >= len(y) - 1:
        return float(i)
    a, b, c = y[i - 1], y[i], y[i + 1]
    denom = a - 2 * b + c
    if denom == 0:
        return float(i)
    return i + 0.5 * (a - c) / denom


def local_peaks(y: np.ndarray, min_height: float, min_distance: int) -> np.ndarray:
    peaks, _ = sps.find_peaks(y, height=min_height, distance=max(1, min_distance))
    return peaks
