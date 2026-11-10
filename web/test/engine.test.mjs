// Run: node --test web/test/
// Same Phase 1 gate as the Python suite: 1 s/d, 0.1 ms, 5 degrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../engine.js";

const SR = 48000;

function render(src, seconds) {
  const out = new Float64Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i += 4096) {
    const n = Math.min(4096, out.length - i);
    out.set(src.next(n), i);
  }
  return out;
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, want ${b} +/- ${tol}`);

const CASES = [
  [18000, 0, 0, 250, 50],
  [21600, -12, 0.8, 230, 52],
  [28800, 7.5, 0.6, 270, 52],
  [28800, -25, 1.5, 190, 53],
  [36000, 4, 0.3, 280, 49],
];

for (const [bph, rate, be, amp, la] of CASES) {
  test(`recovers ${bph} A/h ${rate} s/d ${be} ms ${amp} deg`, () => {
    const src = new E.SynthSource(SR, { bph, rate, beatErrorMs: be, amplitude: amp, liftAngle: la, seed: bph });
    const r = E.analyzeSignal(render(src, 30), SR, { liftAngle: la });
    assert.equal(r.bph, bph);
    near(r.rate, rate, 1, "rate");
    near(r.beatErrorMs, be, 0.1, "beat error");
    near(r.amplitude, amp, 5, "amplitude");
  });
}

test("noisy signal stays within the gate", () => {
  const src = new E.SynthSource(SR, { rate: 5, beatErrorMs: 0.4, amplitude: 260, noise: 0.08, seed: 7 });
  const r = E.analyzeSignal(render(src, 40), SR);
  near(r.rate, 5, 1, "rate");
  near(r.beatErrorMs, 0.4, 0.1, "beat error");
  near(r.amplitude, 260, 5, "amplitude");
});

test("uncalibrated card is wrong, quartz calibration fixes it", () => {
  const clockPpm = 80;
  const w = render(new E.SynthSource(SR, { rate: 2, beatErrorMs: 0.2, clockPpm }), 30);
  const raw = E.analyzeSignal(w, SR);
  assert.ok(Math.abs(raw.rate - 2) > 5, `uncalibrated rate ${raw.rate} should be off`);
  const ref = render(new E.SynthSource(SR, { kind: "quartz", clockPpm, referenceOffsetSd: 0.25 }), 640);
  const cal = E.calibrateSignal(ref, SR, "quartz", 0.25);
  assert.ok(cal.valid, `calibration should be valid: ${JSON.stringify(cal)}`);
  near(cal.ppm, -80 / (1 + 80e-6), 0.3, "ppm");
  const fixed = E.analyzeSignal(w, SR, { ppm: cal.ppm });
  near(fixed.rate, 2, 0.2, "calibrated rate");
});

test("short quartz run is not valid", () => {
  const ref = render(new E.SynthSource(SR, { kind: "quartz", clockPpm: 30 }), 120);
  const cal = E.calibrateSignal(ref, SR, "quartz");
  assert.equal(cal.valid, false);
});

test("GPS PPS calibration", () => {
  const clockPpm = -45;
  const pps = render(new E.SynthSource(SR, { kind: "pps", clockPpm, noise: 0.005 }), 90);
  const cal = E.calibrateSignal(pps, SR, "pps");
  assert.ok(cal.valid);
  near(cal.ppm, 45, 0.5, "ppm");
  const w = render(new E.SynthSource(SR, { rate: 12, clockPpm }), 30);
  near(E.analyzeSignal(w, SR, { ppm: cal.ppm }).rate, 12, 0.2, "rate");
});

test("auto-detects common beat rates", () => {
  for (const bph of [18000, 19800, 21600, 25200, 28800, 36000]) {
    const x = render(new E.SynthSource(SR, { bph, beatErrorMs: 0.5 }), 12);
    assert.equal(E.detectBph(x, SR), bph);
  }
});

test("WAV parser round trip (16-bit stereo)", () => {
  const frames = 1000, buf = new ArrayBuffer(44 + frames * 4), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + frames * 4, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 44100 * 4, true); v.setUint16(32, 4, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) { v.setInt16(44 + i * 4, 16384, true); v.setInt16(46 + i * 4, -16384, true); }
  const p = E.parseWav(buf);
  assert.equal(p.sr, 44100);
  assert.equal(p.channels.length, 2);
  near(p.channels[0][5], 0.5, 1e-9, "ch0");
  near(p.channels[1][5], -0.5, 1e-9, "ch1");
});

function dropSamples(x, everyS, dropS) {
  // Remove dropS of audio every everyS seconds, like a glitching USB card.
  const out = [];
  const every = Math.round(everyS * SR), drop = Math.round(dropS * SR);
  for (let i = 0; i < x.length; i += every + drop) out.push(x.subarray(i, Math.min(x.length, i + every)));
  const y = new Float64Array(out.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of out) { y.set(c, p); p += c.length; }
  return y;
}

test("audio dropouts do not corrupt the watch reading", () => {
  const x = render(new E.SynthSource(SR, { rate: 7.5, beatErrorMs: 0.6, amplitude: 270, seed: 11 }), 40);
  const glitched = dropSamples(x, 7.3, 0.0213);
  const r = E.analyzeSignal(glitched, SR);
  assert.ok(r.tracker.dropouts >= 3, `dropouts seen: ${r.tracker.dropouts}`);
  near(r.rate, 7.5, 1, "rate");
  near(r.beatErrorMs, 0.6, 0.1, "beat error");
  near(r.amplitude, 270, 5, "amplitude");
});

test("audio dropouts do not corrupt calibration", () => {
  const ref = render(new E.SynthSource(SR, { kind: "pps", clockPpm: 60, noise: 0.005 }), 100);
  const glitched = dropSamples(ref, 19.1, 0.0029);
  const cal = E.calibrateSignal(glitched, SR, "pps");
  assert.ok(cal.segments >= 4, `segments ${cal.segments}`);
  assert.ok(cal.valid, JSON.stringify(cal));
  near(cal.ppm, -60 / (1 + 60e-6), 0.5, "ppm");
});
