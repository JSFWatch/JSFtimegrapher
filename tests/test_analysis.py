"""Round-trip tests: synthesize audio with known values, check the analyzer recovers them.

Tolerances match the Phase 1 gate in docs/SPEC.md: 1 s/d, 0.1 ms, 5 degrees.
"""

import numpy as np
import pytest

from opentimegrapher import synth
from opentimegrapher.analysis import analyze, calibrate, detect_bph

SR = 48_000

CASES = [
    # bph,   rate,  BE ms, amplitude, lift angle
    (18_000, 0.0, 0.0, 250, 50),
    (21_600, -12.0, 0.8, 230, 52),
    (25_200, 3.0, 0.2, 300, 52),
    (28_800, 7.5, 0.6, 270, 52),
    (28_800, -25.0, 1.5, 190, 53),
    (36_000, 4.0, 0.3, 280, 49),
]


@pytest.mark.parametrize("bph,rate,be,amp,la", CASES)
def test_recovers_known_values(bph, rate, be, amp, la):
    p = synth.WatchParams(bph, rate, be, amp, la)
    x = synth.watch_ticks(p, duration=40, sr=SR, noise=0.02, seed=bph)
    r = analyze(x, SR, lift_angle=la)
    assert r.bph == bph
    assert r.rate == pytest.approx(rate, abs=1.0)
    assert r.beat_error_ms == pytest.approx(be, abs=0.1)
    assert r.amplitude == pytest.approx(amp, abs=5)
    assert r.quality > 0.95


@pytest.mark.parametrize("bph", [18_000, 19_800, 21_600, 25_200, 28_800, 36_000])
def test_auto_detects_beat_rate(bph):
    x = synth.watch_ticks(synth.WatchParams(bph=bph, beat_error_ms=0.5), duration=15, sr=SR)
    assert detect_bph(x, SR) == bph


def test_noisy_signal_still_within_gate():
    p = synth.WatchParams(28_800, 5.0, 0.4, 260, 52)
    x = synth.watch_ticks(p, duration=60, sr=SR, noise=0.08, seed=7)
    r = analyze(x, SR)
    assert r.rate == pytest.approx(5.0, abs=1.0)
    assert r.beat_error_ms == pytest.approx(0.4, abs=0.1)
    assert r.amplitude == pytest.approx(260, abs=5)


def test_uncalibrated_card_is_wrong_and_calibration_fixes_it():
    clock_ppm = 80.0  # a cheap sound card
    p = synth.WatchParams(28_800, 2.0, 0.2, 280, 52)
    x = synth.watch_ticks(p, duration=60, sr=SR, clock_ppm=clock_ppm)

    raw = analyze(x, SR)
    assert abs(raw.rate - 2.0) > 5.0  # about 6.9 s/d off without calibration

    ref = synth.pulse_train(duration=660, sr=SR, clock_ppm=clock_ppm, offset_sd=0.25)
    cal = calibrate(ref, SR, "quartz", reference_offset_sd=0.25)
    assert cal.valid
    fixed = analyze(x, SR, ppm=cal.ppm)
    assert fixed.rate == pytest.approx(2.0, abs=0.2)


def test_short_quartz_run_is_not_valid():
    ref = synth.pulse_train(duration=120, sr=SR, clock_ppm=30)
    cal = calibrate(ref, SR, "quartz")
    assert not cal.valid


def test_gps_pps_on_second_channel():
    clock_ppm = -45.0
    w = synth.watch_ticks(synth.WatchParams(rate=12.0), duration=90, sr=SR, clock_ppm=clock_ppm)
    stereo = synth.with_pps(w, SR, clock_ppm)
    cal = calibrate(stereo[:, 1], SR, "pps")
    assert cal.valid
    assert cal.ppm == pytest.approx(45.0, abs=0.5)
    r = analyze(stereo[:, 0], SR, ppm=cal.ppm)
    assert r.rate == pytest.approx(12.0, abs=0.2)


def test_rolling_windows_for_vario_and_trace():
    x = synth.watch_ticks(synth.WatchParams(rate=-3.0), duration=60, sr=SR)
    r = analyze(x, SR, window_s=10)
    assert len(r.windows) >= 4
    assert all(abs(w.rate + 3.0) < 1.5 for w in r.windows)


def test_amplitude_formula_matches_theory():
    dt = synth.unlock_to_drop_seconds(28_800, 300, 52)
    f = 28_800 / 7200
    assert 52 / (2 * np.sin(np.pi * f * dt)) == pytest.approx(300)


def test_regression_high_beat_error_low_amplitude():
    # Found by tools/sweep.py: was misread as 14,400 A/h before the rate check fix.
    p = synth.WatchParams(28_800, 31.3, 1.57, 180.5, 50.3)
    x = synth.watch_ticks(p, duration=30, sr=SR, noise=0.04, seed=0)
    r = analyze(x, SR, lift_angle=50.3)
    assert r.bph == 28_800
    assert r.beat_error_ms == pytest.approx(1.57, abs=0.1)
