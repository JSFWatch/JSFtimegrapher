"""Randomized accuracy sweep. Run: python tools/sweep.py [cases] [seed]

Generates random watches (rate, beat error, amplitude, lift angle, noise) and
reports any reading outside the Phase 1 gate: 1 s/d, 0.1 ms, 5 degrees.
"""

import sys

import numpy as np

from opentimegrapher import synth
from opentimegrapher.analysis.watch import analyze

RATES = [18_000, 19_800, 21_600, 25_200, 28_800, 36_000]


def main(cases: int = 50, seed: int = 0) -> int:
    rng = np.random.default_rng(seed)
    sr = 48_000
    bad = 0
    for i in range(cases):
        p = synth.WatchParams(int(rng.choice(RATES)), rng.uniform(-60, 60), rng.uniform(0, 2),
                              rng.uniform(160, 320), rng.uniform(44, 58))
        noise = rng.uniform(0.005, 0.1)
        x = synth.watch_ticks(p, 30, sr, noise, seed=seed * 1000 + i)
        try:
            r = analyze(x, sr, lift_angle=p.lift_angle)
        except ValueError as e:
            bad += 1
            print("ERROR", p, e)
            continue
        ok = (r.bph == p.bph and abs(r.rate - p.rate) < 1
              and abs(r.beat_error_ms - p.beat_error_ms) < 0.1 and abs(r.amplitude - p.amplitude) < 5)
        if not ok:
            bad += 1
            print("MISS ", p, f"noise={noise:.3f}", "->", r.summary())
    print(f"{cases - bad}/{cases} within gate")
    return 1 if bad else 0


if __name__ == "__main__":
    args = [int(a) for a in sys.argv[1:3]]
    raise SystemExit(main(*args))
