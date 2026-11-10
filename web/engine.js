// JSF Timegrapher engine, JavaScript port of src/opentimegrapher (same math, same tests).
// Pure ES module, no dependencies. Runs in the browser and in Node.
//
//   rate (s/d)  = 86400 * (T_nom / T_meas - 1)
//   BE (ms)     = |a - b| / 2           a = tick->tock, b = tock->tick
//   amplitude   = LA / (2 * sin(pi * f * dt))   f = A/h / 7200, dt = unlock-to-drop
//
// Calibration: true_interval = measured_interval * (1 + ppm * 1e-6)

export const STANDARD_BPH = [14400, 18000, 19800, 21600, 25200, 28800, 36000, 43200];
export const SECONDS_PER_DAY = 86400;
export const STABILITY_LIMIT_PPM = 0.5;
export const MIN_CAL_SECONDS = { quartz: 600, pps: 60, clock: 1800 };
export const CAL_MAX_AGE_DAYS = 30;

// ---------------------------------------------------------------- DSP basics

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative radix-2 complex FFT. inverse=true gives the unscaled inverse.
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// RBJ high-pass biquad coefficients.
function hpBiquad(fc, q, sr) {
  const w = (2 * Math.PI * fc) / sr;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cw) / 2 / a0, b1: -(1 + cw) / a0, b2: (1 + cw) / 2 / a0,
    a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
  };
}

function biquadRun(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}

// 4th-order Butterworth high-pass (two biquads), run forward and backward for zero phase.
export function highpass(x, sr, cutoff = 2000) {
  cutoff = Math.min(cutoff, 0.4 * sr);
  const secs = [hpBiquad(cutoff, 0.5411961, sr), hpBiquad(cutoff, 1.3065630, sr)];
  const pad = Math.min(x.length - 1, Math.round(0.01 * sr));
  const n = x.length + 2 * pad;
  let y = new Float64Array(n);
  for (let i = 0; i < pad; i++) y[i] = 2 * x[0] - x[pad - i];
  y.set(x, pad);
  for (let i = 0; i < pad; i++) y[pad + x.length + i] = 2 * x[x.length - 1] - x[x.length - 2 - i];
  for (const s of secs) y = biquadRun(y, s);
  y.reverse();
  for (const s of secs) y = biquadRun(y, s);
  y.reverse();
  return y.subarray(pad, pad + x.length);
}

// Centered moving average, same alignment as numpy convolve(mode="same").
export function smooth(x, sr, windowS) {
  const n = Math.max(1, Math.floor(windowS * sr));
  if (n <= 1) return Float64Array.from(x);
  const cs = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) cs[i + 1] = cs[i] + x[i];
  const back = Math.floor(n / 2), fwd = Math.floor((n - 1) / 2);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - back), hi = Math.min(x.length, i + fwd + 1);
    y[i] = (cs[hi] - cs[lo]) / n;
  }
  return y;
}

// Analytic-signal magnitude via FFT, lightly smoothed.
export function envelope(x, sr, smoothS = 0.0002) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  const half = n / 2;
  for (let i = 1; i < half; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = half + 1; i < n; i++) { re[i] = 0; im[i] = 0; }
  fft(re, im, true);
  const env = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) env[i] = Math.hypot(re[i], im[i]) / n;
  return smooth(env, sr, smoothS);
}

export function percentile(x, p) {
  const s = Float64Array.from(x).sort();
  if (!s.length) return 0;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Local maxima above minHeight, thinned so no two are closer than minDistance (tallest win).
export function localPeaks(y, minHeight, minDistance, start = 0, end = y.length) {
  const cand = [];
  for (let i = Math.max(1, start); i < Math.min(end, y.length - 1); i++) {
    const v = y[i];
    if (v < minHeight || v <= y[i - 1]) continue;
    let j = i;
    while (j + 1 < y.length && y[j + 1] === v) j++;
    if (j + 1 < y.length && y[j + 1] < v) cand.push((i + j) >> 1);
    i = j;
  }
  if (minDistance <= 1 || cand.length < 2) return cand;
  const order = cand.map((_, k) => k).sort((a, b) => y[cand[b]] - y[cand[a]]);
  const removed = new Uint8Array(cand.length);
  for (const k of order) {
    if (removed[k]) continue;
    for (let m = k - 1; m >= 0 && cand[k] - cand[m] < minDistance; m--) removed[m] = 1;
    for (let m = k + 1; m < cand.length && cand[m] - cand[k] < minDistance; m++) removed[m] = 1;
  }
  return cand.filter((_, k) => !removed[k]);
}

export function parabolicPeak(y, i) {
  if (i <= 0 || i >= y.length - 1) return i;
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const d = a - 2 * b + c;
  return d === 0 ? i : i + (0.5 * (a - c)) / d;
}

// ---------------------------------------------------------------- watch analysis

export function unlockToDropSeconds(bph, amplitude, liftAngle) {
  const f = bph / 7200;
  return Math.asin(liftAngle / (2 * amplitude)) / (Math.PI * f);
}

export function amplitudeFromDt(bph, dt, liftAngle) {
  const s = Math.sin(Math.PI * (bph / 7200) * dt);
  return s > 0 ? liftAngle / (2 * s) : NaN;
}

// Pick the beat rate whose one-beat AND full tick-tock lags both repeat strongly.
export function detectBph(x, sr, candidates = STANDARD_BPH, maxSeconds = 20) {
  const seg = x.length > maxSeconds * sr ? x.subarray(0, Math.floor(maxSeconds * sr)) : x;
  const envFull = smooth(envelope(highpass(seg, sr), sr), sr, 0.006);
  const step = Math.max(1, Math.floor(sr / 4000));
  const n = Math.floor(envFull.length / step);
  const env = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { env[i] = envFull[i * step]; mean += env[i]; }
  mean /= n;
  for (let i = 0; i < n; i++) env[i] -= mean;
  const fs = sr / step;
  const m = nextPow2(2 * n);
  const re = new Float64Array(m), im = new Float64Array(m);
  re.set(env);
  fft(re, im);
  for (let i = 0; i < m; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft(re, im, true);
  const ac0 = re[0] || 1;
  const peakAt = (lagS) => {
    const lag = lagS * fs;
    const pad = lag * 0.01 + 0.002 * fs;
    const lo = Math.floor(lag - pad), hi = Math.floor(lag + pad) + 1;
    if (hi >= Math.floor(n / 2)) return NaN;
    let best = -Infinity;
    for (let i = lo; i < hi; i++) best = Math.max(best, re[i] / ac0);
    return best;
  };
  const scores = new Map();
  for (const bph of candidates) {
    const beat = 3600 / bph;
    const s = Math.min(peakAt(beat), peakAt(2 * beat));
    if (!Number.isNaN(s)) scores.set(bph, s);
  }
  if (!scores.size) throw new Error("Recording too short to detect beat rate");
  const best = Math.max(...scores.values());
  return Math.max(...[...scores].filter(([, s]) => s >= 0.6 * best).map(([b]) => b));
}

// Raw beat events in a window: [{t (s, from window start), dt (unlock->drop s), level}]
export function beatEvents(x, sr, bph, acceptFrom = 0, acceptTo = Infinity) {
  const tNom = 3600 / bph;
  const fine = envelope(highpass(x, sr), sr);
  const coarse = smooth(fine, sr, 0.003);
  const noiseFloor = 3.0 * median(fine);
  const floor = percentile(coarse, 99.5);
  const centers = localPeaks(coarse, 0.25 * floor, Math.floor(0.6 * tNom * sr));
  const half = Math.floor(Math.min(0.03, 0.4 * tNom) * sr);
  const minSep = Math.floor(0.0005 * sr);
  const out = [];
  for (const c of centers) {
    const lo = Math.max(0, c - half), hi = Math.min(fine.length, c + half);
    if (hi - lo < 3) continue;
    let wmax = 0;
    for (let i = lo; i < hi; i++) wmax = Math.max(wmax, fine[i]);
    const w = fine.subarray(lo, hi);
    const pk = localPeaks(w, Math.max(0.3 * wmax, noiseFloor), minSep);
    if (pk.length < 2) continue;
    const unlock = lo + parabolicPeak(w, pk[0]);
    const drop = lo + parabolicPeak(w, pk[pk.length - 1]);
    const t = unlock / sr;
    if (t < acceptFrom || t >= acceptTo) continue;
    out.push({ t, dt: (drop - unlock) / sr, level: wmax });
  }
  return { events: out, noiseFloor, peakLevel: floor, fine };
}

// Small dense least squares via normal equations + Gaussian elimination with pivoting.
function solveN(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) return null;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function lstsq(rows, t, keep, dim) {
  const A = Array.from({ length: dim }, () => new Array(dim).fill(0)), b = new Array(dim).fill(0);
  for (let i = 0; i < rows.length; i++) {
    if (!keep[i]) continue;
    const r = rows[i];
    for (const [p, vp] of r) {
      b[p] += vp * t[i];
      for (const [q, vq] of r) A[p][q] += vp * vq;
    }
  }
  // A column with no kept rows (a segment the robust pass dropped entirely)
  // would make the system singular; pin it to zero instead.
  for (let p = 0; p < dim; p++) if (A[p][p] === 0) A[p][p] = 1;
  return solveN(A, b);
}

// Robust line fit shared by beats and pulses. Each item: {time (s), index, seg}.
// One shared period, one intercept per segment (audio dropouts start a new
// segment), plus optionally one tick/tock offset per segment.
function segmentFit(items, withParity, scale) {
  const segs = new Map();
  for (const it of items) segs.set(it.seg, (segs.get(it.seg) || 0) + 1);
  const minPer = withParity ? 4 : 3;
  const use = items.filter((it) => segs.get(it.seg) >= minPer);
  if (use.length < 6) return null;
  const segIds = [...new Set(use.map((it) => it.seg))];
  const col = new Map(segIds.map((s, k) => [s, k]));
  const first = new Map();
  for (const it of use) if (!first.has(it.seg)) first.set(it.seg, it.index);
  const per = withParity ? 2 : 1;
  const dim = 1 + per * segIds.length;
  const rows = use.map((it) => {
    const k = col.get(it.seg), n = it.index - first.get(it.seg);
    const r = [[0, n], [1 + per * k, 1]];
    if (withParity && n % 2) r.push([2 + per * k, 1]);
    return r;
  });
  const t = use.map((it) => it.time * scale);
  let keep = new Uint8Array(use.length).fill(1);
  let sol = null, resid = null;
  for (let iter = 0; iter < 4; iter++) {
    sol = lstsq(rows, t, keep, dim);
    if (!sol) return null;
    resid = t.map((v, i) => v - rows[i].reduce((s, [c, x]) => s + sol[c] * x, 0));
    const kept = resid.filter((_, i) => keep[i]);
    const med = median(kept);
    const mad = median(kept.map((r) => Math.abs(r - med))) || 1e-9;
    const nk = Uint8Array.from(resid, (r) => (Math.abs(r - med) < 4 * 1.4826 * mad ? 1 : 0));
    if (nk.reduce((a, v) => a + v, 0) < 6 || nk.every((v, i) => v === keep[i])) break;
    keep = nk;
  }
  let offset = 0, w = 0;
  if (withParity) {
    segIds.forEach((s, k) => { const c = segs.get(s); offset += Math.abs(sol[2 + per * k]) * c; w += c; });
    offset /= w || 1;
  }
  return { period: sol[0], offset, used: keep.reduce((a, v) => a + v, 0), segments: segIds.length, items: use, keep, resid };
}

// Fit beats [{time, dt, index, seg}] -> {rate, beatErrorMs, amplitude, used, segments}
export function fitBeats(beats, bph, liftAngle, ppm = 0) {
  if (beats.length < 6) return null;
  const scale = 1 + ppm * 1e-6;
  const items = beats[0].seg === undefined ? beats.map((b) => ({ ...b, seg: 0 })) : beats;
  const f = segmentFit(items, true, scale);
  if (!f) return null;
  const tNom = 3600 / bph;
  const dt = median(f.items.filter((_, i) => f.keep[i]).map((b) => b.dt)) * scale;
  return {
    rate: SECONDS_PER_DAY * (tNom / f.period - 1),
    beatErrorMs: f.offset * 1000,
    amplitude: amplitudeFromDt(bph, dt, liftAngle),
    used: f.used,
    segments: f.segments,
  };
}

// ---------------------------------------------------------------- streaming trackers
//
// Live audio arrives in blocks. Trackers keep a short history, analyze a sliding
// window once per hop, and only accept events from the window's middle so every
// moment of audio is counted exactly once and filter edges never matter.

class RingWindow {
  constructor(sr, windowS) {
    this.sr = sr;
    this.size = Math.round(windowS * sr);
    this.buf = new Float64Array(this.size);
    this.filled = 0;
    this.total = 0; // samples seen
  }
  push(block) {
    const n = block.length;
    if (n >= this.size) {
      this.buf.set(block.subarray(n - this.size));
    } else {
      this.buf.copyWithin(0, n);
      this.buf.set(block, this.size - n);
    }
    this.filled = Math.min(this.size, this.filled + n);
    this.total += n;
  }
  view() { return this.buf.subarray(this.size - this.filled); }
  startSample() { return this.total - this.filled; }
}

// Detects audio dropouts: a sudden timing jump in an otherwise regular series.
// A single off reading is treated as an outlier; a jump is confirmed only when the
// next reading agrees with it. Confirmed jumps start a new segment so the fit
// can give each stretch of audio its own starting point.
class JumpDetector {
  constructor(thresholdS, parityStep) {
    this.th = thresholdS;
    this.ps = parityStep;   // 2 for watch beats (cancels beat error), 1 for pulses
    this.seg = 0;
    this.dropouts = 0;
    this.pending = null;
  }
  period(list, nominal) {
    const vals = [];
    for (let i = list.length - 1; i > 0 && vals.length < 24; i--) {
      const a = list[i], b = list[i - 1];
      if (a.seg !== this.seg || b.seg !== this.seg) break;
      if (a.index > b.index) vals.push((a.time - b.time) / (a.index - b.index));
    }
    if (vals.length < 6) return this.lastPer || nominal;
    if (this.ps === 2) {
      // average neighbouring intervals so alternating beat error cancels
      const pairs = [];
      for (let i = 0; i + 1 < vals.length; i++) pairs.push((vals[i] + vals[i + 1]) / 2);
      return (this.lastPer = median(pairs));
    }
    return (this.lastPer = median(vals));
  }
  deviation(list, time, index, per) {
    for (let i = list.length - 1; i >= 0 && i >= list.length - 12; i--) {
      const b = list[i];
      if (b.seg !== this.seg) return null;
      if ((index - b.index) % this.ps === 0) return time - b.time - (index - b.index) * per;
    }
    return null;
  }
  segCount(list) {
    let c = 0;
    for (let i = list.length - 1; i >= 0 && list[i].seg === this.seg; i--) c++;
    return c;
  }
  // Add an item {time, index, ...} to list, handling outliers and jumps.
  add(list, item, nominal) {
    // Until a period has been measured once, trust the first few readings.
    // After that, even a brand-new segment is checked from its second reading on.
    const n = this.segCount(list);
    if (n < (this.lastPer ? 2 : 6)) { list.push({ ...item, seg: this.seg }); this.pending = null; return; }
    const per = this.period(list, nominal);
    const dev = this.deviation(list, item.time, item.index, per);
    if (dev === null || Math.abs(dev) <= this.th) {
      if (this.pending) { list.push({ ...this.pending.item, seg: this.seg }); }
      this.pending = null;
      list.push({ ...item, seg: this.seg });
      return;
    }
    if (!this.pending) { this.pending = { item, dev }; return; }
    if (Math.abs(dev - this.pending.dev) < this.th) {
      // confirmed jump: both readings start a new segment
      this.seg++;
      this.dropouts++;
      list.push({ ...this.pending.item, seg: this.seg }, { ...item, seg: this.seg });
    } else {
      list.push({ ...this.pending.item, seg: this.seg });
      this.pending = { item, dev };
      return;
    }
    this.pending = null;
  }
}

export class BeatTracker {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.bph = opts.bph || null;          // null = auto
    this.autoBph = !opts.bph;
    this.windowS = 3;
    this.hopS = 1;
    this.ring = new RingWindow(sr, this.windowS);
    this.detectRing = new RingWindow(sr, 8);
    this.sinceHop = 0;
    this.beats = [];       // {time (s, absolute), dt, index, seg, level}
    this.jumps = new JumpDetector(0.0015, 2);
    this.signal = { quality: 0, level: 0, noise: 0 };
    this.acceptedUntil = 0;
  }
  get dropouts() { return this.jumps.dropouts; }
  setBph(bph) {
    this.bph = bph; this.autoBph = !bph; this.reset();
  }
  reset() { this.beats = []; this.jumps = new JumpDetector(0.0015, 2); }
  push(block) {
    this.ring.push(block);
    if (!this.bph) this.detectRing.push(block);
    this.sinceHop += block.length;
    const hop = Math.round(this.hopS * this.sr);
    let changed = false;
    while (this.sinceHop >= hop) {
      this.sinceHop -= hop;
      changed = this._analyze() || changed;
    }
    return changed;
  }
  _analyze() {
    const sr = this.sr;
    if (!this.bph) {
      if (this.detectRing.filled < 6 * sr) return false;
      try { this.bph = detectBph(this.detectRing.view(), sr); } catch { return false; }
    }
    if (this.ring.filled < this.ring.size) return false;
    const x = this.ring.view();
    const t0 = this.ring.startSample() / sr;
    // Accept the second of audio that sits 1 to 2 s back from the newest sample.
    // Continue exactly where the last pass stopped, never closer than 0.5 s to the window edge.
    const from = (this.acceptedUntil ? Math.max(this.acceptedUntil, t0 + 0.5) : t0 + this.windowS - 2) - t0;
    const to = t0 + this.windowS - 1 - t0;
    const { events, noiseFloor, peakLevel, fine } = beatEvents(x, sr, this.bph, from, to);
    this.acceptedUntil = t0 + to;
    this.last = { fine, t0, events }; // for the Scope view
    const tNom = 3600 / this.bph;
    for (const e of events) {
      const time = t0 + e.t;
      const last = this.jumps.pending ? this.jumps.pending.item : this.beats[this.beats.length - 1];
      const beat = { time, dt: e.dt, level: e.level, index: 0 };
      if (last) {
        const step = Math.round((time - last.time) / tNom);
        if (step < 1) continue;
        if (step > 50) { // long silence: new segment, start counting again
          this.jumps.seg++;
          this.jumps.pending = null;
          this.beats.push({ ...beat, seg: this.jumps.seg });
          continue;
        }
        beat.index = last.index + step;
      }
      this.jumps.add(this.beats, beat, tNom);
    }
    if (this.beats.length > 200000) this.beats.splice(0, this.beats.length - 200000);
    const expected = 1 / tNom;
    const recent = this.beats.filter((b) => b.time >= t0 + this.windowS - 2 && b.time < t0 + to);
    this.signal = {
      quality: Math.min(1, recent.length / expected),
      level: peakLevel,
      noise: noiseFloor,
    };
    return true;
  }
  // Reading over the last `seconds` of beats (Infinity = since start/reset).
  reading(liftAngle, ppm, seconds = 10) {
    if (!this.bph || !this.beats.length) return null;
    const end = this.beats[this.beats.length - 1].time;
    const sel = this.beats.filter((b) => b.time >= end - seconds);
    const f = fitBeats(sel, this.bph, liftAngle, ppm);
    return f && { ...f, bph: this.bph, beats: sel.length, quality: this.signal.quality };
  }
}

export class PulseTracker {
  // 1 Hz reference pulses (quartz step or GPS PPS), for calibration.
  constructor(sr) {
    this.sr = sr;
    this.windowS = 3;
    this.ring = new RingWindow(sr, this.windowS);
    this.sinceHop = 0;
    this.positions = []; // absolute sample positions (fractional)
    this.pulses = [];    // {time (s), index, seg}
    this.jumps = new JumpDetector(0.001, 1);
    this.acceptedUntil = 0;
    this.level = 0;
  }
  get dropouts() { return this.jumps.dropouts; }
  push(block) {
    this.ring.push(block);
    this.sinceHop += block.length;
    let changed = false;
    while (this.sinceHop >= this.sr) {
      this.sinceHop -= this.sr;
      changed = this._analyze() || changed;
    }
    return changed;
  }
  _analyze() {
    const sr = this.sr;
    if (this.ring.filled < this.ring.size) return false;
    const x = this.ring.view();
    const s0 = this.ring.startSample();
    const env = envelope(highpass(x, sr, 1000), sr);
    const ref = percentile(env, 99.9);
    this.level = ref;
    const pk = localPeaks(env, 0.3 * ref, Math.floor(0.7 * sr));
    // Continue where the last pass stopped, keeping clear of the window edges.
    const fromS = this.acceptedUntil ? Math.max(this.acceptedUntil, s0 + 0.5 * sr) : s0 + sr;
    const toS = s0 + 2 * sr;
    for (const p of pk) {
      const pos = s0 + parabolicPeak(env, p);
      if (pos < fromS || pos >= toS) continue;
      const last = this.positions[this.positions.length - 1];
      if (last !== undefined && pos - last < 0.7 * sr) continue;
      this.positions.push(pos);
      const time = pos / sr;
      const prev = this.jumps.pending ? this.jumps.pending.item : this.pulses[this.pulses.length - 1];
      const index = prev ? prev.index + Math.max(1, Math.round(time - prev.time)) : 0;
      this.jumps.add(this.pulses, { time, index }, 1);
    }
    this.acceptedUntil = toS;
    return true;
  }
  duration() {
    const p = this.positions;
    return p.length > 1 ? (p[p.length - 1] - p[0]) / this.sr : 0;
  }
}

function toPulseItems(list, sr) {
  if (!list.length || typeof list[0] === "object") return list;
  // plain sample positions: one segment, index by rounding to whole seconds
  const t = list.map((p) => p / sr);
  return t.map((v) => ({ time: v, index: Math.round(v - t[0]), seg: 0 }));
}

function ppmFromItems(items, realPeriod) {
  const f = segmentFit(items, false, 1);
  return f ? (realPeriod / f.period - 1) * 1e6 : NaN;
}

// Evaluate a calibration run. pulses = PulseTracker.pulses (or plain sample positions).
export function evaluateCalibration(pulses, sr, method, referenceOffsetSd = 0, minDuration = null) {
  if (method === "pps") referenceOffsetSd = 0;
  const items = toPulseItems(pulses, sr);
  const realPeriod = 1 / (1 + referenceOffsetSd / SECONDS_PER_DAY);
  const n = items.length;
  // Count only audio we actually have: sum of each segment's span.
  const spans = new Map();
  for (const it of items) {
    const s = spans.get(it.seg);
    spans.set(it.seg, s ? [s[0], it.time] : [it.time, it.time]);
  }
  const duration = [...spans.values()].reduce((a, [x, y]) => a + (y - x), 0);
  const segments = spans.size;
  const needed = minDuration ?? MIN_CAL_SECONDS[method];
  if (n < 10) {
    return { method, ppm: NaN, sdEquivalent: NaN, pulses: n, duration, segments, spreadPpm: Infinity,
             stable: false, valid: false, needed, chunkPpm: [] };
  }
  const ppm = ppmFromItems(items, realPeriod);
  const chunkPpm = [];
  if (n >= 40) {
    const size = Math.ceil(n / 4);
    for (let i = 0; i < n; i += size) {
      const c = items.slice(i, i + size);
      if (c.length >= 10) {
        const v = ppmFromItems(c, realPeriod);
        if (Number.isFinite(v)) chunkPpm.push(v);
      }
    }
  }
  const spreadPpm = chunkPpm.length > 1 ? Math.max(...chunkPpm) - Math.min(...chunkPpm) : Infinity;
  const stable = Number.isFinite(ppm) && spreadPpm <= STABILITY_LIMIT_PPM;
  return {
    method, ppm, sdEquivalent: ppm * 1e-6 * SECONDS_PER_DAY, pulses: n, duration, segments,
    spreadPpm, stable, valid: stable && duration >= needed, needed, chunkPpm,
  };
}

// ---------------------------------------------------------------- device clock calibration
//
// No reference signal: compare the audio sample count against the device's
// network-synced clock (Date.now) over a long run. Each audio block is stamped
// in the audio thread. Stamps arrive with variable delay, so for every second
// we keep only the least-delayed stamp, the same trick NTP uses. A jump in the
// clock (a network time correction) or an audio dropout starts a new segment.

export class ClockTracker {
  constructor(sr) {
    this.sr = sr;
    this.bins = new Map();   // second -> least-delayed stamp {x, y, d}
    this.last = null;
    this.firstWall = null;
  }
  add(frame, wallMs) {
    const x = frame / this.sr, y = wallMs / 1000;
    if (this.firstWall === null) this.firstWall = y;
    this.last = { x, y };
    const key = Math.floor(x);
    const d = y - x;
    const cur = this.bins.get(key);
    if (!cur || d < cur.d) this.bins.set(key, { x, y, d });
  }
  // Bins in order, split into segments wherever the clean offset jumps:
  // an audio dropout or a network time correction.
  points() {
    const pts = [...this.bins.values()].sort((a, b) => a.x - b.x);
    const TH = 0.003;
    let seg = 0, recent = [];
    for (let i = 0; i < pts.length; i++) {
      if (recent.length < 3) { // still building this segment's baseline
        pts[i].seg = seg;
        recent = recent.filter((v) => Math.abs(v - pts[i].d) <= TH);
        recent.push(pts[i].d);
        continue;
      }
      const ref = median(recent);
      const off = Math.abs(pts[i].d - ref) > TH;
      // A jump is confirmed when the next second is off too; a single odd
      // second (a slow stamp, or one that straddles the jump) is just an outlier.
      const nextOff = i + 1 < pts.length && Math.abs(pts[i + 1].d - ref) > TH;
      if (off && nextOff) { seg++; recent = []; }
      pts[i].seg = seg;
      if (!off || !recent.length) recent.push(pts[i].d);
      if (recent.length > 7) recent.shift();
    }
    return pts;
  }
  get dropouts() { const p = this.points(); return p.length ? p[p.length - 1].seg : 0; }
  elapsed() { return this.last && this.firstWall !== null ? this.last.y - this.firstWall : 0; }
}

// Pooled slope of wall time against audio time, one intercept per segment, robust to outliers.
function clockFit(points) {
  const bySeg = new Map();
  for (const p of points) {
    if (!bySeg.has(p.seg)) bySeg.set(p.seg, []);
    bySeg.get(p.seg).push(p);
  }
  let keep = new Set(points);
  let slope = 1, se = Infinity, resid = [];
  for (let it = 0; it < 3; it++) {
    let sxy = 0, sxx = 0, n = 0, segs = 0;
    const segMeans = new Map();
    for (const [s, ps] of bySeg) {
      const k = ps.filter((p) => keep.has(p));
      if (k.length < 10) continue;
      const mx = k.reduce((a, p) => a + p.x, 0) / k.length;
      const my = k.reduce((a, p) => a + p.y, 0) / k.length;
      segMeans.set(s, [mx, my]);
      for (const p of k) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
      n += k.length; segs++;
    }
    if (!sxx) return null;
    slope = sxy / sxx;
    resid = [];
    for (const p of points) {
      const m = segMeans.get(p.seg);
      if (m) resid.push([p, p.y - m[1] - slope * (p.x - m[0])]);
    }
    const kr = resid.filter(([p]) => keep.has(p)).map(([, r]) => r);
    const mad = median(kr.map(Math.abs)) || 1e-6;
    const sigma = Math.sqrt(kr.reduce((a, r) => a + r * r, 0) / Math.max(1, n - segs - 1));
    se = sigma / Math.sqrt(sxx);
    const nk = new Set(resid.filter(([, r]) => Math.abs(r) < 5 * 1.4826 * mad).map(([p]) => p));
    if (nk.size === keep.size) break;
    keep = nk;
  }
  return { ppm: (slope - 1) * 1e6, sePpm: se * 1e6, used: keep.size };
}

export function evaluateClockCalibration(tracker, minDuration = null) {
  const pts = tracker.points();
  const needed = minDuration ?? MIN_CAL_SECONDS.clock;
  const spans = new Map();
  for (const p of pts) {
    const s = spans.get(p.seg);
    spans.set(p.seg, s ? [s[0], p.x] : [p.x, p.x]);
  }
  const duration = [...spans.values()].reduce((a, [x, y]) => a + (y - x), 0);
  const base = { method: "clock", pulses: pts.length, duration, segments: spans.size, needed };
  const all = pts.length >= 30 ? clockFit(pts) : null;
  if (!all) return { ...base, ppm: NaN, sdEquivalent: NaN, spreadPpm: Infinity, sePpm: Infinity, stable: false, valid: false, chunkPpm: [] };
  // First half against second half: a clock being corrected mid-run shows up here.
  const half = Math.floor(pts.length / 2);
  const a = pts.length >= 120 ? clockFit(pts.slice(0, half)) : null;
  const b = pts.length >= 120 ? clockFit(pts.slice(half)) : null;
  const chunkPpm = a && b ? [a.ppm, b.ppm] : [];
  const spreadPpm = chunkPpm.length === 2 ? Math.abs(a.ppm - b.ppm) : Infinity;
  // 0.5 ppm is 0.04 s/d, far below what matters when regulating a watch.
  const stable = spreadPpm <= 1.5 && all.sePpm <= 0.5;
  return {
    ...base, ppm: all.ppm, sdEquivalent: all.ppm * 1e-6 * SECONDS_PER_DAY, spreadPpm, sePpm: all.sePpm,
    stable, valid: stable && duration >= needed, chunkPpm,
  };
}

// ---------------------------------------------------------------- offline helpers

// Run a whole recording through the streaming tracker (same path as live audio).
export function analyzeSignal(x, sr, { bph = null, liftAngle = 52, ppm = 0, seconds = Infinity } = {}) {
  const tr = new BeatTracker(sr, { bph });
  const block = 4096;
  for (let i = 0; i < x.length; i += block) tr.push(x.subarray(i, Math.min(x.length, i + block)));
  const r = tr.reading(liftAngle, ppm, seconds);
  if (!r) throw new Error("Not enough clean beats found; check pickup placement and gain");
  return { ...r, tracker: tr };
}

export function calibrateSignal(x, sr, method = "quartz", referenceOffsetSd = 0, minDuration = null) {
  const tr = new PulseTracker(sr);
  const block = 4096;
  for (let i = 0; i < x.length; i += block) tr.push(x.subarray(i, Math.min(x.length, i + block)));
  return evaluateCalibration(tr.pulses, sr, method, referenceOffsetSd, minDuration);
}

// Minimal WAV reader: PCM 16/24/32-bit int and 32-bit float. Returns {sr, channels: [Float64Array]}
export function parseWav(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12, fmt = null;
  while (off + 8 <= v.byteLength) {
    const id = tag(off), size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: v.getUint16(body, true), channels: v.getUint16(body + 2, true),
        sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === "data" && fmt) {
      const bytes = fmt.bits / 8, frames = Math.floor(Math.min(size, v.byteLength - body) / (bytes * fmt.channels));
      const ch = Array.from({ length: fmt.channels }, () => new Float64Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          let s;
          if (fmt.format === 3) s = v.getFloat32(p, true);
          else if (fmt.bits === 16) s = v.getInt16(p, true) / 32768;
          else if (fmt.bits === 24) {
            let u = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
            if (u & 0x800000) u -= 0x1000000;
            s = u / 8388608;
          } else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648;
          else throw new Error(`Unsupported WAV bit depth ${fmt.bits}`);
          ch[c][i] = s; p += bytes;
        }
      }
      return { sr: fmt.sr, channels: ch };
    }
    off = body + size + (size % 2);
  }
  throw new Error("WAV file has no audio data");
}

// ---------------------------------------------------------------- synthetic signals

function makeBurst(sr, freq, decay, len) {
  const n = Math.floor(len * sr), b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / sr / decay);
  return b;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Streaming synthetic source for demo mode and tests: watch ticks or 1 Hz pulses.
export class SynthSource {
  constructor(sr, opts = {}) {
    this.sr = sr;
    this.kind = opts.kind || "watch";      // "watch" | "quartz" | "pps"
    this.p = { bph: 28800, rate: 0, beatErrorMs: 0, amplitude: 280, liftAngle: 52, ...opts };
    this.noise = opts.noise ?? 0.02;
    this.clockPpm = opts.clockPpm ?? 0;
    this.rand = mulberry32(opts.seed ?? 1);
    this.spare = null;
    this.bursts = this.kind === "watch"
      ? [makeBurst(sr, 6200, 0.00025, 0.002), makeBurst(sr, 4800, 0.00035, 0.002), makeBurst(sr, 5500, 0.0004, 0.003)]
      : [this.kind === "pps" ? (() => { const b = new Float64Array(Math.floor(0.002 * sr)); b.fill(1, 0, Math.floor(0.0001 * sr) + 1); return b; })()
                            : makeBurst(sr, 3000, 0.0006, 0.004)];
    this.carry = new Float64Array(Math.floor(0.05 * sr));
    this.pos = 0;              // samples produced
    this.tNext = 0.05;         // real seconds of next event
    this.k = 0;
  }
  gauss() {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u, v, s;
    do { u = this.rand() * 2 - 1; v = this.rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return u * m;
  }
  place(buf, at, burst, gain) {
    const i = Math.floor(at), fr = at - i;
    for (let j = 0; j < burst.length; j++) {
      if (i + j >= 0 && i + j < buf.length) buf[i + j] += gain * (1 - fr) * burst[j];
      if (i + j + 1 >= 0 && i + j + 1 < buf.length) buf[i + j + 1] += gain * fr * burst[j];
    }
  }
  next(n) {
    const sps = this.sr * (1 + this.clockPpm * 1e-6);
    const buf = new Float64Array(n + this.carry.length);
    buf.set(this.carry);
    const end = this.pos + n;
    const p = this.p;
    while (this.tNext * sps < end) {
      const at = this.tNext * sps - this.pos;
      if (this.kind === "watch") {
        const tNom = 3600 / p.bph, tBeat = tNom / (1 + p.rate / SECONDS_PER_DAY);
        const dtDrop = unlockToDropSeconds(p.bph, p.amplitude, p.liftAngle);
        const g = 1 + this.gauss() * 0.05;
        this.place(buf, at, this.bursts[0], 0.55 * g);
        this.place(buf, at + dtDrop * 0.45 * sps, this.bursts[1], 0.36 * g);
        this.place(buf, at + dtDrop * sps, this.bursts[2], 0.9 * g);
        const be = p.beatErrorMs / 1000;
        this.tNext += tBeat + (this.k % 2 === 0 ? be : -be);
      } else {
        this.place(buf, at, this.bursts[0], 0.9);
        this.tNext += this.kind === "pps" ? 1 : 1 / (1 + (p.referenceOffsetSd || 0) / SECONDS_PER_DAY);
      }
      this.k++;
    }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf[i] + this.noise * this.gauss();
    this.carry = buf.slice(n, n + this.carry.length);
    this.pos = end;
    return out;
  }
}
