# OpenTimegrapher spec

The full working spec (features, clean-room rules, hardware, DSP math, display modes, roadmap, testing, sources) lives in the project doc "OpenTimegrapher Spec, clean-room watch timing app". Paste its export here before the repo goes public so contributors have it.

## Phase 1 status

- [x] Synthetic signal generator (watch, quartz, GPS PPS, sound card clock error)
- [x] Beat rate auto-detection
- [x] Rate, beat error, amplitude engine with rolling windows (feeds Vario and Trace)
- [x] Mandatory calibration: quartz and GPS 1 PPS methods, per device and sample rate, 30-day prompt, flagged manual override
- [x] CLI: otg synth / calibrate / analyze
- [ ] Live capture (sounddevice)
- [ ] Guided calibration wizard UI
- [ ] Diagram mode UI
- [ ] Gate: within 1 s/d, 0.1 ms, 5 deg of a reference timegrapher on 3 real watches
