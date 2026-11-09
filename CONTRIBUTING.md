# Contributing to OpenTimegrapher

Thanks for helping. This is a **clean-room** project, which is what keeps it legal to publish. Every contributor agrees to the rules below.

## Clean-room rules

1. Do not install, decompile, disassemble or inspect any commercial timegrapher software or firmware, or capture its USB traffic, for this project.
2. Feature knowledge comes only from public material: datasheets, dealer listings, user manuals and published watchmaking theory. Add any new source to `docs/SPEC.md`.
3. DSP and math are written from first principles or taken from openly licensed projects, with their licenses respected and credited.
4. Do not copy screenshots, icons, layouts or wording from commercial products. Design our screens from scratch.
5. Do not bypass or emulate any vendor's license, token or upgrade system.
6. Do not use manufacturer trademarks in names, UI text or marketing, except plain factual references.

## Pledge

Add this line to your first pull request description:

> I confirm I have followed the OpenTimegrapher clean-room rules for this contribution.

## Dev setup

```bash
pip install -e ".[dev]"
pytest -q
python tools/sweep.py 50
```

Accuracy changes must keep `pytest` green and the sweep at 100% within the Phase 1 gate (1 s/d, 0.1 ms, 5 deg).

## Real recordings

Tick recordings from real watches are the most useful thing you can contribute. Put WAV files in `tests/fixtures/` named like `eta2824_28800_dialup_nn.wav`, and add a line to `tests/fixtures/README.md` with the caliber, position, and reference readings from a calibrated timegrapher if you have them.
