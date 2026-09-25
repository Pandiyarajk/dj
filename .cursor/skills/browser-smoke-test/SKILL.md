---
name: browser-smoke-test
description: Load a page in a real headless Chrome/Edge and fail on any uncaught exception, console error, failed request or blank canvas — no npm install required. Use before declaring any browser-rendered change done, when a page renders blank/black in a browser but the server returns 200, or when the only verification so far is a Node/jsdom harness that stubs the DOM.
---

# browser-smoke-test

Prove a page actually **boots and paints in a browser**. A served 200, a green
Node harness, and a passing unit suite can all be true while every visitor sees
a blank screen.

## When to use

- Before declaring any change to browser-rendered code done.
- A page "works" in tests but users report blank/black/partial rendering.
- The only verification so far is a Node harness with a stubbed DOM/canvas.
- Adding a boot-order change (module `init()`, `DOMContentLoaded` wiring).

## Why this exists — the failure it was distilled from

A canvas game was verified with a headless **Node** harness: full game loops,
isolated combat duels, map generation across every preset/size/seed, plus four
real bugs found and fixed. It shipped, and it was a **black screen in every
browser**. The first real Chromium load found two crashes in under a minute:

```
UNCAUGHT  IndexSizeError: Failed to execute 'createImageData' on
          'CanvasRenderingContext2D': The source width is zero or not a number.
    at Object.bake (minimap.js:25)  at Object.init (minimap.js:18)
    at buildShell (ui.js:40)        at main.js:174
```

A Node harness proves the **simulation**. It cannot prove the **page**, because
the objects it stubs — `CanvasRenderingContext2D`, `document`, the boot event —
are exactly where these bugs live. See
[canvas-and-boot](../../rules/browser-frontend/canvas-and-boot.mdc) for the
class of bug this catches.

## Run it

No `npm install`. Uses Node's built-in `fetch` + `WebSocket` against an
already-installed Chrome or Edge, over the DevTools Protocol.

```bash
# serve the app first — file:// breaks modules, fetch and CORS
python -m http.server 8877      # or the project's own dev server

node D:/GitHub/engineering-hub/skills/browser-smoke-test/browser-smoke.mjs \
  "http://127.0.0.1:8877/index.html" --wait 6000 --expect-paint --shot out.png
```

Exit `0` = clean, `1` = problems found, `2` = could not run. Flags:

| Flag | Meaning |
|---|---|
| `--wait <ms>` | Settle time after navigate (default 5000) |
| `--click <sel>` | Click a selector, then wait again — repeatable, for menus/lobbies |
| `--ignore <substr>` | Drop matching problems (`favicon.ico` is ignored by default) |
| `--expect-paint` | Also assert the page actually drew something |
| `--shot <path>` | Save a PNG — **look at it**, it explains failures faster than the log |

Set `CHROME_PATH` if the browser isn't at a standard location.

## What it asserts

1. **No uncaught exceptions** — the one that matters most.
2. **No `console.error`, no error-level log entries, no failed requests.**
3. **`--expect-paint`: the page actually rendered.** Samples the canvas
   (or `body.innerText` when there is no canvas) and fails on a single flat
   colour, or on a canvas still at its `300x150` default — nothing sized it.

That third check earns its place: a page can boot with zero exceptions and
still paint nothing.

## Five things that will waste your time

Each of these cost a real debugging cycle while building this script.

**1. Attach before navigating.** Enabling `Runtime` on a tab that has already
loaded loses every boot-time throw — precisely the ones you are hunting. Create
a fresh target on `about:blank`, attach, enable the domains, *then* navigate.

**2. Park the virtual cursor — and do it late.** A headless page starts with
the mouse at `(0,0)`, which sits inside any edge-scroll or corner-hover band.
The app then "drifts" for the entire wait. Real measurement: an isometric
camera at `x=-936` after 2s and `x=-1828` after 6s, until the map was fully
off-screen and the paint check failed — with nothing wrong in the code.

The cursor-park must be dispatched **after** the page attaches its listeners.
Sent immediately after `Page.navigate` it lands before `DOMContentLoaded` and
is silently lost — the drift continues and the fix looks like it didn't work.

**3. A screenshot at a shorter `--wait` separates "never drew" from "drew, then
lost it".** Above, `--wait 1500` showed a fully rendered scene and `--wait 6000`
showed black. That comparison is what identified drift rather than a render bug.

**4. A control test can pass against markup the server never served.** The
Verify list below says to confirm the check fails on a known-broken build.
That step itself can lie. Injecting a deliberate defect into a template and
re-running produced a **clean pass**, because the server had the template
cached: Jinja does not re-read templates in production mode, so the broken
markup was never sent. The conclusion on offer was "my checker cannot detect
this", which was false.

Restart the server, then confirm the defect is in the **response body** before
believing either result:

```bash
curl -s http://127.0.0.1:5001/ | grep -c 'onclick='   # must be non-zero
```

Applies to any server that caches templates, bundles or static assets, and to
a browser profile reused between runs.

**5. Filter environment noise, or the signal is lost.** A `favicon.ico` 404 and
a WebSocket failure caused by serving with `python -m http.server` instead of
the project's own server are not defects. `--ignore` them, or the real error
gets skimmed past. Prefer running the project's actual server.

## Getting past a login form: the script cannot type

`--click` clicks; there is no `--type`. A page behind a **login form** is
therefore out of reach, and that is usually where the interesting code lives.
On one app the login page exercised almost none of the 191 handlers and 272
classes a change had touched.

Two ways out, in order of preference:

1. **A URL flag** that boots into the running state, as below. Cheapest when
   you own the app.
2. **Drive the DevTools Protocol directly** when you cannot add a flag,
   because the gate is a real auth boundary. Same launch and attach as this
   script, then `Runtime.evaluate` to fill the fields and click the real
   button, so the app's own wiring runs rather than a function you called
   yourself. Collect `Runtime.exceptionThrown`, `Runtime.consoleAPICalled`
   with `type === 'error'`, and `Log.entryAdded` at `level === 'error'`: a CSP
   violation arrives as the last of those, which is what makes the extra code
   worth writing. Screenshot each step.

   One driver walked 18 views that way, chat plus eleven admin tabs, a
   delegated click, four drag events and an accordion asserted actually open,
   and found two regressions no static check could see.

## Give the app a URL flag that boots straight into its running state

The hardest part of smoke-testing a client-rendered app is usually getting it
*past the front door* — a menu, lobby, or login gate. Scripted `--click`
chains are brittle.

Design the app so one query flag skips straight to the running state, with a
fixed seed for determinism:

```
index.html?autoplay=1&seed=12345
```

That single flag turned a fragile click-through into a one-line check, and it
costs about three lines in the config parser. Add it when you build the app,
not when you finally need to test it.

## Verify

- [ ] Ran against a **served URL**, not `file://`.
- [ ] Exit code checked — not just eyeballed output.
- [ ] `--expect-paint` used for anything canvas- or client-rendered.
- [ ] Screenshot opened and looked at.
- [ ] Restarted the server before trusting a control test, and confirmed the
      injected defect is in the **response body**.
- [ ] Confirmed the check **fails** on a known-broken build too. A smoke test
      never observed failing is not yet evidence of anything.
