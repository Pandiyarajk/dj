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
