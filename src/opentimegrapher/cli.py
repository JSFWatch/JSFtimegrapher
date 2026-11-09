"""Command line interface: `otg synth`, `otg calibrate`, `otg analyze`.

This is the Phase 1 test harness. The desktop UI will call the same functions.
"""

from __future__ import annotations

import argparse
import sys

from . import synth
from .analysis.calibration import calibrate
from .analysis.watch import analyze
from .audio_io import read_wav, write_wav
from .session import calibration_store as store


def _synth(a: argparse.Namespace) -> int:
    if a.kind == "watch":
        p = synth.WatchParams(a.bph, a.rate, a.beat_error, a.amplitude, a.lift_angle)
        x = synth.watch_ticks(p, a.duration, a.sr, a.noise, a.clock_ppm, a.seed)
        if a.pps:
            x = synth.with_pps(x, a.sr, a.clock_ppm)
    else:
        x = synth.pulse_train(a.duration, a.sr, a.reference_offset, a.clock_ppm,
                              a.noise, sharp=(a.kind == "pps"), seed=a.seed)
    write_wav(a.out, x, a.sr)
    print(f"Wrote {a.out} ({a.duration:g} s, {a.sr} Hz)")
    return 0


def _calibrate(a: argparse.Namespace) -> int:
    x, sr = read_wav(a.wav, a.channel)
    cal = calibrate(x, sr, a.method, a.reference_offset, a.min_duration)
    print(cal.summary())
    if not cal.valid:
        print("Calibration NOT saved. Keep recording until it is stable and long enough.")
        return 2
    store.save(a.device, sr, cal.method, cal.ppm)
    print(f"Saved for '{a.device}' at {sr} Hz. Measuring is unlocked.")
    return 0


def _analyze(a: argparse.Namespace) -> int:
    x, sr = read_wav(a.wav, a.channel)
    flag = ""
    if a.manual_ppm is not None:
        ppm = a.manual_ppm
        flag = "  [FLAGGED: manual ppm override, not a measured calibration]"
    else:
        try:
            cal = store.require(a.device, sr)
        except store.CalibrationRequired as e:
            print(e, file=sys.stderr)
            return 3
        ppm = cal.ppm
        if cal.stale:
            print(f"Calibration is {cal.age_days:.0f} days old. Recalibrate soon.", file=sys.stderr)
        flag = f"  [calibrated: {cal.method}, {cal.created[:10]}, {cal.ppm:+.2f} ppm]"

    res = analyze(x, sr, a.bph, a.lift_angle, ppm, a.window)
    print(res.summary() + flag)
    if a.verbose and res.windows:
        print("\n  start   rate s/d   amp deg   BE ms")
        for w in res.windows:
            print(f"  {w.start:5.0f}   {w.rate:+8.1f}   {w.amplitude:7.0f}   {w.beat_error_ms:5.1f}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="otg", description="OpenTimegrapher command line tools")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("synth", help="generate test audio with known values")
    s.add_argument("kind", choices=["watch", "quartz", "pps"])
    s.add_argument("out")
    s.add_argument("--bph", type=int, default=28_800)
    s.add_argument("--rate", type=float, default=0.0, help="s/d, + = gaining")
    s.add_argument("--beat-error", type=float, default=0.0, help="ms")
    s.add_argument("--amplitude", type=float, default=280.0)
    s.add_argument("--lift-angle", type=float, default=52.0)
    s.add_argument("--duration", type=float, default=30.0)
    s.add_argument("--sr", type=int, default=48_000)
    s.add_argument("--noise", type=float, default=0.02)
    s.add_argument("--clock-ppm", type=float, default=0.0, help="simulated sound card clock error")
    s.add_argument("--reference-offset", type=float, default=0.0, help="quartz watch's own s/d")
    s.add_argument("--pps", action="store_true", help="add GPS PPS on channel 2 (watch only)")
    s.add_argument("--seed", type=int, default=0)
    s.set_defaults(func=_synth)

    c = sub.add_parser("calibrate", help="measure the sound card correction (required before analyze)")
    c.add_argument("wav")
    c.add_argument("--device", required=True, help="audio device name")
    c.add_argument("--method", choices=["quartz", "pps"], default="quartz")
    c.add_argument("--channel", type=int, default=0, help="input channel holding the reference")
    c.add_argument("--reference-offset", type=float, default=0.0, help="quartz watch's known s/d")
    c.add_argument("--min-duration", type=float, default=None, help="override minimum run length (testing)")
    c.set_defaults(func=_calibrate)

    z = sub.add_parser("analyze", help="measure a watch recording")
    z.add_argument("wav")
    z.add_argument("--device", default="default", help="audio device name used to record")
    z.add_argument("--channel", type=int, default=0)
    z.add_argument("--bph", type=int, default=None, help="force beat rate (auto if omitted)")
    z.add_argument("--lift-angle", type=float, default=52.0)
    z.add_argument("--window", type=float, default=10.0, help="seconds per rolling reading")
    z.add_argument("--manual-ppm", type=float, default=None, help="Advanced: override calibration (flagged)")
    z.add_argument("-v", "--verbose", action="store_true")
    z.set_defaults(func=_analyze)

    a = ap.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    raise SystemExit(main())
