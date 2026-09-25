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
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1280,1000', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
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
  // Below 100 Hz: a 24 dB/octave isolator crossing over at 250 Hz attenuates
  // less close to the crossover, so bins near it would understate the kill.
  const lowBefore = await evaluate(lowBandDb('window.dj.engine.strips[0].analyser', 100));
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, ...killRect, button: 'left', clickCount: 1 });
  check('low kill button toggles the low kill', kills === 3 && (await evaluate('window.dj.mixer.get().channels[0].kill.low')) === true);
  await sleep(200);
  const lowAfter = await evaluate(lowBandDb('window.dj.engine.strips[0].analyser', 100));
  check('low kill removes the low band (isolator)', lowBefore - lowAfter > 25, `${lowBefore.toFixed(1)} dB -> ${lowAfter.toFixed(1)} dB below 100 Hz`);
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
  await click('.restore-banner', 'Restore');
  await waitFor(`window.dj.decks.every((d) => d.state.status === 'ready' && d.state.bpm !== null)`, 30000, 'session restored');
  await sleep(300);
  const restored2 = await evaluate(`({ a: window.dj.decks[0].state.track.title, b: window.dj.decks[1].state.track.title, pa: window.dj.decks[0].renderPosition(), pb: window.dj.decks[1].renderPosition(), x: window.dj.mixer.get().crossfader, banner: document.querySelector('.restore-banner').textContent })`);
  check('Restore puts back both tracks, positions and the mixer', restored2.a === 'Demo House 124' && restored2.b === 'Demo Drum and Bass 174' && Math.abs(restored2.pa - 20) < 0.1 && Math.abs(restored2.pb - 7.5) < 0.1 && Math.abs(restored2.x - 0.3) < 1e-9 && /Session restored/.test(restored2.banner), `A ${restored2.pa.toFixed(2)} s, B ${restored2.pb.toFixed(2)} s, xfader ${restored2.x}`);

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
process.exit(failed ? 1 : 0);
