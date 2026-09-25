# CLAUDE.md

Guidance for Claude Code / Cursor when working in **dj**.

## Standards

This repo follows the **`browser-frontend`** profile from the engineering-hub.
Canonical standards live at `D:\GitHub\engineering-hub`. Read the rules for this
profile before writing code:

- Core (always): `D:\GitHub\engineering-hub\rules\core\*.mdc`
- Profile overlay: see the profile's `rules` list in
  `D:\GitHub\engineering-hub\hub.json`

The Cursor-facing copies of these rules are synced into `.cursor\rules\` (see
`.hub-manifest.json`). Do not fork a rule locally: change it in the hub.

## Key conventions (summary)

- **Authorship header** on every new file: `Author: Pandiyaraj Karuppasamy` +
  `Date: <Mon-DD-YYYY>` in the module docstring.
- Reuse before writing; explicit names; no secrets; typed docstrings on public
  functions.
- Commit only when asked; branch from `main`; scoped diffs.

## Project specifics

Browser DJ mixer: TypeScript + Vite + Web Audio (AudioWorklet), vanilla DOM and
canvas UI, no framework. Plan: `scratchpad/plan-dj-web-mixer.md` (local only).

**Commands:** `npm run dev` | `npm test` (Vitest, pure DSP) | `npm run lint` |
`npm run build` | `npm run preview` then `npm run e2e` (headless Chrome over
CDP, drives the real app). A change is not done until `npm run e2e` passes
against a fresh `npm run build`; unit tests cannot see the audio thread or the page.

**URL flags:** `?demo=1` loads synthetic demo tracks onto both decks;
`?debug=1` exposes `window.dj` for the e2e driver.

**Layout:** `src/audio` (engine, worklet processor, deck controller, sync),
`src/analysis` (worker: peaks + BPM), `src/library` (folder scan, tags,
IndexedDB cache, track loader), `src/ui` (views), `src/input` (action
registry shared by UI, keyboard and MIDI).

**Gotchas learned the hard way:**
- The worklet is imported as `./worklets/deck-processor.ts?worker&url` and must
  not import anything; it is loaded standalone by `audioWorklet.addModule`.
- Sync seeks carry an `at` context time; the processor adds the playback that
  happened between `at` and the jump landing. Without it a follower is off by
  message latency (measured ~10 ms). A phase target before 0 must go one beat
  forward, never be clamped (clamping left decks up to half a beat out).
- The main-thread playhead is an estimate extrapolated from processor reports
  and applies loop wrapping itself: test loops against `deck.report`, not
  `position()`, or a broken worklet loop still passes.
- Background tag reads must never overwrite a known BPM/duration with null.
- Library rows are reused by entry identity; rebuilding them under the pointer
  swallows clicks.
- Meters clip a full-height gradient (`clip-path`), never `scaleY` it, or the
  red band shows at every level.
- BPM tests must include full-length tracks (4-10 min) and 4/4 above 140:
  45 s clips hid a fixed-step drift that read 128 as 85.33, and halving.
  Bump `ANALYSIS_VERSION` in `library/db.ts` whenever detection or peaks
  change, or cached tracks keep the old results.
- Analysis must stay streaming (`LowPass.next`): full-length filtered copies
  cost ~1 GB for a 10-minute track.
- Beat jump reads the position *before* moving the loop; loops are fitted
  inside the track (`fitLoop`) or the worklet never wraps them.
- Sliders sync from state unless dragged (`dragTracker`), never "unless
  focused": a double-click reset left the thumb behind. A focused slider owns
  only arrow keys, never the letter shortcuts.
- The compressor's `reduction` freezes when its input goes silent: gate the
  LIMIT light on signal.
- `npm run e2e` has 63 checks; soak it (10+ runs) after touching sync, the
  worklet or the library: several bugs here showed up 1 run in 5 to 1 in 12.
- Worklet code is unit-tested through `tests/worklet-harness.ts` (stubs the
  AudioWorkletGlobalScope). Loop points are fractional frames: floor any
  folded index before reading PCM, or the output turns to NaN.
- Anything a jump computes "for now" must be seeked with `at: now` (hot-cue
  jumps landed 1-3.4% of a beat late until they were).
- AudioParam automation does not advance while the context is suspended:
  test gain stages only after playback has started.
- The table re-renders on the next animation frame: e2e checks must wait for
  the DOM, not read it the moment a store changes.
- `CachedTrack.key` is the record identity; the musical key is `camelot`.
