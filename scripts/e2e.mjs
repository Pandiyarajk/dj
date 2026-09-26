/*
 * e2e.mjs: drive the real app in headless Chrome/Edge over the DevTools
 * Protocol and check that the audio actually does what the UI says.
 *
 * Clicks real buttons (trusted input, so the AudioContext unlocks as it would
 * for a user), then reads state through the `?debug=1` hook: audio flows to
 * the master bus, beat grids match the demo tracks, sync lands in phase and
 * follows tempo, loops wrap, hot cues set and clear, and every press shows an
 * acknowledgement. No npm install: Node's built-in fetch + WebSocket.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (auto-gain strip check reads the gain after the context runs;
 *   waits for the browser to exit before deleting its profile; PERFORM fits the
 *   dialogue pads on a 1280x800 screen)
 *
 *   node scripts/e2e.mjs [base-url] [--shot out.png]
 *   (serve first: npm run build && npm run preview)
 *
 * Exit 0 = all checks passed, 1 = a check failed or the page logged errors,
 * 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const base = argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:4173/';
const shotIndex = argv.indexOf('--shot');
const shot = shotIndex >= 0 ? argv[shotIndex + 1] : null;

const bin = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!bin) {
  console.error('No Chrome/Edge found; set CHROME_PATH.');
  process.exit(2);
}

const port = 9322 + (process.pid % 400);
const profile = mkdtempSync(join(tmpdir(), 'dj-e2e-'));
const proc = spawn(
  bin,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1280,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* browser may still hold files */
  }
});

/**
 * Stop the browser and delete its profile. Deleting straight after kill()
 * failed on Windows (the browser still held its files) and leaked one
 * %TEMP%\dj-e2e-* folder per run: 200+ after a few soaks.
 */
async function closeBrowser() {
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  await Promise.race([exited, sleep(5000)]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.log(`note: could not delete the test profile ${profile}: ${error.message}`);
  }
}

async function debuggerUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('browser never opened its debugging port');
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
let sessionId = null;
const pending = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.error ? { error: m.error } : m.result);
    pending.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') problems.push(`UNCAUGHT ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`CONSOLE ${m.params.args.map((a) => a.description ?? a.value).join(' ')}`);
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !m.params.entry.text.includes('favicon')) problems.push(`LOG ${m.params.entry.text}`);
};
function send(method, params = {}, sess = sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sess ? { sessionId: sess } : {}) }));
  return new Promise((res) => pending.set(id, res));
}

// Downloads (recordings, CSV and JSON exports) go to the throwaway profile,
// never the user's Downloads folder: every run used to leave files there.
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(profile, 'downloads'), eventsEnabled: false }, null);
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
for (const domain of ['Runtime', 'Log', 'Page']) await send(`${domain}.enable`);
const url = new URL(base);
url.searchParams.set('demo', '1');
url.searchParams.set('debug', '1');
await send('Page.navigate', { url: url.href });

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? expression}`);
  return result.result?.value;
}

async function waitFor(expression, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Click the button inside `scope` whose text is `text`, with real mouse events. */
async function click(scope, text, modifiers = 0) {
  const rect = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`no button "${text}" in ${scope}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers });
  }
}

/** Press or release (not both) the button in `scope` with text `text`. */
async function pointer(scope, text, type) {
  const rect = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return null;
    // Only scroll on press: scrolling between press and release would move the target.
    if (${JSON.stringify(type)} === 'mousePressed') el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error(`no button "${text}" in ${scope}`);
  await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
}

/** Average level, dB, of an analyser's bins below `hz`, over several reads. */
const lowBandDb = (analyserExpr, hz) => `(async () => {
  const a = ${analyserExpr};
  a.smoothingTimeConstant = 0;
  const bins = new Float32Array(a.frequencyBinCount);
  const top = Math.max(1, Math.floor(${hz} / (window.dj.engine.ctx.sampleRate / a.fftSize)));
  let sum = 0, n = 0;
  for (let k = 0; k < 20; k++) {
    a.getFloatFrequencyData(bins);
    for (let i = 1; i <= top; i++) { sum += Math.pow(10, bins[i] / 10); n++; }
    await new Promise((r) => setTimeout(r, 40));
  }
  return 10 * Math.log10(sum / n + 1e-20);
})()`;

async function key(code, keyName, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code, key: keyName, modifiers });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const deckExpr = (i) => `window.dj.decks[${i}]`;
const phaseExpr = `(() => {
  const [a, b] = window.dj.decks;
  const beat = (d) => (d.renderPosition() - d.state.firstBeat) * d.state.bpm / 60;
  const diff = beat(b) - beat(a);
  return diff - Math.floor(diff + 0.5);
})()`;

try {
  await waitFor('window.dj && window.dj.decks.every((d) => d.state.bpm !== null && d.state.peaks)', 30000, 'both demo tracks analysed');

  // Beat grids against the known demo tracks (house-124 offset 0.12 s, house-128 offset 0.31 s).
  for (const [i, bpm, offset] of [[0, 124, 0.12], [1, 128, 0.31]]) {
    const s = await evaluate(`({ bpm: ${deckExpr(i)}.state.bpm, firstBeat: ${deckExpr(i)}.state.firstBeat })`);
    const beat = 60 / bpm;
    const d = ((((s.firstBeat - offset) % beat) + beat) % beat);
    const err = Math.min(d, beat - d);
    check(`deck ${i ? 'B' : 'A'} BPM and grid`, Math.abs(s.bpm - bpm) <= 0.05 && err <= 0.015, `${s.bpm} BPM, grid off by ${(err * 1000).toFixed(1)} ms`);
  }

  // Performance mode hides prep controls and shrinks the library; service worker registers.
  await click('.topbar-right', 'PERFORM');
  const perform = await evaluate(`({ on: document.body.classList.contains('perform'), grid: getComputedStyle(document.querySelector('.grid-row')).display, lib: parseFloat(getComputedStyle(document.querySelector('.library-table-wrap')).maxHeight) })`);
  // On a 1280x800 laptop screen PERFORM shows every dialogue pad and MIC
  // without scrolling (they used to start below the fold).
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.scrollTo(0, 0)');
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const fold = await evaluate(`(() => {
    const pads = [...document.querySelectorAll('.dialog-pad')].map((p) => p.getBoundingClientRect().bottom);
    return { pads: pads.length, lowest: Math.round(Math.max(...pads)), mic: Math.round(document.querySelector('.sampler-mic').getBoundingClientRect().bottom), height: innerHeight, wide: document.documentElement.scrollWidth > innerWidth };
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');
  check('PERFORM fits all 8 dialogue pads and MIC on a 1280x800 screen', fold.pads === 8 && fold.lowest <= fold.height && fold.mic <= fold.height && !fold.wide, JSON.stringify(fold));
  await click('.topbar-right', 'PERFORM');
  const performOff = await evaluate(`({ on: document.body.classList.contains('perform'), grid: getComputedStyle(document.querySelector('.grid-row')).display })`);
  check('PERFORM hides prep controls and shrinks the library, and back', perform.on && perform.grid === 'none' && perform.lib <= 150 && !performOff.on && performOff.grid !== 'none', JSON.stringify({ perform, performOff }));
  const swScope = await evaluate(`(async () => { for (let i = 0; i < 20; i++) { const r = await navigator.serviceWorker.getRegistration(); if (r) return r.scope; await new Promise((res) => setTimeout(res, 200)); } return null; })()`);
  check('service worker registers for offline use', typeof swScope === 'string' && swScope.startsWith('http'), String(swScope));

  // Play A with a real click: the context unlocks and audio reaches the master bus.
  await click('.deck-a', 'PLAY');
  await sleep(1200);
  const running = await evaluate('window.dj.engine.ctx.state');
  const posA = await evaluate(`${deckExpr(0)}.position()`);
  // One analyser window is 21 ms and can fall between drum hits: take the loudest of several.
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    peak = Math.max(peak, await evaluate('window.dj.engine.meter(window.dj.engine.masterAnalyser).peak'));
    await sleep(50);
  }
  check('audio context running after a click', running === 'running', running);
  check('deck A playhead advances', posA > 0.5 && posA < 2, `${posA.toFixed(2)} s after 1.2 s`);
  check('audio reaches the master bus', peak > 0.05, `peak ${peak.toFixed(3)}`);

  // Key and auto-gain reach the deck and the channel strip. Read only once the
  // context runs: a gain ramp does not advance while it is suspended, so this
  // passed only by luck while the demo track's auto-gain was near 0 dB.
  const tonal = await evaluate(`({ key: document.querySelector('.deck-a .key-value').textContent, auto: document.querySelector('.channel-a .autogain-readout').textContent, db: window.dj.decks[0].state.autoGainDb, gain: window.dj.engine.strips[0].input.gain.value })`);
  check('deck shows a Camelot key and the auto-gain it applied', /^\d{1,2}[AB]$/.test(tonal.key) && /^AUTO [+-]\d+\.\d dB$/.test(tonal.auto) && Math.abs(20 * Math.log10(tonal.gain) - tonal.db) < 0.2, `key ${tonal.key}, ${tonal.auto}, strip ${(20 * Math.log10(tonal.gain)).toFixed(2)} dB`);

  // Effects: tempo-synced echo, a tail that rings out, type cycling.
  const masterPeak = `(async () => { let p = 0; for (let i = 0; i < 8; i++) { p = Math.max(p, window.dj.engine.meter(window.dj.engine.masterAnalyser).peak); await new Promise((r) => setTimeout(r, 40)); } return p; })()`;
  await click('.deck-a .fx-row', 'FX');
  await sleep(300);
  const echoTime = await evaluate('window.dj.engine.strips[0].fx.echoTime');
  const expectedEcho = (0.75 * 60) / (await evaluate(`${deckExpr(0)}.effectiveBpm`));
  await evaluate(`${deckExpr(0)}.pause()`);
  await sleep(350);
  const tail = await evaluate(masterPeak);
  await click('.deck-a .fx-row', 'FX ON');
  await sleep(4500);
  const silent = await evaluate(masterPeak);
  check('echo is tempo-synced and rings out after the deck stops', Math.abs(echoTime - expectedEcho) < 0.005 && tail > 0.005 && silent < 0.002, `echo ${echoTime.toFixed(3)} s (want ${expectedEcho.toFixed(3)}), tail ${tail.toFixed(4)}, later ${silent.toFixed(4)}`);
  await click('.deck-a .fx-row', 'ECHO');
  const fxType = await evaluate(`document.querySelector('.deck-a .fx-type').textContent`);
  await click('.deck-a .fx-row', fxType);
  await click('.deck-a .fx-row', 'FLANGER');
  check('FX type cycles ECHO, REVERB, FLANGER', fxType === 'REVERB' && (await evaluate(`document.querySelector('.deck-a .fx-type').textContent`)) === 'ECHO');
  await evaluate(`${deckExpr(0)}.play()`);
  await sleep(500);

  // Mix recording: about 3 s of the playing master, decoded back.
  await evaluate('window.dj.recorder.start({ memory: true })');
  const recLabel = await evaluate(`document.querySelector('.btn-rec').textContent`);
  await sleep(3000);
  await evaluate('window.dj.recorder.stop()');
  const rec = await evaluate(`(async () => {
    const blob = window.dj.recorder.lastBlob;
    if (!blob) return null;
    const audio = await window.dj.engine.ctx.decodeAudioData(await blob.arrayBuffer());
    const data = audio.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return { seconds: audio.duration, rate: audio.sampleRate, channels: audio.numberOfChannels, rms: Math.sqrt(sum / data.length), status: window.dj.recorder.store.get().status };
  })()`);
  check('REC records the master to a WAV that decodes, with audio in it', rec !== null && /^REC /.test(recLabel) && Math.abs(rec.seconds - 3) < 0.4 && rec.channels === 2 && rec.rms > 0.01 && /Recorded 0:0[23]/.test(rec.status), rec ? `${rec.seconds.toFixed(2)} s, ${rec.channels} ch, rms ${rec.rms.toFixed(3)}, "${rec.status}"` : 'no blob');

  // (Needs the context running: suspended automation does not advance.)
  // The demo track's peak already sits at -1 dBFS, so its auto-gain is ~0 dB
  // (the ceiling blocks a boost): use a known -6 dB to prove the switch.
  await evaluate('window.dj.engine.strips[0].setAutoGain(-6)');
  await sleep(200);
  const autoOn = await evaluate('window.dj.engine.strips[0].input.gain.value');
  await click('.master-strip', 'AUTO GAIN');
  await sleep(200);
  const autoOff = await evaluate(`({ gain: window.dj.engine.strips[0].input.gain.value, text: document.querySelector('.channel-a .autogain-readout').textContent })`);
  await click('.master-strip', 'AUTO GAIN');
  await sleep(200);
  const autoBack = await evaluate('window.dj.engine.strips[0].input.gain.value');
  await evaluate(`window.dj.engine.strips[0].setAutoGain(window.dj.decks[0].state.autoGainDb)`);
  check('AUTO GAIN switch bypasses and restores the gain stage', Math.abs(autoOn - 0.501) < 0.01 && Math.abs(autoOff.gain - 1) < 1e-3 && autoOff.text === 'AUTO off' && Math.abs(autoBack - 0.501) < 0.01, `on ${autoOn.toFixed(3)}, off ${autoOff.gain.toFixed(3)}, back ${autoBack.toFixed(3)}`);


  // Sync B to A, then play B: tempo matched and in phase.
  await click('.deck-b', 'SYNC');
  const synced = await evaluate(`({ synced: ${deckExpr(1)}.state.synced, bpm: ${deckExpr(1)}.effectiveBpm, notice: document.querySelector('.deck-b .deck-status').textContent })`);
  check('sync matches tempo', synced.synced && Math.abs(synced.bpm - 124) < 0.01, `${synced.bpm?.toFixed(3)} BPM`);
  check('sync acknowledges itself', /Synced to deck A/.test(synced.notice), synced.notice);
  await click('.deck-b', 'PLAY');
  await sleep(1500);
  const phase = await evaluate(phaseExpr);
  check('decks in phase after sync', Math.abs(phase) < 0.02, `${(phase * 100).toFixed(2)}% of a beat`);
  if (Math.abs(phase) >= 0.02) {
    console.log('  align:', JSON.stringify(await evaluate('window.dj.sync.lastAlign')));
    console.log('  reports:', JSON.stringify(await evaluate('({ now: window.dj.engine.ctx.currentTime, a: window.dj.decks[0].report, b: window.dj.decks[1].report, rateA: window.dj.decks[0].rate, rateB: window.dj.decks[1].rate })')));
  }

  // Leader tempo change carries the follower.
  await evaluate(`${deckExpr(0)}.setTempo(0.03)`);
  const follow = await evaluate(`[${deckExpr(0)}.effectiveBpm, ${deckExpr(1)}.effectiveBpm]`);
  check('follower tracks leader tempo', Math.abs(follow[0] - follow[1]) < 0.01, `${follow[0].toFixed(2)} vs ${follow[1].toFixed(2)}`);
  await sleep(2000);
  const drift = await evaluate(phaseExpr);
  check('still in phase 2 s after a tempo change', Math.abs(drift) < 0.02, `${(drift * 100).toFixed(2)}% of a beat`);

  // Key lock on both synced decks: grains are placed within +/-2.7 ms, so the
  // mix must stay in phase and the processor keeps playing.
  await click('.deck-a .tempo-section', 'KEYLOCK');
  await click('.deck-b .tempo-section', 'KEYLOCK');
  await sleep(1500);
  const lockedPhase = await evaluate(phaseExpr);
  // Loudest of several 21 ms windows: one window can fall between drum hits.
  const lockedPeak = await evaluate(`(async () => { let p = 0; for (let i = 0; i < 10; i++) { p = Math.max(p, window.dj.engine.meter(window.dj.engine.masterAnalyser).peak); await new Promise((r) => setTimeout(r, 40)); } return p; })()`);
  const lockUi = await evaluate(`[...document.querySelectorAll('.btn-keylock')].every((b) => b.classList.contains('on'))`);
  check('key lock on both synced decks keeps them in phase', lockUi && Math.abs(lockedPhase) < 0.02 && lockedPeak > 0.02, `${(lockedPhase * 100).toFixed(2)}% of a beat, peak ${lockedPeak.toFixed(3)}`);
  await click('.deck-a .tempo-section', 'KEYLOCK');
  await click('.deck-b .tempo-section', 'KEYLOCK');
  await sleep(200);

  check('phase meter reads "In phase"', (await evaluate(`document.querySelector('.phase-label').textContent`)) === 'In phase');

  // A quantized hot-cue jump on the synced deck keeps it in phase.
  await click('.deck-b .pads', '5');
  await sleep(1300);
  await click('.deck-b .pads', '5');
  await sleep(400);
  const cuePhase = await evaluate(phaseExpr);
  check('hot-cue jump on a synced deck stays in phase', Math.abs(cuePhase) < 0.02, `${(cuePhase * 100).toFixed(2)}% of a beat`);

  // Moving the follower's own fader moves the shared tempo instead of dropping sync.
  await evaluate(`${deckExpr(1)}.setTempo(0.02)`);
  const shared = await evaluate(`({ synced: ${deckExpr(1)}.state.synced, a: ${deckExpr(0)}.effectiveBpm, b: ${deckExpr(1)}.effectiveBpm })`);
  check('follower tempo fader moves both decks and keeps sync', shared.synced && Math.abs(shared.a - shared.b) < 0.01 && Math.abs(shared.b - 128 * 1.02) < 0.01, `${shared.a.toFixed(2)} / ${shared.b.toFixed(2)}`);

  // Press SYNC again: releases, and says so (a press must never look like nothing happened).
  await click('.deck-b', 'SYNC');
  const released = await evaluate(`({ synced: ${deckExpr(1)}.state.synced, notice: document.querySelector('.deck-b .deck-status').textContent })`);
  check('second SYNC press releases with a notice', !released.synced && released.notice === 'Sync off', released.notice);

  // 4-beat loop on A wraps and stays inside its bounds.
  await click('.deck-a .loop-row', '4');
  const loop = await evaluate(`${deckExpr(0)}.state.loop`);
  let wrapped = false;
  let inside = true;
  let last = -1;
  for (let i = 0; i < 40; i++) {
    // The processor's own reported head, not the main-thread estimate (which
    // applies loop wrapping itself and would pass even if the worklet never looped).
    const p = await evaluate(`${deckExpr(0)}.report.frame / window.dj.engine.ctx.sampleRate`);
    if (p < last) wrapped = true;
    if (p < loop.start - 0.01 || p > loop.end + 0.01) inside = false;
    last = p;
    await sleep(100);
  }
  check('auto loop wraps and stays inside', loop && wrapped && inside, loop ? `${loop.start.toFixed(3)}-${loop.end.toFixed(3)} s` : 'no loop');
  // Beat jump back inside a loop: exactly 4 beats, and the loop moves with it.
  const before = await evaluate(`${deckExpr(0)}.report.frame / window.dj.engine.ctx.sampleRate`);
  await click('.deck-a .loop-row', '<< JUMP');
  await sleep(250);
  const moved = await evaluate(`({ loop: ${deckExpr(0)}.state.loop, pos: ${deckExpr(0)}.report.frame / window.dj.engine.ctx.sampleRate })`);
  const fourBeats = (4 * 60) / (await evaluate(`${deckExpr(0)}.state.bpm`));
  const shift = loop.start - moved.loop.start;
  check('beat jump in a loop moves the loop 4 beats and stays inside it', Math.abs(shift - fourBeats) < 1e-6 && moved.pos >= moved.loop.start - 0.01 && moved.pos <= moved.loop.end + 0.01, `loop moved ${shift.toFixed(3)} s, head ${moved.pos.toFixed(2)} in ${moved.loop.start.toFixed(2)}-${moved.loop.end.toFixed(2)} (was ${before.toFixed(2)})`);
  await click('.deck-a .loop-row', '4');
  check('same loop size again exits the loop', (await evaluate(`${deckExpr(0)}.state.loop`)) === null);

  // Hot cue: pad sets, Shift+key clears.
  await click('.deck-a .pads', '1');
  const cue = await evaluate(`${deckExpr(0)}.state.hotCues[0]`);
  check('hot cue pad sets a cue', typeof cue === 'number', String(cue));
  await key('Digit1', '!', 8);
  check('Shift+1 clears the hot cue', (await evaluate(`${deckExpr(0)}.state.hotCues[0]`)) === null);

  // Mixer: low kill and keyboard crossfader.
  const kills = await evaluate(`[...document.querySelectorAll('.channel-a .btn-kill')].length`);
  await evaluate(`document.querySelectorAll('.channel-a .btn-kill')[2].scrollIntoView({ block: 'center' })`);
  const killRect = await evaluate(`(() => { const r = document.querySelectorAll('.channel-a .btn-kill')[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  // Below 70 Hz (the kick's fundamental): a 24 dB/octave isolator crossing
  // over at 250 Hz attenuates less closer in, so the 94 Hz bin made a 25 dB
  // threshold flaky (24.8 to 27.5 dB measured) without the kill changing.
  const lowBefore = await evaluate(lowBandDb('window.dj.engine.strips[0].analyser', 70));
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...killRect, button: 'left', clickCount: 1 });
  check('low kill button toggles the low kill', kills === 3 && (await evaluate('window.dj.mixer.get().channels[0].kill.low')) === true);
  await sleep(200);
  const lowAfter = await evaluate(lowBandDb('window.dj.engine.strips[0].analyser', 70));
  check('low kill removes the low band (isolator)', lowBefore - lowAfter > 30, `${lowBefore.toFixed(1)} dB -> ${lowAfter.toFixed(1)} dB below 70 Hz`);
  await evaluate('document.activeElement && document.activeElement.blur()');
  await key('ArrowLeft', 'ArrowLeft');
  check('Left arrow moves the crossfader towards A', Math.abs((await evaluate('window.dj.mixer.get().crossfader')) + 0.1) < 1e-9);

  // Headphone cue routing: switching modes rewires the output and keeps master audible.
  await evaluate(`window.dj.mixer.set({ cueMode: 'split' })`);
  await evaluate(`(() => { const m = window.dj.mixer.get(); const channels = m.channels.slice(); channels[0] = { ...channels[0], cue: true }; window.dj.mixer.set({ channels }); })()`);
  await sleep(300);
  let splitPeak = 0;
  for (let i = 0; i < 10; i++) {
    splitPeak = Math.max(splitPeak, await evaluate('window.dj.engine.meter(window.dj.engine.masterAnalyser).peak'));
    await sleep(50);
  }
  const quadOption = await evaluate(`document.querySelector('.cue-mode option[value="quad"]').disabled === !window.dj.engine.supportsQuad`);
  await evaluate(`window.dj.mixer.set({ cueMode: 'off' })`);
  check('split cue routing keeps master audible', splitPeak > 0.05, `peak ${splitPeak.toFixed(3)}`);
  check('4-channel cue offered only when the device has 4 outputs', quadOption);

  // Touching a fader must not kill the shortcuts, and a double-click reset must move the thumb.
  const faderRect = await evaluate(`(() => { const f = document.querySelector('.deck-b .tempo-fader'); f.scrollIntoView({ block: 'center' }); const r = f.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...faderRect, button: 'left', clickCount: 1 });
  const playingBefore = await evaluate(`${deckExpr(1)}.state.playing`);
  await key('KeyP', 'p');
  check('shortcuts still work after touching a fader', (await evaluate(`${deckExpr(1)}.state.playing`)) === !playingBefore);
  for (const count of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...faderRect, button: 'left', clickCount: count });
  }
  await sleep(100);
  const reset = await evaluate(`({ tempo: ${deckExpr(1)}.state.tempo, thumb: document.querySelector('.deck-b .tempo-fader').value })`);
  check('double-click resets tempo and moves the thumb', reset.tempo === 0 && Number(reset.thumb) === 0.5, `tempo ${reset.tempo}, thumb ${reset.thumb}`);

  // Half/double-time correction.
  const bpmB = await evaluate(`${deckExpr(1)}.state.bpm`);
  await click('.deck-b .bpm-tools', '/2');
  const halved = await evaluate(`${deckExpr(1)}.state.bpm`);
  await click('.deck-b .bpm-tools', 'x2');
  check('BPM /2 and x2 buttons', halved === bpmB / 2 && (await evaluate(`${deckExpr(1)}.state.bpm`)) === bpmB, `${bpmB} -> ${halved} -> back`);

  // Shortcuts are blocked while the help dialog is open.
  const aPlaying = await evaluate(`${deckExpr(0)}.state.playing`);
  await key('Slash', '?', 8);
  await key('KeyQ', 'q');
  const blocked = await evaluate(`({ open: document.querySelector('dialog.help').open, playing: ${deckExpr(0)}.state.playing })`);
  await evaluate(`document.querySelector('dialog.help').close()`);
  check('help dialog blocks deck shortcuts', blocked.open && blocked.playing === aPlaying);

  // Track-end warning near the end of a playing track.
  await evaluate(`(() => { const d = ${deckExpr(0)}; if (!d.state.playing) d.play(); d.seek(d.duration - 20); })()`);
  await sleep(400);
  check('track-end warning shows with 20 s left', await evaluate(`document.querySelector('.deck-a').classList.contains('ending')`));

  // CUE on a stopped deck previews while held and returns on release.
  await evaluate(`${deckExpr(0)}.pause()`);
  await sleep(100);
  await pointer('.deck-a .transport', 'CUE', 'mousePressed');
  await sleep(600);
  const holding = await evaluate(`({ playing: ${deckExpr(0)}.state.playing, cue: ${deckExpr(0)}.state.cuePoint })`);
  await pointer('.deck-a .transport', 'CUE', 'mouseReleased');
  await sleep(200);
  const afterCue = await evaluate(`({ playing: ${deckExpr(0)}.state.playing, pos: ${deckExpr(0)}.renderPosition() })`);
  check('CUE held on a stopped deck previews, release returns to the cue', holding.playing && !afterCue.playing && Math.abs(afterCue.pos - holding.cue) < 0.02, `held playing ${holding.playing}, released at ${afterCue.pos.toFixed(3)} vs cue ${holding.cue.toFixed(3)}`);

  // ---- library, decode and the IndexedDB cache (a real file, not a demo) ----
  // 20 s, 100 BPM click WAV with the first beat at 0.25 s, built in the page.
  const makeFile = `(() => {
    const rate = 44100, seconds = 20, n = rate * seconds, bpm = 100, offset = 0.25;
    const bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, t) => [...t].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); bytes.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true);
    bytes.setUint16(34, 16, true); text(36, 'data'); bytes.setUint32(40, n * 2, true);
    for (let b = 0; offset + b * 60 / bpm < seconds; b++) {
      const s0 = Math.round((offset + b * 60 / bpm) * rate);
      for (let i = 0; i < 600 && s0 + i < n; i++) {
        const v = Math.sin(2 * Math.PI * 1500 * i / rate) * Math.exp(-i / 90) * 0.8;
        bytes.setInt16(44 + (s0 + i) * 2, Math.round(v * 32767), true);
      }
    }
    return new File([bytes.buffer], 'Test Artist - Click Track.wav', { type: 'audio/wav', lastModified: 1700000000000 });
  })()`;
  const addAndLoad = async () => {
    await evaluate(`window.dj.library.addFiles([${makeFile}])`);
    await waitFor(`[...document.querySelectorAll('.library-table td.col-title')].some((td) => td.textContent === 'Click Track')`, 5000, 'file row');
    const rowRect = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Click Track');
      const b = row.querySelector('.btn-load-a');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...rowRect, button: 'left', clickCount: 1 });
  };

  await evaluate(`${deckExpr(0)}.pause()`);
  await addAndLoad();
  await waitFor(`${deckExpr(0)}.state.track?.title === 'Click Track' && ${deckExpr(0)}.state.analysis === null && ${deckExpr(0)}.state.status === 'ready'`, 20000, 'file loaded and analysed');
  // The row re-renders on the next animation frame; wait for it rather than racing it.
  const rowBpm = `[...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Click Track').children[2].textContent`;
  await waitFor(`${rowBpm} !== ''`, 3000, 'row BPM').catch(() => undefined);
  await sleep(700); // outlast a pending tag flush (300 ms interval), which must not clear the BPM
  const loaded = await evaluate(`({ artist: ${deckExpr(0)}.state.track.artist, bpm: ${deckExpr(0)}.state.bpm, firstBeat: ${deckExpr(0)}.state.firstBeat, row: [...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Click Track').children[2].textContent })`);
  check('file decodes, tags come from the file name', loaded.artist === 'Test Artist', loaded.artist);
  const clickErr = Math.min(Math.abs(loaded.firstBeat - 0.25) % 0.6, 0.6 - (Math.abs(loaded.firstBeat - 0.25) % 0.6));
  check('file analysed: 100 BPM, grid on the clicks', Math.abs(loaded.bpm - 100) <= 0.05 && clickErr <= 0.015, `${loaded.bpm} BPM, grid off by ${(clickErr * 1000).toFixed(1)} ms`);
  check('library row shows the analysed BPM', loaded.row === '100.0', loaded.row);

  await click('.deck-a .pads', '3');
  const savedCue = await evaluate(`${deckExpr(0)}.state.hotCues[2]`);
  await sleep(1500); // cue writes are debounced

  // Reload the whole app: analysis and the hot cue must come back from IndexedDB.
  await send('Page.navigate', { url: url.href });
  await waitFor('window.dj && window.dj.decks.every((d) => d.state.bpm !== null && d.state.peaks)', 30000, 'demos after reload');
  await addAndLoad();
  try {
    await waitFor(`${deckExpr(0)}.state.track?.title === 'Click Track' && ${deckExpr(0)}.state.status === 'ready'`, 20000, 'file reloaded');
  } catch (error) {
    console.log('  deck A:', JSON.stringify(await evaluate(`(() => { const s = ${deckExpr(0)}.state; return { status: s.status, text: s.statusText, notice: s.notice, title: s.track?.title, rows: window.dj.library.store.get().entries.map((e) => e.title) }; })()`)));
    throw error;
  }
  const restored = await evaluate(`({ bpm: ${deckExpr(0)}.state.bpm, analysis: ${deckExpr(0)}.state.analysis, cue: ${deckExpr(0)}.state.hotCues[2], status: ${deckExpr(0)}.state.statusText })`);
  check('reload restores analysis from the cache (no re-analysis)', restored.bpm === loaded.bpm && restored.analysis === null && restored.status === 'Ready', `${restored.status}, ${restored.bpm} BPM`);
  check('reload restores the hot cue', typeof savedCue === 'number' && Math.abs(restored.cue - savedCue) < 1e-9, `${savedCue} -> ${restored.cue}`);

  // A file the browser cannot decode fails visibly on the deck.
  await evaluate(`window.dj.library.addFiles([new File(['not audio'], 'Broken - Not Audio.mp3', { type: 'audio/mpeg' })])`);
  await sleep(300);
  await evaluate(`[...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Not Audio').querySelector('.btn-load-b').click()`);
  await waitFor(`${deckExpr(1)}.state.status === 'error'`, 10000, 'decode error');
  const errorText = await evaluate(`document.querySelector('.deck-b .deck-status').textContent`);
  check('undecodable file shows an error on the deck', /cannot decode/.test(errorText), errorText);

  // ---- undo last load and the on-air lock ----
  const rowButton = async (title, deck) => {
    const rect = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === ${JSON.stringify(title)});
      const b = row.querySelector('.btn-load-${deck}');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 });
  };
  await evaluate(`${deckExpr(0)}.seek(5)`);
  await sleep(150);
  await rowButton('Demo House 124', 'a');
  await waitFor(`${deckExpr(0)}.state.track?.title === 'Demo House 124' && ${deckExpr(0)}.state.status === 'ready'`, 15000, 'demo loaded over the click track');
  await key('KeyZ', 'z', 2);
  await waitFor(`${deckExpr(0)}.state.track?.title === 'Click Track' && ${deckExpr(0)}.state.status === 'ready'`, 15000, 'undo restored the previous track');
  await sleep(200);
  const undone = await evaluate(`({ pos: ${deckExpr(0)}.renderPosition(), notice: document.querySelector('.deck-a .deck-status').textContent })`);
  check('Ctrl+Z undoes a load, back at the old position', Math.abs(undone.pos - 5) < 0.1 && /Restored/.test(undone.notice), `${undone.pos.toFixed(2)} s, "${undone.notice}"`);

  await evaluate(`${deckExpr(0)}.play()`);
  await key('KeyT', 't');
  await key('KeyQ', 'q');
  await rowButton('Demo House 128', 'a');
  await sleep(300);
  const locked = await evaluate(`({ locked: ${deckExpr(0)}.state.locked, playing: ${deckExpr(0)}.state.playing, title: ${deckExpr(0)}.state.track.title, notice: document.querySelector('.deck-a .deck-status').textContent, badge: getComputedStyle(document.querySelector('.deck-a'), '::after').content })`);
  check('lock blocks pause and loads on a playing deck, and says so', locked.locked && locked.playing && locked.title === 'Click Track' && /locked/.test(locked.notice), `"${locked.notice}"`);
  await key('KeyT', 't');
  await evaluate(`${deckExpr(0)}.pause()`);

  // ---- session restore after a reload ----
  await evaluate(`(async () => {
    const [a, b] = window.dj.decks;
    const entries = window.dj.library.store.get().entries;
    await window.dj.loader.loadEntry(a, entries.find((e) => e.id === 'demo:house-124'), 20);
    await window.dj.loader.loadEntry(b, entries.find((e) => e.id === 'demo:dnb-174'), 7.5);
    window.dj.mixer.set({ crossfader: 0.3 });
    await window.dj.session.save();
  })()`);
  const plain = new URL(base);
  plain.searchParams.set('debug', '1');
  await send('Page.navigate', { url: plain.href });
  await waitFor(`document.querySelector('.restore-banner')`, 15000, 'restore banner');
  const bannerText = await evaluate(`document.querySelector('.restore-banner').textContent`);
  check('reload offers the last session', /Demo House 124 at 0:20/.test(bannerText) && /Demo Drum and Bass 174 at 0:07/.test(bannerText), bannerText.slice(0, 120));
  const hintsShown = await evaluate(`document.querySelector('.hints') !== null && document.querySelectorAll('.hint-step').length === 3`);
  await click('.restore-banner', 'Restore');
  await waitFor(`window.dj.decks.every((d) => d.state.status === 'ready' && d.state.bpm !== null)`, 30000, 'session restored');
  await sleep(300);
  const restored2 = await evaluate(`({ a: window.dj.decks[0].state.track.title, b: window.dj.decks[1].state.track.title, pa: window.dj.decks[0].renderPosition(), pb: window.dj.decks[1].renderPosition(), x: window.dj.mixer.get().crossfader, banner: document.querySelector('.restore-banner').textContent })`);
  await sleep(700);
  const hintTwo = await evaluate(`document.querySelector('.hint-step[data-step="2"]')?.classList.contains('done') ?? false`);
  check('first-run guide shows three steps and ticks "load a deck" once loaded', hintsShown && hintTwo, `shown ${hintsShown}, step 2 done ${hintTwo}`);
  check('Restore puts back both tracks, positions and the mixer', restored2.a === 'Demo House 124' && restored2.b === 'Demo Drum and Bass 174' && Math.abs(restored2.pa - 20) < 0.1 && Math.abs(restored2.pb - 7.5) < 0.1 && Math.abs(restored2.x - 0.3) < 1e-9 && /Session restored/.test(restored2.banner), `A ${restored2.pa.toFixed(2)} s, B ${restored2.pb.toFixed(2)} s, xfader ${restored2.x}`);

  // ---- background analysis of tracks never loaded on a deck ----
  const wavExpr = (bpm, name, stamp) => `(() => {
    const rate = 22050, seconds = 25, n = rate * seconds, offset = 0.2;
    const bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, t) => [...t].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); bytes.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true);
    bytes.setUint16(34, 16, true); text(36, 'data'); bytes.setUint32(40, n * 2, true);
    for (let b = 0; offset + b * 60 / ${bpm} < seconds; b++) {
      const s0 = Math.round((offset + b * 60 / ${bpm}) * rate);
      for (let i = 0; i < 300 && s0 + i < n; i++) bytes.setInt16(44 + (s0 + i) * 2, Math.round(Math.sin(2 * Math.PI * 1500 * i / rate) * Math.exp(-i / 45) * 0.8 * 32767), true);
    }
    return new File([bytes.buffer], ${JSON.stringify(name)}, { type: 'audio/wav', lastModified: ${stamp} });
  })()`;
  await evaluate(`window.dj.library.addFiles([${wavExpr(100, 'Bg - Slow 100.wav', 1700000000100)}, ${wavExpr(132, 'Bg - Mid 132.wav', 1700000000132)}, ${wavExpr(90, 'Bg - Hiphop 90.wav', 1700000000090)}])`);
  await waitFor(`[...document.querySelectorAll('.library-table td.col-title')].filter((td) => /^(Slow 100|Mid 132|Hiphop 90)$/.test(td.textContent)).length === 3`, 5000, 'three new rows');
  await click('.library-toolbar', 'Analyse library');
  await waitFor(`/analysed/.test(document.querySelector('.analyse-status').textContent) && !window.dj.background.store.get().running`, 60000, 'background analysis to finish');
  // The table re-renders on the next animation frame after the last result:
  // wait for the rows rather than racing that frame.
  await waitFor(`[...document.querySelectorAll('.library-table tr')].filter((tr) => /^(Slow 100|Mid 132|Hiphop 90)$/.test(tr.querySelector('.col-title')?.textContent ?? '')).every((tr) => tr.children[2].textContent !== '')`, 3000, 'rows to show BPMs').catch(() => undefined);
  const bgRows = await evaluate(`Object.fromEntries([...document.querySelectorAll('.library-table tr')].filter((tr) => /^(Slow 100|Mid 132|Hiphop 90)$/.test(tr.querySelector('.col-title')?.textContent ?? '')).map((tr) => [tr.querySelector('.col-title').textContent, tr.children[2].textContent]))`);
  const bgStatus = await evaluate(`document.querySelector('.analyse-status').textContent`);
  check('Analyse library fills BPMs for tracks never loaded', bgRows['Slow 100'] === '100.0' && bgRows['Mid 132'] === '132.0' && bgRows['Hiphop 90'] === '90.0', `${JSON.stringify(bgRows)}; "${bgStatus}"`);
  await click('.library-toolbar', 'Analyse library');
  await waitFor(`/already analysed/.test(document.querySelector('.analyse-status').textContent)`, 5000, 'nothing-to-do message');
  check('a second run says there is nothing left to analyse', true, await evaluate(`document.querySelector('.analyse-status').textContent`));

  // ---- library workflow: search scope, Match filter, keyboard loading, history ----
  const visibleTitles = `[...document.querySelectorAll('.library-table tbody tr:not(.empty-row) .col-title')].map((td) => td.textContent)`;
  await evaluate(`(() => { const s = document.querySelector('.library-search'); s.value = '132'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  const byBpm = await evaluate(visibleTitles);
  await evaluate(`(() => { const s = document.querySelector('.library-search'); s.value = ''; s.dispatchEvent(new Event('input')); s.blur(); })()`);
  check('a number in the search matches BPM', byBpm.length === 1 && byBpm[0] === 'Mid 132', JSON.stringify(byBpm));

  await key('KeyG', 'g');
  await sleep(150);
  const matched = await evaluate(`({ titles: ${visibleTitles}, status: document.querySelector('.library-toolbar .library-status:last-child').textContent, delta: [...document.querySelectorAll('.library-table tbody tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Demo House 128')?.children[3].textContent })`);
  await key('KeyG', 'g');
  check('Match keeps tracks within 6% of the deck on air, with the tempo change', JSON.stringify([...matched.titles].sort()) === JSON.stringify(['Demo House 124', 'Demo House 128']) && matched.delta === '-3.1%', `${JSON.stringify(matched.titles)} "${matched.status}" delta ${matched.delta}`);

  // Suggest next: with Match on, the closest tempo (and compatible key) ranks first.
  await key('KeyG', 'g');
  await sleep(150);
  const suggested = await evaluate(visibleTitles);
  // Deck A plays Demo House 124: once audible for 30 s it counts as played and
  // rightly ranks last, so the expected order depends on the run's pace (this
  // failed 1 run in 10 on a slow run until it asked the history).
  const playedA = await evaluate(`[...window.dj.history.playedIds()].some((id) => window.dj.library.store.get().entries.find((e) => e.id === id)?.title === 'Demo House 124')`);
  const expectedOrder = playedA ? ['Demo House 128', 'Demo House 124'] : ['Demo House 124', 'Demo House 128'];
  await key('KeyG', 'g');
  check('Match ranks the best next track first', suggested[0] === expectedOrder[0] && suggested[1] === expectedOrder[1], `${JSON.stringify(suggested)} (deck A track played: ${playedA})`);

  // Crates: create, add (and refuse a duplicate), view, remove.
  const libStatus = `document.querySelector('.library-toolbar .library-status:last-child').textContent`;
  await evaluate(`(() => { const s = document.querySelector('.crate-select'); s.value = '__new'; s.dispatchEvent(new Event('change')); })()`);
  await evaluate(`(() => { const i = document.querySelector('.crate-name'); i.value = 'Friday'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(150);
  await evaluate(`document.querySelector('.crate-select').value = ''; document.querySelector('.crate-select').dispatchEvent(new Event('change'))`);
  await sleep(100);
  await evaluate(`[...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Mid 132').click()`);
  await evaluate(`(() => { const s = document.querySelector('.crate-select'); s.value = 'Friday'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(100);
  const emptyCrate = await evaluate(`document.querySelector('.library-table .empty-row')?.textContent ?? ''`);
  // Back to all tracks (Friday stays the add target), select a row, press V twice.
  await evaluate(`(() => { const s = document.querySelector('.crate-select'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await sleep(100);
  const addLabel = await evaluate(`[...document.querySelectorAll('.crate-toolbar button')].map((b) => b.textContent).join('|')`);
  await evaluate(`[...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Mid 132').click()`);
  await evaluate('document.activeElement && document.activeElement.blur()');
  await key('KeyV', 'v');
  await sleep(150);
  const added = await evaluate(libStatus);
  await key('KeyV', 'v');
  await sleep(150);
  const dup = await evaluate(libStatus);
  await evaluate(`(() => { const s = document.querySelector('.crate-select'); s.value = 'Friday'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  const inCrate = await evaluate(visibleTitles);
  await evaluate(`[...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Mid 132').click()`);
  await click('.crate-toolbar', 'Remove');
  await sleep(150);
  const afterRemove = await evaluate(libStatus);
  await evaluate(`(() => { const s = document.querySelector('.crate-select'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  check('crates: create, add with V from all tracks, refuse a duplicate, view, remove', /Friday is empty/.test(emptyCrate) && /\+ Friday/.test(addLabel) && /Added "Mid 132" to Friday/.test(added) && JSON.stringify(inCrate) === '["Mid 132"]' && /already in Friday/.test(dup) && /Removed "Mid 132" from Friday/.test(afterRemove), `"${added}", in crate ${JSON.stringify(inCrate)}, dup "${dup}", "${afterRemove}"`);

  await evaluate(`${deckExpr(1)}.pause()`);
  await key('Slash', '/');
  await evaluate(`(() => { const s = document.querySelector('.library-search'); s.value = 'Hiphop'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  await key('ArrowDown', 'ArrowDown');
  await evaluate('document.activeElement.blur()');
  await key('ArrowRight', 'ArrowRight', 8);
  await waitFor(`${deckExpr(1)}.state.track?.title === 'Hiphop 90' && ${deckExpr(1)}.state.status === 'ready'`, 15000, 'keyboard load onto B');
  check('keyboard: / searches, Down selects, Shift+Right loads onto B', true, 'Hiphop 90 on deck B');
  await evaluate(`(() => { const s = document.querySelector('.library-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);

  await evaluate(`window.dj.history.add({ at: Date.now(), deck: 'A', title: 'Demo House 124', artist: 'Built-in demo', bpm: 124, key: '8A', entryId: 'demo:house-124' })`);
  await sleep(200);
  const hist = await evaluate(`({ button: [...document.querySelectorAll('.library-toolbar button')].find((b) => b.textContent.startsWith('History')).textContent, played: [...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === 'Demo House 124')?.classList.contains('played') })`);
  await click('.library-toolbar', hist.button);
  await click('dialog.history', 'Export CSV');
  const exported = await evaluate(`document.querySelector('.history-note').textContent`);
  await evaluate(`document.querySelector('dialog.history').close()`);
  check('history counts plays, dims played rows and exports', /History \(\d+\)/.test(hist.button) && hist.played === true && /^Exported \d+ track/.test(exported), `${hist.button}, "${exported}"`);

  // ---- prelisten: headphones only, refused when no headphone output ----
  const listenButton = async (title) => {
    const rect = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.library-table tr')].find((tr) => tr.querySelector('.col-title')?.textContent === ${JSON.stringify(title)});
      const b = row.querySelector('.btn-listen');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 });
  };
  await evaluate(`window.dj.decks.forEach((d) => d.pause()); window.dj.mixer.set({ cueMode: 'off' })`);
  await listenButton('Demo House 128');
  await sleep(400);
  const refused = await evaluate(`document.querySelector('.listen-title').textContent`);
  await evaluate(`window.dj.mixer.set({ cueMode: 'split' })`);
  await sleep(200);
  await listenButton('Demo House 128');
  await waitFor(`window.dj.prelisten.store.get().position > 0`, 8000, 'prelisten to start');
  const p1 = await evaluate('window.dj.prelisten.store.get().position');
  await sleep(1000);
  const listen = await evaluate(`({ p2: window.dj.prelisten.store.get().position, title: window.dj.prelisten.store.get().title, bar: document.querySelector('.listen-bar').classList.contains('active') })`);
  const masterDuringListen = await evaluate(masterPeak);
  check('prelisten refuses without a headphone output, then plays on the cue bus only', /headphone cue mode/.test(refused) && listen.title === 'Demo House 128' && listen.bar && listen.p2 > p1 + 0.5 && masterDuringListen < 0.001, `refused "${refused.slice(0, 40)}", pos ${p1.toFixed(1)} -> ${listen.p2.toFixed(1)}, master ${masterDuringListen.toFixed(4)}`);
  await click('.listen-bar', 'Stop');
  await evaluate(`window.dj.mixer.set({ cueMix: 1 })`);
  await sleep(200);
  await evaluate(`window.dj.mixer.set({ cueMix: 0, cueMode: 'off' })`);
  check('prelisten stops and says so', (await evaluate(`document.querySelector('.listen-title').textContent`)) === 'Prelisten stopped');

  // ---- tap tempo and grid editing (deck B, paused) ----
  const tapStart = Date.now();
  for (let t = 0; t < 6; t++) {
    await click('.deck-b .grid-row', 'TAP');
    await sleep(Math.max(0, tapStart + (t + 1) * 500 - Date.now()));
  }
  const tapped = await evaluate(`${deckExpr(1)}.effectiveBpm`);
  const g0 = await evaluate(`${deckExpr(1)}.state.firstBeat`);
  await click('.deck-b .grid-row', 'GRID >');
  const g1 = await evaluate(`${deckExpr(1)}.state.firstBeat`);
  await evaluate(`${deckExpr(1)}.seek(10.123)`);
  await sleep(100);
  await click('.deck-b .grid-row', 'SET BEAT');
  const onBeat = await evaluate(`(() => { const d = ${deckExpr(1)}; const i = (d.position() - d.state.firstBeat) * d.state.bpm / 60; return Math.abs(i - Math.round(i)); })()`);
  const beatLen = 60 / (await evaluate(`${deckExpr(1)}.state.bpm`));
  const gridShift = (((g1 - g0) % beatLen) + beatLen) % beatLen;
  check('TAP sets the tempo, GRID nudges 5 ms, SET BEAT puts a beat at the playhead', Math.abs(tapped - 120) < 3 && Math.abs(gridShift - 0.005) < 1e-6 && onBeat < 1e-3, `tapped ${tapped.toFixed(1)} BPM, shift ${(gridShift * 1000).toFixed(2)} ms, off-beat ${onBeat.toFixed(4)}`);

  // ---- MIDI: 14-bit tempo, jog search, scratch, shifted pads (injected bytes) ----
  const midi = (bytes) => evaluate(`window.dj.midi.handleMessage(${JSON.stringify(bytes)})`);
  await evaluate(`${deckExpr(0)}.setTempoRange(0.08)`);
  await midi([0xb0, 0x00, 96]);
  await midi([0xb0, 0x20, 0]);
  const midiTempo = await evaluate(`${deckExpr(0)}.state.tempo`);
  const searchFrom = await evaluate(`${deckExpr(1)}.renderPosition()`);
  await midi([0xb1, 0x21, 74]);
  await sleep(100);
  const searched = (await evaluate(`${deckExpr(1)}.renderPosition()`)) - searchFrom;
  await evaluate(`${deckExpr(0)}.play()`);
  await sleep(300);
  await midi([0x90, 0x36, 127]);
  for (let t = 0; t < 8; t++) {
    await midi([0xb0, 0x22, 40]);
    await sleep(15);
  }
  const scratchRate = await evaluate(`${deckExpr(0)}.rate`);
  await midi([0x90, 0x36, 0]);
  const afterScratch = await evaluate(`${deckExpr(0)}.rate`);
  await midi([0x97, 0x00, 127]);
  await midi([0x97, 0x00, 0]);
  const padSet = await evaluate(`${deckExpr(0)}.state.hotCues[0]`);
  await midi([0x98, 0x00, 127]);
  const padCleared = await evaluate(`${deckExpr(0)}.state.hotCues[0]`);
  await evaluate(`${deckExpr(0)}.pause()`);
  check('MIDI: 14-bit tempo, jog search, scratch, shifted pad clear', Math.abs(midiTempo - 0.04) < 0.0002 && Math.abs(searched - 0.1) < 0.01 && scratchRate < -0.5 && Math.abs(afterScratch - (1 + midiTempo)) < 1e-9 && typeof padSet === 'number' && padCleared === null, `tempo ${(midiTempo * 100).toFixed(3)}%, search +${searched.toFixed(3)} s, scratch rate ${scratchRate.toFixed(2)} -> ${afterScratch.toFixed(3)}`);

  // Auto DJ: plays the tracks on screen with a synced crossfade.
  await evaluate(`window.dj.decks.forEach((d) => d.pause())`);
  await evaluate(`(() => { const s = document.querySelector('.library-search'); s.value = 'Bg'; s.dispatchEvent(new Event('input')); s.blur(); })()`);
  await sleep(200);
  await click('.library-toolbar', 'Auto DJ');
  await waitFor(`${deckExpr(0)}.state.playing && ${deckExpr(0)}.state.track?.title === 'Hiphop 90' && ${deckExpr(1)}.loaded && ${deckExpr(1)}.state.track?.title === 'Mid 132' && ${deckExpr(1)}.state.analysis === null`, 20000, 'Auto DJ to start A and preload B').catch(async (error) => {
    console.log('  autodj:', JSON.stringify(await evaluate(`({ status: document.querySelector('.autodj-status').textContent, a: [${deckExpr(0)}.state.track?.title, ${deckExpr(0)}.state.status, ${deckExpr(0)}.state.playing], b: [${deckExpr(1)}.state.track?.title, ${deckExpr(1)}.state.status, ${deckExpr(1)}.state.analysis], visible: ${visibleTitles} })`)));
    throw error;
  });
  // Fast-forward near the end of A so the transition starts now.
  await evaluate(`${deckExpr(0)}.seek(${deckExpr(0)}.duration - 7.5)`);
  await waitFor(`/mixing into/.test(document.querySelector('.autodj-status').textContent)`, 5000, 'transition to start');
  const mixing = await evaluate(`({ bPlaying: ${deckExpr(1)}.state.playing, bSynced: ${deckExpr(1)}.state.synced })`);
  await waitFor(`/now playing/.test(document.querySelector('.autodj-status').textContent)`, 12000, 'transition to finish');
  const handed = await evaluate(`({ a: ${deckExpr(0)}.state.playing, b: ${deckExpr(1)}.state.playing, x: window.dj.mixer.get().crossfader, status: document.querySelector('.autodj-status').textContent })`);
  await click('.library-toolbar', 'Stop Auto DJ');
  await evaluate(`window.dj.decks.forEach((d) => d.pause()); (() => { const s = document.querySelector('.library-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  check('Auto DJ syncs, crossfades into the next track and stops the old one', mixing.bPlaying && mixing.bSynced && !handed.a && handed.b && handed.x === 1 && /now playing "Mid 132"/.test(handed.status), `during: B playing ${mixing.bPlaying}, synced ${mixing.bSynced}; after: A ${handed.a}, B ${handed.b}, xfader ${handed.x}, "${handed.status}"`);

  // MIDI learn: map a new note to deck A's play, then use it.
  await click('.topbar-right', 'MIDI map');
  await evaluate(`document.querySelector('.learn-row[data-action="deck.A.play"] button').click()`);
  await midi([0x9f, 0x10, 127]);
  await midi([0x9f, 0x10, 0]);
  const learnedText = await evaluate(`document.querySelector('.learn-row[data-action="deck.A.play"] .learn-binding').textContent`);
  await evaluate(`document.querySelector('dialog.learn').close()`);
  const beforeLearned = await evaluate(`${deckExpr(0)}.state.playing`);
  await midi([0x9f, 0x10, 127]);
  const afterLearned = await evaluate(`${deckExpr(0)}.state.playing`);
  if (afterLearned === beforeLearned) {
    console.log('  learn:', JSON.stringify(await evaluate(`(() => { const d = ${deckExpr(0)}; const s = d.state; return { status: s.status, loaded: d.loaded, locked: s.locked, previewing: s.previewing, notice: s.notice, track: s.track?.title, midi: window.dj.midi.store.get().status, bound: window.dj.midi.currentBindings.filter((b) => b.action === 'deck.A.play') }; })()`)));
  }
  await evaluate(`${deckExpr(0)}.pause()`);
  check('MIDI learn maps a new control and it works', learnedText === 'ch16 note 0x10' && afterLearned === !beforeLearned, `"${learnedText}", playing ${beforeLearned} -> ${afterLearned}`);

  // ---- dialogue pads: drop a clip, fire it over the mix, talk-over, keys, restore ----
  await evaluate(`window.dj.decks.forEach((d) => d.pause())`);
  await evaluate(`(() => {
    const rate = 44100, n = Math.round(rate * 1.5);
    const bytes = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, t) => [...t].forEach((c, i) => bytes.setUint8(o + i, c.charCodeAt(0)));
    text(0, 'RIFF'); bytes.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
    bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 2, true); bytes.setUint16(32, 2, true);
    bytes.setUint16(34, 16, true); text(36, 'data'); bytes.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) bytes.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 0.5 * 32767), true);
    const file = new File([bytes.buffer], 'Punch Line.wav', { type: 'audio/wav' });
    const slot = document.querySelectorAll('.dialog-slot')[0];
    slot.scrollIntoView({ block: 'center' });
    const dt = new DataTransfer();
    dt.items.add(file);
    slot.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    slot.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(`window.dj.sampler.store.get().pads[0].title === 'Punch Line'`, 5000, 'clip on pad 1');
  const padTitle = await evaluate(`document.querySelectorAll('.dialog-pad')[0].querySelector('.dialog-title').textContent`);
  check('a clip dropped on a pad is assigned and shown', padTitle === 'Punch Line', `"${padTitle}", status "${await evaluate('window.dj.sampler.store.get().status')}"`);

  const padRect = await evaluate(`(() => { const r = document.querySelectorAll('.dialog-pad')[0].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: padRect.x, y: padRect.y, button: 'left', clickCount: 1 });
  await sleep(250);
  const firing = await evaluate(`(async () => {
    let peak = 0;
    for (let i = 0; i < 8; i++) { peak = Math.max(peak, window.dj.engine.meter(window.dj.engine.masterAnalyser).peak); await new Promise((r) => setTimeout(r, 40)); }
    return { playing: window.dj.sampler.store.get().pads[0].playing, lit: document.querySelectorAll('.dialog-pad')[0].classList.contains('playing'), peak, duck: window.dj.engine.duckGain };
  })()`);
  check('a pad click plays the clip over the master, lit, with the music ducked -10 dB', firing.playing && firing.lit && firing.peak > 0.1 && Math.abs(20 * Math.log10(firing.duck) + 10) < 1.5, JSON.stringify(firing));
  await waitFor(`!window.dj.sampler.store.get().pads[0].playing`, 4000, 'clip end');
  await sleep(900);
  const ended = await evaluate(`({ lit: document.querySelectorAll('.dialog-pad')[0].classList.contains('playing'), duck: window.dj.engine.duckGain })`);
  check('the clip ends by itself, the pad goes dark and the music comes back', !ended.lit && ended.duck > 0.9, JSON.stringify(ended));

  await key('Numpad1', '1');
  await sleep(150);
  const byKey = await evaluate('window.dj.sampler.store.get().pads[0].playing');
  await key('KeyB', 'b');
  await sleep(150);
  const stopped = await evaluate(`({ playing: window.dj.sampler.store.get().pads[0].playing, status: window.dj.sampler.store.get().status })`);
  check('Numpad 1 fires pad 1 and B stops every dialogue', byKey && !stopped.playing && stopped.status === 'Stopped 1 dialogue', `key ${byKey}, ${JSON.stringify(stopped)}`);
  await evaluate(`document.querySelectorAll('.dialog-pad')[7].click()`);
  check('an empty pad says so', (await evaluate('window.dj.sampler.store.get().status')) === 'Pad 8 is empty: drop a clip on it', await evaluate('window.dj.sampler.store.get().status'));

  // Push-to-talk with Chrome's fake microphone (a steady beep): hold is live and ducks, release mutes.
  await pointer('.sampler-panel', 'MIC', 'mousePressed');
  await waitFor(`window.dj.mic.live`, 5000, 'mic live').catch(() => undefined);
  await sleep(300);
  // The fake microphone beeps about once a second with silence between: listen
  // for 1.5 s, or the window can fall between beeps (failed 2 runs in 10 at 0.32 s).
  const talking = await evaluate(`(async () => {
    let peak = 0;
    for (let i = 0; i < 30; i++) { peak = Math.max(peak, window.dj.engine.meter(window.dj.engine.masterAnalyser).peak); await new Promise((r) => setTimeout(r, 50)); }
    const b = [...document.querySelectorAll('.sampler-panel button')].find((x) => x.classList.contains('sampler-mic'));
    return { live: window.dj.mic.live, label: b.textContent, peak, duck: window.dj.engine.duckGain, status: window.dj.mic.store.get().status };
  })()`);
  await pointer('.sampler-panel', 'ON AIR', 'mouseReleased');
  await sleep(900);
  const muted = await evaluate(`({ live: window.dj.mic.live, label: document.querySelector('.sampler-mic').textContent, duck: window.dj.engine.duckGain })`);
  check('holding MIC puts the mic on air over the master and ducks the music; release mutes', talking.live && talking.label === 'ON AIR' && talking.peak > 0.01 && talking.duck < 0.5 && !muted.live && muted.label === 'MIC' && muted.duck > 0.9, `${JSON.stringify(talking)} -> ${JSON.stringify(muted)}`);

  await send('Page.navigate', { url: url.href });
  await waitFor(`window.dj && window.dj.sampler && window.dj.sampler.store.get().pads[0].title === 'Punch Line'`, 15000, 'pads restored after reload').catch(() => undefined);
  const restoredPad = await evaluate(`window.dj?.sampler?.store.get().pads[0].title ?? null`);
  check('dialogue pads survive a reload', restoredPad === 'Punch Line', String(restoredPad));

  if (shot) {
    await evaluate('window.scrollTo(0, 0)');
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${shot}`);
  }
} catch (error) {
  check('driver', false, error.message);
}

for (const p of problems) console.log(`PAGE  ${p}`);
const failed = results.filter((r) => !r.ok).length + problems.length;
console.log(failed ? `\n${failed} problem(s)` : `\nAll ${results.length} checks passed`);
await closeBrowser();
process.exit(failed ? 1 : 0);
