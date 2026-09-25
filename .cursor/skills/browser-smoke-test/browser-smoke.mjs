/*
 * browser-smoke.mjs — load a URL in real headless Chrome/Edge over the DevTools
 * Protocol and fail on any uncaught exception, console error or failed request.
 * No npm install: uses Node's built-in fetch + WebSocket against an
 * already-installed browser.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Aug-14-2026
 *
 *   node browser-smoke.mjs <url> [--wait 5000] [--click <sel>]... [--ignore <substr>]...
 *                                [--expect-paint] [--shot out.png]
 *
 * Exit 0 = clean, 1 = problems found, 2 = could not run.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--'));
const opts = { wait: 5000, clicks: [], ignore: ['favicon.ico'], expectPaint: false, shot: null };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--wait') opts.wait = Number(argv[++i]);
  else if (argv[i] === '--click') opts.clicks.push(argv[++i]);
  else if (argv[i] === '--ignore') opts.ignore.push(argv[++i]);
  else if (argv[i] === '--expect-paint') opts.expectPaint = true;
  else if (argv[i] === '--shot') opts.shot = argv[++i];
}
if (!url) { console.error('usage: node browser-smoke.mjs <url> [--wait ms] [--click sel] [--ignore substr] [--expect-paint] [--shot png]'); process.exit(2); }

/* ---------- find a browser ---------- */
const bin = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!bin) { console.error('No Chrome/Edge found — set CHROME_PATH to a browser binary.'); process.exit(2); }

const port = 9222 + (process.pid % 500);
const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
const proc = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,800', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() { try { proc.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} }
process.on('exit', cleanup);

async function debuggerUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error('browser never opened its remote-debugging port');
}

const ws = new WebSocket(await debuggerUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0, sessionId = null;
const pending = new Map();
const problems = [];
const keep = (s) => !opts.ignore.some((ig) => s.includes(ig));

function send(method, params = {}, sess = sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sess ? { sessionId: sess } : {}) }));
  return new Promise((res) => pending.set(id, res));
}

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  let line = null;
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    line = `UNCAUGHT  ${d.exception?.description || d.text}`;
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    line = 'CONSOLE   ' + m.params.args.map((a) => a.description ?? a.value ?? a.type).join(' ');
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    line = `LOG       ${m.params.entry.text} @ ${m.params.entry.url || '?'}`;
  } else if (m.method === 'Network.loadingFailed') {
    line = `NETFAIL   ${m.params.type} ${m.params.errorText} ${m.params.request?.url || ''}`;
  }
  if (line && keep(line)) problems.push(line);
};

/* Attach to a fresh target BEFORE it navigates, so boot-time throws are caught.
   Navigating an existing tab and enabling Runtime afterwards loses them. */
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, null);
({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, null));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });

/* Park the virtual cursor in the middle of the viewport. A headless page starts
   with the mouse at (0,0), which sits inside any edge-scroll / corner-hover band —
   leave it there and the app "drifts" for the whole wait, then fails a paint check
   for reasons that have nothing to do with the code under test.
   This has to happen AFTER the page has attached its listeners: dispatched
   immediately after Page.navigate it lands before DOMContentLoaded and is lost. */
await sleep(Math.min(1500, opts.wait));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400, buttons: 0 });
await sleep(Math.max(0, opts.wait - 1500));

for (const sel of opts.clicks) {
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'clicked'; })()`,
  });
  if (r.result?.value === 'missing') problems.push(`CLICK     no element matched ${sel}`);
  await sleep(opts.wait);
}

if (opts.shot) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(opts.shot, Buffer.from(data, 'base64'));
}

/* A page that boots cleanly and paints nothing is still broken. Sample the
   canvas (or the DOM, if there isn't one) rather than trusting "no errors". */
const { result } = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return { kind: 'dom', chars: document.body.innerText.trim().length };
    let d; try { d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; }
    catch (e) { return { kind: 'canvas', w: cv.width, h: cv.height, readback: e.message }; }
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
    return { kind: 'canvas', w: cv.width, h: cv.height, colors: seen.size };
  })()`,
});
const paint = result.value || {};
console.log('paint: ' + JSON.stringify(paint));

if (opts.expectPaint) {
  if (paint.kind === 'canvas' && paint.colors <= 1)
    problems.push(`BLANK     canvas ${paint.w}x${paint.h} is one flat colour — booted but drew nothing`);
  if (paint.kind === 'canvas' && paint.w === 300 && paint.h === 150)
    problems.push('UNSIZED   canvas is still at its 300x150 default — nothing ever sized it');
  if (paint.kind === 'dom' && paint.chars === 0)
    problems.push('BLANK     no canvas and no rendered text');
}

ws.close();
if (problems.length) {
  console.error(`\nFAIL — ${problems.length} problem(s) on ${url}:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`\nPASS — no errors on ${url}`);
process.exit(0);
