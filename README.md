# OpenTimegrapher

Free, open-source timegrapher for mechanical watches. Measures **rate (s/d)**, **amplitude (deg)** and **beat error (ms)** from any USB audio pickup, on Windows, macOS and Linux.

> Status: **Phase 1, engine only.** The measurement engine, mandatory sound card calibration and a command line tool work and are tested. Live capture and the desktop UI come next.

## Why calibration is mandatory

A sound card's clock is rarely exact. Every 1 ppm of clock error adds 0.0864 s/d of rate error, so a typical card that's 20 to 100 ppm off would misread a watch by roughly 2 to 9 s/d. OpenTimegrapher will not show rates until the audio device has a calibration from one of these:

| Method | What you need | Run time |
| --- | --- | --- |
| Quartz watch | Any quartz watch on the pickup (enter its known s/d offset if you have it) | 10 min minimum, must hold within 0.5 ppm |
| GPS 1 PPS | A GPS module's 1 PPS output into input channel 2 | About 60 s |

Calibrations are stored per audio device and sample rate. Changing either forces a new one, and you'll be prompted after 30 days. A manual ppm override exists for advanced use, and every result that uses it is flagged.

## Quick start

```bash
pip install -e ".[dev]"

# 1. Calibrate the sound card (record ~10 min of a quartz watch first)
otg calibrate quartz_recording.wav --device "USB Audio" --method quartz

# 2. Measure a watch recorded on the same device
otg analyze watch_recording.wav --device "USB Audio" --lift-angle 52 -v
```

GPS reference on channel 2 of the same recording:

```bash
otg calibrate recording.wav --device "USB Audio" --method pps --channel 1
otg analyze   recording.wav --device "USB Audio" --channel 0
```

No hardware yet? Generate test audio with known answers:

```bash
otg synth quartz ref.wav --duration 660 --clock-ppm 60
otg synth watch  w.wav --rate 7.5 --beat-error 0.6 --amplitude 270 --clock-ppm 60
otg calibrate ref.wav --device sim
otg analyze w.wav --device sim        # -> rate +7.5 s/d, 270 deg, 0.6 ms
```

## How it measures

| Reading | Formula |
| --- | --- |
| Rate | 86400 x (T_nominal / T_measured - 1) |
| Beat error | abs(tick-to-tock - tock-to-tick) / 2 |
| Amplitude | lift angle / (2 x sin(pi x f x dt)), f = A/h / 7200, dt = unlock-to-drop time |

Beat rate is auto-detected (14,400 to 43,200 A/h) or set with `--bph`.

## Accuracy so far (synthetic signals)

All 23 tests pass, and a randomized sweep (`python tools/sweep.py 80`) lands 80/80 cases inside the Phase 1 gate of 1 s/d, 0.1 ms and 5 deg. The cases cover 18,000 to 36,000 A/h, rates of plus or minus 60 s/d, beat error 0 to 2 ms, amplitude 160 to 320 deg and heavy noise. Real-watch validation against a reference timegrapher is the next gate.

## Layout

```
src/opentimegrapher/
  dsp/          filters, envelope, peak timing
  analysis/     watch.py (rate, BE, amplitude), calibration.py
  session/      calibration_store.py (per-device, 30-day rule)
  capture/      live audio (next)
  ui/views/     Diagram, Vario, Trace, Sequence, Polar, Scope (next)
  export/       CSV and PDF (Phase 3)
  synth.py      test signal generator
  cli.py        otg command
tests/          pytest suite, tests/fixtures/ for real recordings
tools/sweep.py  randomized accuracy sweep
docs/SPEC.md    project spec
```

## Clean-room project

This is an independent implementation built only from public information and standard horology. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. Not affiliated with or endorsed by any timegrapher manufacturer.

## License

GPL-3.0. See [LICENSE](LICENSE).
