// JSF Timegrapher web app: input, mandatory calibration wizard, live measuring.
import * as E from "./engine.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MINUS = "−";

// ------------------------------------------------------------ calibration storage
// Saved per input device + sample rate, in this browser only.
const memoryStore = {};
const store = {
  all() {
    try { return JSON.parse(localStorage.getItem("otg.calibrations") || "{}"); }
    catch { return memoryStore; }
  },
  get(key) { return this.all()[key] || null; },
  save(key, cal) {
    const all = this.all();
    all[key] = cal;
    try { localStorage.setItem("otg.calibrations", JSON.stringify(all)); }
    catch { Object.assign(memoryStore, all); }
  },
};
const ageDays = (cal) => (Date.now() - new Date(cal.created).getTime()) / 86400000;

// ------------------------------------------------------------ state
const state = {
  ctx: null, stream: null, node: null, source: null, workletReady: false,
  dev: null,            // {id, label, sr, channels, demo}
  sink: null,           // (ch0, ch1) => void, receives every audio block
  demoTimer: null,
  cal: null,            // active calibration
  tracker: null,
  history: [],
  view: "diagram",
  lastReading: null,
};

// ------------------------------------------------------------ screens and status
function show(id) {
  for (const s of $$(".screen")) s.hidden = s.id !== id;
  $("#filebox").hidden = id === "screen-wizard";
}

function setStatus(text, tone) {
  $("#status").hidden = !text;
  $("#status-text").textContent = text || "";
  $("#status-dot").className = "dot " + (tone || "");
}

function setBanner(text, kind = "warn", action = null) {
  const b = $("#banner");
  b.hidden = !text;
  b.className = "banner " + kind;
  $("#banner-text").textContent = text || "";
  const a = $("#banner-action");
  a.hidden = !action;
  a.onclick = action;
}

const calKey = (dev) => `${dev.label || dev.id}|${dev.sr}`;

function describeCal(cal) {
  if (!cal) return "Not calibrated";
  if (cal.method === "manual") return `Manual correction ${fmtPpm(cal.ppm)}, results flagged`;
  const d = Math.floor(ageDays(cal));
  const when = d < 1 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  return `Calibrated ${when} with ${cal.method === "pps" ? "GPS" : "quartz"}, ${fmtPpm(cal.ppm)}`;
}
const fmtPpm = (p) => `${p < 0 ? MINUS : "+"}${Math.abs(p).toFixed(2)} ppm`;
const signed = (v, d = 1) => `${v < 0 ? MINUS : "+"}${Math.abs(v).toFixed(d)}`;

// ------------------------------------------------------------ audio input
async function ensureContext() {
  if (!state.ctx) state.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.ctx.state === "suspended") await state.ctx.resume();
  if (!state.workletReady) {
    await state.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
    state.workletReady = true;
  }
}

function stopInput() {
  clearInterval(state.demoTimer);
  state.demoTimer = null;
  if (state.node) { state.node.port.onmessage = null; state.node.disconnect(); state.node = null; }
  if (state.source) { state.source.disconnect(); state.source = null; }
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
}

async function openInput(deviceId) {
  stopInput();
  await ensureContext();
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: { ideal: 2 },
    },
  });
  const track = state.stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.ctx, "otg-capture", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 2, channelCountMode: "explicit", channelInterpretation: "discrete",
  });
  const mute = state.ctx.createGain();
  mute.gain.value = 0;
  state.source.connect(state.node).connect(mute).connect(state.ctx.destination);
  state.node.port.onmessage = (e) => onBlock(e.data[0], e.data[1]);
  state.dev = {
    id: settings.deviceId || deviceId || "default",
    label: track.label || "Audio input",
    sr: state.ctx.sampleRate,
    channels: settings.channelCount ?? null,
    demo: false,
  };
  return state.dev;
}

function startDemo() {
  stopInput();
  const sr = 48000;
  state.dev = { id: "demo", label: "Simulated pickup", sr, channels: 1, demo: true };
  const src = new E.SynthSource(sr, { rate: 6.2, beatErrorMs: 0.4, amplitude: 274, liftAngle: 52, noise: 0.03, seed: Date.now() % 1e6 });
  let last = performance.now();
  state.demoTimer = setInterval(() => {
    const now = performance.now();
    const n = Math.min(sr, Math.round(((now - last) / 1000) * sr));
    if (n < 256) return;
    last += (n / sr) * 1000;
    onBlock(src.next(n), null);
  }, 40);
}

function onBlock(ch0, ch1) {
  let peak = 0;
  for (let i = 0; i < ch0.length; i += 4) peak = Math.max(peak, Math.abs(ch0[i]));
  if (ch1 && state.wizardChannel === 1) {
    peak = 0;
    for (let i = 0; i < ch1.length; i += 4) peak = Math.max(peak, Math.abs(ch1[i]));
  }
  state.peak = Math.max(peak, (state.peak || 0) * 0.85);
  if (state.sink) state.sink(ch0, ch1);
}

async function listDevices(selectedId) {
  const sel = $("#device");
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  sel.innerHTML = "";
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Input ${i + 1}`;
    if (d.deviceId === selectedId) o.selected = true;
    sel.append(o);
  });
}

// ------------------------------------------------------------ start
$("#btn-connect").addEventListener("click", async () => {
  $("#start-error").hidden = true;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    showStartError("This browser can't capture audio. Use a current version of Chrome, Edge, Firefox or Safari.");
    return;
  }
  try {
    const dev = await openInput();
    await listDevices(dev.id);
    routeAfterInput();
  } catch (err) {
    const embedded = window.self !== window.top;
    showStartError(err.name === "NotAllowedError" || err.name === "SecurityError"
      ? embedded
        ? "This embedded copy isn't allowed to use the microphone. Open the full page, or if this is your site, add allow=\"microphone\" to the embed code. The demo and WAV analysis still work here."
        : "Microphone access was blocked. Allow it in the address bar, then select Connect pickup again."
      : err.name === "NotFoundError"
        ? "No audio input found. Plug in the pickup or USB sound card, then select Connect pickup again."
        : `Couldn't open the audio input: ${err.message}`);
  }
});

$("#btn-demo").addEventListener("click", () => {
  startDemo();
  state.cal = { method: "demo", ppm: 0 };
  setStatus("Simulated pickup, no calibration needed", "warn");
  setBanner("Demo mode: readings come from a simulated watch running +6.2 s/d, 274 deg, 0.4 ms.", "sim");
  startMeasuring();
});

function showStartError(msg) {
  const e = $("#start-error");
  e.textContent = msg;
  e.hidden = false;
}

// Measuring is locked until this input has a calibration.
function routeAfterInput() {
  const cal = store.get(calKey(state.dev));
  if (!cal) { openWizard(); return; }
  activateCal(cal);
  startMeasuring();
}

function activateCal(cal) {
  state.cal = cal;
  const stale = cal.method !== "manual" && ageDays(cal) > E.CAL_MAX_AGE_DAYS;
  setStatus(`${state.dev.label}. ${describeCal(cal)}`, cal.method === "manual" ? "bad" : stale ? "warn" : "ok");
  if (cal.method === "manual") setBanner("Manual correction in use. Results are flagged until you run a calibration.", "warn", openWizard);
  else if (stale) setBanner(`This calibration is ${Math.floor(ageDays(cal))} days old. Recalibrate to keep rate readings accurate.`, "warn", openWizard);
  else setBanner(null);
}

// ------------------------------------------------------------ wizard
let wiz = {};

function gotoStep(n) {
  for (let i = 1; i <= 5; i++) $(`#step-${i}`).hidden = i !== n;
  $$("#steps li").forEach((li) => {
    const s = +li.dataset.step;
    li.className = s < n ? "done" : s === n ? "current" : "";
  });
  wiz.step = n;
  const focus = $(`#step-${n}`).querySelector("button.primary:not([disabled]), select, input");
  if (focus) focus.focus({ preventScroll: true });
}

function openWizard() {
  state.sink = null;
  wiz = { step: 1 };
  show("screen-wizard");
  setBanner(null);
  setStatus(`${state.dev.label}. Not calibrated`, "bad");
  updateDeviceInfo();
  gotoStep(1);
}

function updateDeviceInfo() {
  const d = state.dev;
  const ch = d.channels == null ? "" : d.channels >= 2 ? ", 2 channels" : ", 1 channel";
  $("#device-info").textContent = `${d.label}, ${d.sr.toLocaleString()} Hz${ch}`;
}

$("#device").addEventListener("change", async (e) => {
  try { await openInput(e.target.value); updateDeviceInfo(); }
  catch (err) { $("#device-info").textContent = `Couldn't open that input: ${err.message}`; }
});

$("#btn-step1").addEventListener("click", () => {
  const existing = store.get(calKey(state.dev));
  if (existing && wiz.fromMeasure !== true && existing.method !== "manual" && ageDays(existing) <= E.CAL_MAX_AGE_DAYS && !wiz.forced) {
    // A valid calibration already exists for the input picked here.
    activateCal(existing);
    startMeasuring();
    return;
  }
  const pps = $("#choice-pps"), radio = pps.querySelector("input");
  const mono = state.dev.channels === 1;
  radio.disabled = mono;
  pps.classList.toggle("disabled", mono);
  $("#pps-note").textContent = mono
    ? "This input reports one channel. GPS needs a stereo input with the pulse on input 2."
    : "GPS module pulse output into input 2. About 1 minute.";
  if (mono) document.querySelector('input[name="method"][value="quartz"]').checked = true;
  syncMethod();
  gotoStep(2);
});

function syncMethod() {
  const m = document.querySelector('input[name="method"]:checked').value;
  $("#quartz-offset-row").hidden = m !== "quartz";
  wiz.method = m;
}
$$('input[name="method"]').forEach((r) => r.addEventListener("change", syncMethod));
$("#btn-back2").addEventListener("click", () => gotoStep(1));

$("#btn-manual").addEventListener("click", () => {
  const v = parseFloat($("#manual-ppm").value);
  if (!Number.isFinite(v) || Math.abs(v) > 1000) { $("#manual-ppm").focus(); return; }
  const cal = { method: "manual", ppm: v, created: new Date().toISOString(), label: state.dev.label, sr: state.dev.sr };
  store.save(calKey(state.dev), cal);
  activateCal(cal);
  startMeasuring();
});

$("#btn-step2").addEventListener("click", () => {
  syncMethod();
  wiz.refOffset = wiz.method === "quartz" ? parseFloat($("#ref-offset").value) || 0 : 0;
  wiz.channel = wiz.method === "pps" ? 1 : 0;
  state.wizardChannel = wiz.channel;
  $("#signal-hint").textContent = wiz.method === "pps"
    ? "Connect the GPS module's 1 PPS output to input 2 and wait for a position fix."
    : "Place the quartz watch on the pickup, crown facing the same way you'll test watches.";
  startSignalCheck();
  gotoStep(3);
});
$("#btn-back3").addEventListener("click", () => { state.sink = null; gotoStep(2); });

function feed(tracker, ch0, ch1) {
  const block = wiz.channel === 1 ? ch1 : ch0;
  if (!block) return false;
  return tracker.push(block);
}

function startSignalCheck() {
  const tr = new E.PulseTracker(state.dev.sr);
  const sr = state.dev.sr;
  state.sink = (c0, c1) => {
    feed(tr, c0, c1);
    const recent = tr.positions.filter((p) => p > tr.ring.total - 5 * sr).length;
    $("#pulse-count").textContent = recent;
    $("#btn-step3").disabled = recent < 3;
    $("#meter").style.width = `${Math.min(100, (state.peak || 0) * 140)}%`;
  };
}

$("#btn-step3").addEventListener("click", () => { startCalibrationRun(); gotoStep(4); });
$("#btn-cancel4").addEventListener("click", () => { state.sink = null; gotoStep(2); });

function startCalibrationRun() {
  const sr = state.dev.sr;
  const tr = new E.PulseTracker(sr);
  const needed = E.MIN_CAL_SECONDS[wiz.method];
  $("#cal-ppm").textContent = "measuring";
  $("#cal-spread").textContent = "measuring";
  $("#cal-progress").style.width = "0%";
  state.sink = (c0, c1) => {
    if (!feed(tr, c0, c1)) return;
    const ev = E.evaluateCalibration(tr.pulses, sr, wiz.method, wiz.refOffset);
    const total = tr.ring.total / sr;
    $("#cal-elapsed").textContent = `${fmtClock(total)} of ${fmtClock(needed)}`;
    $("#cal-progress").style.width = `${Math.min(100, (ev.duration / needed) * 100)}%`;
    if (Number.isFinite(ev.ppm)) $("#cal-ppm").textContent = fmtPpm(ev.ppm);
    $("#cal-spread").textContent = Number.isFinite(ev.spreadPpm)
      ? `${ev.spreadPpm.toFixed(2)} ppm ${ev.stable ? "(steady)" : "(settling)"}`
      : "measuring";
    const lastPulse = tr.positions[tr.positions.length - 1];
    const gap = lastPulse === undefined ? total : (tr.ring.total - lastPulse) / sr;
    $("#cal-note").textContent = gap > 5
      ? "No reference pulse for over 5 seconds. Check the watch on the pickup or the GPS cable."
      : ev.duration >= needed && !ev.stable
        ? "Long enough, waiting for the reading to hold within 0.5 ppm. Keep the bench still."
        : tr.dropouts > Math.max(5, total / 15)
          ? "Audio is dropping out too often to calibrate reliably. Close other busy apps or tabs, or try another USB port, then cancel and start again."
        : tr.dropouts
          ? `Audio dropped out ${tr.dropouts} time${tr.dropouts > 1 ? "s" : ""}. That's handled, but the run may take longer. Close other busy apps if it keeps happening.`
          : "Keep the bench still. The run finishes on its own once the reading has held steady long enough.";
    if (ev.valid) finishCalibration(ev);
  };
}

function finishCalibration(ev) {
  state.sink = null;
  wiz.result = ev;
  $("#cal-result").textContent = `Correction ${fmtPpm(ev.ppm)}`;
  $("#cal-result-detail").textContent =
    `Without it, this input would misread every watch by ${signed(-ev.sdEquivalent, 2)} s/d. ` +
    `Measured from ${ev.pulses} ${ev.method === "pps" ? "GPS" : "quartz"} pulses over ${fmtClock(ev.duration)}, steady to ${ev.spreadPpm.toFixed(2)} ppm.`;
  gotoStep(5);
}

$("#btn-save").addEventListener("click", () => {
  const ev = wiz.result;
  const cal = {
    method: ev.method, ppm: ev.ppm, created: new Date().toISOString(),
    label: state.dev.label, sr: state.dev.sr, referenceOffsetSd: wiz.refOffset || 0,
    pulses: ev.pulses, spreadPpm: ev.spreadPpm,
  };
  store.save(calKey(state.dev), cal);
  state.wizardChannel = 0;
  activateCal(cal);
  startMeasuring();
});

const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ------------------------------------------------------------ measuring
function startMeasuring() {
  show("screen-measure");
  const bph = parseInt($("#bph").value, 10) || null;
  state.tracker = new E.BeatTracker(state.dev.sr, { bph });
  state.history = [];
  state.lastReading = null;
  state.resetAt = performance.now();
  clearReadouts();
  state.sink = (c0) => { if (state.tracker.push(c0)) onReading(); };
  resizeCanvas();
  refreshFileCalOptions();
}

function clearReadouts() {
  $("#r-rate").textContent = "--";
  $("#r-amp").textContent = "--";
  $("#r-be").textContent = "--";
  $("#r-meta").textContent = "Listening. Place the watch on the pickup.";
  $("#q-meter").style.width = "0%";
  $("#q-text").textContent = "--";
}

function settings() {
  return {
    lift: Math.min(90, Math.max(10, parseFloat($("#lift").value) || 52)),
    avg: parseFloat($("#avg").value),
    span: parseFloat($("#speed").value),
  };
}

function onReading() {
  const tr = state.tracker;
  const { lift, avg } = settings();
  const ppm = state.cal?.ppm || 0;
  const q = tr.signal.quality || 0;
  $("#q-meter").style.width = `${Math.round(q * 100)}%`;
  $("#q-meter").style.background = q > 0.9 ? "var(--ok)" : q > 0.6 ? "var(--warn)" : "var(--ruby)";
  const drops = tr.dropouts ? `, ${tr.dropouts} audio dropout${tr.dropouts > 1 ? "s" : ""} handled` : "";
  $("#q-text").textContent = tr.bph ? `${Math.round(q * 100)}% of beats clean${drops}` : "Detecting beat rate";
  const r = tr.reading(lift, ppm, avg);
  if (r && Number.isFinite(r.rate)) {
    state.lastReading = r;
    $("#r-rate").textContent = signed(r.rate, 1);
    $("#r-amp").textContent = Number.isFinite(r.amplitude) ? Math.round(r.amplitude) : "--";
    $("#r-be").textContent = r.beatErrorMs.toFixed(1);
    const flag = state.cal?.method === "manual" ? ", manual correction (flagged)" : state.cal?.method === "demo" ? ", simulated" : "";
    $("#r-meta").textContent =
      `${r.bph.toLocaleString()} A/h${$("#bph").value ? "" : " (auto)"}, lift angle ${lift} deg, ` +
      `${Number.isFinite(avg) ? `averaged over ${avg} s` : "averaged since reset"}, ${r.beats} beats${flag}`;
    state.history.push({ t: tr.beats[tr.beats.length - 1].time, rate: r.rate, amp: r.amplitude, be: r.beatErrorMs });
    if (state.history.length > 3600) state.history.shift();
  } else if (tr.bph) {
    $("#r-meta").textContent = `${tr.bph.toLocaleString()} A/h detected. Collecting beats.`;
  }
  draw();
}

$("#bph").addEventListener("change", () => {
  if (!state.tracker) return;
  state.tracker.setBph(parseInt($("#bph").value, 10) || null);
  state.history = [];
  clearReadouts();
});
$("#avg").addEventListener("change", () => state.tracker && onReading());
$("#lift").addEventListener("change", () => state.tracker && onReading());
$("#speed").addEventListener("change", draw);
$("#btn-reset").addEventListener("click", () => {
  if (!state.tracker) return;
  state.tracker.reset();
  state.history = [];
  clearReadouts();
  draw();
});
$("#btn-recal").addEventListener("click", () => {
  if (state.dev?.demo) { setBanner("The demo uses a simulated pickup, so there's nothing to calibrate. Connect a pickup to calibrate a real input.", "sim"); return; }
  wiz.forced = true;
  openWizard();
  wiz.forced = true;
});
$("#btn-input").addEventListener("click", async () => {
  if (state.dev?.demo) {
    stopInput();
    show("screen-start");
    setStatus(null); setBanner(null);
    return;
  }
  await listDevices(state.dev.id);
  openWizard();
  wiz.forced = false;
});

// ------------------------------------------------------------ display views
const canvas = $("#view");
const cx = canvas.getContext("2d");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}
window.addEventListener("resize", resizeCanvas);

$$(".tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".tabs button").forEach((o) => o.setAttribute("aria-selected", String(o === b)));
  state.view = b.dataset.view;
  $("#legend").hidden = state.view !== "diagram";
  $("#speed").disabled = state.view !== "diagram";
  draw();
}));

function frame() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  cx.clearRect(0, 0, w, h);
  cx.font = `12px ${css("--font")}`;  // Syne Mono
  return { w, h };
}

function emptyMessage(text) {
  const { w, h } = frame();
  cx.fillStyle = css("--muted");
  cx.textAlign = "center";
  cx.fillText(text, w / 2, h / 2);
  cx.textAlign = "left";
}

function draw() {
  if (!state.tracker || $("#screen-measure").hidden) return;
  if (state.view === "diagram") drawDiagram();
  else if (state.view === "trend") drawTrend();
  else drawScope();
}

// Diagram: each beat's timing against a perfect grid, like the classic paper tape.
// Slope = rate, gap between the tick and tock lines = beat error.
function drawDiagram() {
  const tr = state.tracker;
  if (!tr.bph || tr.beats.length < 2) return emptyMessage("Waiting for beats");
  const { w, h } = frame();
  const { span } = settings();
  const scale = 1 + (state.cal?.ppm || 0) * 1e-6;
  const tNom = 3600 / tr.bph;
  const ref = tr.beats[0];
  const phase0 = ref.time * scale - ref.index * tNom;
  const W = 0.02; // 20 ms tall strip, wraps
  const end = tr.beats[tr.beats.length - 1].time;
  const padL = 44, padR = 12, padT = 12, padB = 26;
  const pw = w - padL - padR, ph = h - padT - padB;

  cx.strokeStyle = css("--rule");
  cx.fillStyle = css("--muted");
  cx.lineWidth = 1;
  for (let ms = -10; ms <= 10; ms += 2) {
    const y = padT + ph / 2 - (ms / 1000 / W) * ph;
    cx.globalAlpha = ms === 0 ? 1 : 0.5;
    cx.beginPath(); cx.moveTo(padL, y); cx.lineTo(w - padR, y); cx.stroke();
    cx.globalAlpha = 1;
    if (ms % 4 === 0) cx.fillText(`${ms > 0 ? "+" : ms < 0 ? MINUS : ""}${Math.abs(ms)} ms`, 4, y + 4);
  }
  for (let s = 0; s <= span; s += span / 6) {
    const x = padL + pw - (s / span) * pw;
    cx.fillText(s === 0 ? "now" : `${MINUS}${Math.round(s)} s`, x - 14, h - 8);
  }
  const ruby = css("--ruby"), sapphire = css("--sapphire");
  for (let i = tr.beats.length - 1; i >= 0; i--) {
    const b = tr.beats[i];
    const age = end - b.time;
    if (age > span) break;
    let p = b.time * scale - b.index * tNom - phase0;
    p = ((((p + W / 2) % W) + W) % W) - W / 2;
    const x = padL + pw - (age / span) * pw;
    // a gaining watch beats early, which the tape shows as a rising line
    const y = padT + ph / 2 + (p / W) * ph;
    cx.fillStyle = (b.index - ref.index) % 2 ? sapphire : ruby;
    cx.beginPath(); cx.arc(x, y, 2.2, 0, Math.PI * 2); cx.fill();
  }
}

// Trend: rate and amplitude over the session.
function drawTrend() {
  const hst = state.history;
  if (hst.length < 2) return emptyMessage("Trend appears after a few readings");
  const { w, h } = frame();
  const padL = 56, padR = 12, gap = 28;
  const ph = (h - 24 - gap) / 2;
  const t0 = hst[0].t, t1 = hst[hst.length - 1].t;
  const xs = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const panel = (key, top, color, label, minRange, fmt) => {
    const vals = hst.map((d) => d[key]).filter(Number.isFinite);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < minRange) { const m = (hi + lo) / 2; lo = m - minRange / 2; hi = m + minRange / 2; }
    const ys = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
    cx.strokeStyle = css("--rule"); cx.lineWidth = 1;
    cx.strokeRect(padL, top, w - padL - padR, ph);
    cx.fillStyle = css("--muted");
    cx.fillText(label, padL + 6, top + 14);
    cx.fillText(fmt(hi), 4, top + 10);
    cx.fillText(fmt(lo), 4, top + ph);
    cx.strokeStyle = color; cx.lineWidth = 2;
    cx.beginPath();
    hst.forEach((d, i) => { if (Number.isFinite(d[key])) (i ? cx.lineTo : cx.moveTo).call(cx, xs(d.t), ys(d[key])); });
    cx.stroke();
  };
  panel("rate", 8, css("--ruby"), "Rate (s/d)", 10, (v) => signed(v, 1));
  panel("amp", 8 + ph + gap, css("--sapphire"), "Amplitude (deg)", 40, (v) => `${Math.round(v)}`);
  cx.fillStyle = css("--muted");
  cx.fillText(`${fmtClock(t1 - t0)} shown`, w - padR - 70, h - 4);
}

// Scope: the averaged sound of a beat, with the unlock and drop marked.
function drawScope() {
  const last = state.tracker.last;
  if (!last || last.events.length < 2) return emptyMessage("Waiting for beats");
  const { w, h } = frame();
  const sr = state.dev.sr;
  const pre = 0.003, post = 0.03;
  const n = Math.round((pre + post) * sr);
  const avg = new Float64Array(n);
  let count = 0;
  for (const e of last.events) {
    const start = Math.round(e.t * sr - pre * sr);
    if (start < 0 || start + n > last.fine.length) continue;
    for (let i = 0; i < n; i++) avg[i] += last.fine[start + i];
    count++;
  }
  if (!count) return emptyMessage("Waiting for beats");
  let mx = 0;
  for (let i = 0; i < n; i++) { avg[i] /= count; mx = Math.max(mx, avg[i]); }
  const padL = 12, padR = 12, padT = 16, padB = 26;
  const pw = w - padL - padR, ph = h - padT - padB;
  const xs = (s) => padL + ((s + pre) / (pre + post)) * pw;
  cx.strokeStyle = css("--rule"); cx.fillStyle = css("--muted"); cx.lineWidth = 1;
  for (let ms = 0; ms <= 30; ms += 5) {
    const x = xs(ms / 1000);
    cx.beginPath(); cx.moveTo(x, padT); cx.lineTo(x, padT + ph); cx.stroke();
    cx.fillText(`${ms} ms`, x - 12, h - 8);
  }
  cx.strokeStyle = css("--graphite"); cx.lineWidth = 1.5;
  cx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = padL + (i / (n - 1)) * pw, y = padT + ph - (avg[i] / mx) * ph * 0.92;
    i ? cx.lineTo(x, y) : cx.moveTo(x, y);
  }
  cx.stroke();
  const dt = E.median(last.events.map((e) => e.dt));
  const mark = (s, label, color) => {
    const x = xs(s);
    cx.strokeStyle = color; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(x, padT); cx.lineTo(x, padT + ph); cx.stroke();
    cx.fillStyle = color; cx.fillText(label, x + 4, padT + 10);
  };
  mark(0, "unlock", css("--muted"));
  mark(dt, `drop, ${(dt * 1000).toFixed(1)} ms after unlock`, css("--muted"));
}

// ------------------------------------------------------------ file analysis
function refreshFileCalOptions() {
  const sel = $("#file-cal");
  const all = store.all();
  sel.innerHTML = "";
  for (const [key, cal] of Object.entries(all)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = `${cal.label || key.split("|")[0]}, ${Number(cal.sr || key.split("|")[1]).toLocaleString()} Hz`;
    if (state.dev && key === calKey(state.dev)) o.selected = true;
    sel.append(o);
  }
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Unknown input (result flagged)";
  sel.append(none);
}
refreshFileCalOptions();

$("#file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const out = $("#file-result");
  out.textContent = "Analyzing the recording. Long files take a few seconds.";
  try {
    const parsed = E.parseWav(await file.arrayBuffer());
    const key = $("#file-cal").value;
    const cal = key ? store.get(key) : null;
    if (cal && Number(cal.sr) !== parsed.sr) {
      out.textContent = `That calibration is for ${Number(cal.sr).toLocaleString()} Hz but the file is ${parsed.sr.toLocaleString()} Hz. Pick the matching input or Unknown input.`;
      return;
    }
    const maxS = 300;
    const x = parsed.channels[0].subarray(0, Math.min(parsed.channels[0].length, maxS * parsed.sr));
    const lift = parseFloat($("#file-lift").value) || 52;
    await new Promise((r) => setTimeout(r, 30));
    const r = E.analyzeSignal(x, parsed.sr, { liftAngle: lift, ppm: cal?.ppm || 0 });
    const flag = !cal ? ". Flagged: no calibration, rate may be off by several s/d"
      : cal.method === "manual" ? ". Flagged: manual correction" : "";
    out.textContent = `${file.name}: ${signed(r.rate, 1)} s/d, ${Math.round(r.amplitude)} deg, ` +
      `${r.beatErrorMs.toFixed(1)} ms beat error, ${r.bph.toLocaleString()} A/h, ${r.beats} beats` +
      `${x.length / parsed.sr >= maxS ? ` (first ${maxS / 60} minutes)` : ""}${flag}.`;
  } catch (err) {
    out.textContent = `Couldn't analyze ${file.name}: ${err.message}.`;
  }
});

// Handy for automated tests and embedding: window.otg exposes read-only state.
window.otg = { state, store };
