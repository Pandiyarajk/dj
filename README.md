# dj

A two-deck DJ mixer that runs in the browser: beat-matched playback with key
lock, BPM, key and loudness analysis, sync, a 3-band isolator EQ with true
kills, filters and effects, hot cues, loops, a library with crates and
suggestions, Auto DJ, mix recording, headphone cue and MIDI controllers. No
install, no account, no upload: your music stays on your machine.

> **Disclaimer.** This software is provided **AS IS**, without warranty of any
> kind, express or implied. **Use it entirely at your own risk.** The authors
> accept no liability for any loss or damage arising from its use, including
> data loss or corruption, hardware damage, unbootable systems, business
> interruption, or any indirect or consequential damages. You are responsible
> for choosing the files and devices you use with it, for keeping tested
> backups of your music, and for being authorised to play the material you
> load. It is not certified for regulated, forensic, safety-critical or
> high-assurance use, or for professional broadcast or live-event duty.
> **Protect your hearing:** start with the master and headphone levels low,
> and keep them at a safe volume. The [LICENSE](LICENSE) (MIT) is the governing
> text and prevails wherever it and this summary differ.

![Two decks playing in sync, mixer in the middle, library below](docs/screenshot.png)

**Contents:** [Quick start](#quick-start) ·
[Adding your music](#adding-your-music) · [Using it](#using-it) ·
[Keyboard](#keyboard) · [MIDI controllers](#midi-controllers) ·
[Browser support](#browser-support) · [Troubleshooting](#troubleshooting) ·
[Privacy](#privacy) · [Known limitations](#known-limitations) ·
[Development](#development)

## Quick start

You need [Node.js](https://nodejs.org/) 20.19+ or 22.12+ and Chrome or Edge
(Firefox works with a few limits, see [Browser support](#browser-support)).

```bash
git clone https://github.com/Pandiyarajk/dj.git
cd dj
npm install
npm run dev
```

Open the address Vite prints (usually <http://localhost:5173>). Browsers keep
audio paused until you interact with the page, so click anywhere first. A
three-step guide at the top walks you through the first mix.

No music at hand? Open <http://localhost:5173/?demo=1> to load two built-in
demo tracks (124 and 128 BPM), or use the demo rows at the top of the library.

For the faster production build, run `npm run build` then `npm run preview`
and open <http://localhost:4173>. Chrome and Edge can then **install** it (the
install icon in the address bar); it launches from the desktop and works
offline.

## Adding your music

| Way | How | Browsers |
|---|---|---|
| **Open folder** | Library panel, *Open folder*, pick your music folder. Subfolders are included. *Reopen last folder* rescans it on your next visit | Chrome, Edge |
| **Add files** | Library panel, *Add files*, pick one or more tracks | All |
| **Drag and drop** | Drag a file from your file manager onto deck A or deck B | All |

A drop never replaces a track that is playing or locked, so the deck on air is
safe. Load a track from the library with **A** or **B** on its row, a
double-click (loads onto a free deck), or `/` to search, Up/Down to select and
Shift+Left / Shift+Right to load onto A / B.

Each track is analysed the first time it loads (a few seconds; about 4 s for
an 8-minute track). *Analyse library* does the whole library in the background,
so the BPM and Key columns are filled before a set.

### Supported formats

The app accepts **MP3, WAV, FLAC, OGG, Opus, M4A / AAC / MP4, WebM and
AIFF**. The browser does the decoding, so what actually plays depends on it:

| Format | Chrome, Edge | Firefox |
|---|---|---|
| MP3, WAV, FLAC, Ogg Vorbis, Opus | Yes | Yes |
| AAC / M4A | Yes | Yes |
| AIFF | Usually not | Usually not |
| ALAC (Apple Lossless in .m4a) | Usually not | No |
| DRM-protected files (old iTunes purchases, streaming-service downloads) | No | No |

WAV plays at 8, 16 or 24 bit and 32-bit float, mono or stereo, at any common
sample rate. A file the browser cannot decode shows an error on the deck
("the browser cannot decode this file"); converting it to FLAC or WAV fixes it.

## Using it

### Preparing tracks

Each track gets a waveform, a **BPM** and beat grid, a **musical key** (Camelot
notation, such as 8A) and a **loudness** reading. Results, cue points and hot
cues are cached in the browser, so a track loads instantly the second time.

- **Search** matches title, artist and album; a number searches BPM (`124`), a
  Camelot code searches key (`8A`).
- **Match** (or `G`) suggests the next track: only tracks within 6% of the
  deck on air (half and double time count), ranked by the tempo change needed,
  key compatibility and whether you have already played them. Compatible keys
  are highlighted.
- **Prelisten** (the headphone button on a row) plays a track in your
  headphones only, without touching the decks.
- **Crates** group tracks for a set: pick or create one, then add the selected
  track with *+ Crate* or `V`.
- **History** logs every track that was audible for 30 seconds; played rows are
  dimmed, and the tracklist exports as CSV.

### Decks

| Control | What it does |
|---|---|
| PLAY / CUE | CDJ style. CUE while playing returns to the cue point and stops. CUE while stopped sets the cue point there and plays while held; release to snap back, or press PLAY during the hold to keep playing. New tracks cue to their first beat. PLAY at the end of a track restarts from the cue point |
| Overview waveform | Click or drag to jump; with Q on, a playing deck keeps its beat phase |
| SYNC | Matches tempo and beat phase to the other deck and keeps following it (half and double time handled). Moving a synced deck's tempo fader moves both decks |
| KEYLOCK | Tempo changes keep the pitch, bass included. Without it, the KEY readout shows the pitch shift |
| Tempo fader | Top is slower, bottom is faster; double-click resets. Range: 8%, 16%, 50% |
| `-` / `+` | Hold to nudge the tempo while beat-matching by ear |
| Q | Quantize: cues and loops snap to the beat grid |
| LOCK | On-air lock: blocks loading, CUE and pause on a playing deck |
| Pads 1 to 8 | Hot cues in their own colours: an empty pad stores the position, a set pad jumps to it. On a stopped deck a set pad plays while held. Shift+click or right-click clears |
| 1, 2, 4, 8, 16 | Auto loop of that many beats |
| IN / OUT / LOOP, 1/2, x2 | Manual loops, reloop, halve and double |
| JUMP | Move by the loop size in beats; an active loop moves with you |
| TAP, GRID, SET BEAT | Fix a wrong reading: tap the tempo, nudge the grid 5 ms, or put a beat at the playhead. /2 and x2 correct half or double time |
| FX | Echo (tempo-synced), reverb or flanger, with beat division and amount. Switching it off lets the tail ring out |

Loops, hot-cue jumps and seeks crossfade over a few milliseconds, so they do
not click or drop out, with or without key lock.

**Undo:** `Ctrl+Z` puts back the track a load replaced, at its old position.
**Session restore:** after a reload or crash, a banner offers the decks and
mixer back. Closing the tab while a deck plays asks first.

### Mixer

Per channel: trim with **auto-gain** (every track levelled to about -14 LUFS,
shown under TRIM), a 3-band isolator EQ (-26 dB to +6 dB, crossovers at 250 Hz
and 2.5 kHz) whose KILL buttons remove the band completely, a FILTER knob (left
low-pass, right high-pass), headphone CUE, fader and meter. In the middle:
master level with a LIMIT light, AUTO GAIN switch, headphone level, CUE MIX
(cue to master blend in the headphones) and headphone routing, then the
crossfader and its curve.

The master and headphone buses each have a limiter followed by a hard ceiling
at -0.2 dBFS, so two loud tracks summed never clip the output. The LIMIT light
shows when the limiter is working.

**Headphone cue** needs a second output: *4-channel* on an interface or
controller with four outputs, or *Split* (cue left, master right) with a
splitter cable. Chrome and Edge can also send audio to another output device
(the Output menu).

The **phase meter** between the waveforms shows how far deck B's beat is from
deck A's ("In phase", or "B 12 ms ahead"). `+` and `-` zoom both waveforms. A
playing track with under 30 seconds left flashes red.

### Recording, Auto DJ and performance mode

- **REC** records the master output as a WAV file. In Chrome and Edge it
  streams straight to a file you choose, so long sets never fill memory.
- **Auto DJ** plays the tracks on screen (a crate, a search, the whole
  library) from the selected row, or from the top if nothing is selected in
  that view, with synced 16-beat crossfades.
- **PERFORM** is a compact layout for playing: prep controls are hidden and
  the library shrinks to a drawer. The screen stays awake while a deck plays.

## Keyboard

Press `?` in the app for the full list.

| Deck A | Deck B | Action |
|---|---|---|
| Q | P | Play / pause |
| W | O | Cue (hold to preview) |
| E | I | Sync |
| T | Y | Lock on air |
| R | U | Loop on / off |
| D / F | H / J | Halve / double loop |
| Z / X | N / M | Beat jump back / forward |
| A / S | K / L | Nudge slower / faster (hold) |
| 1 2 3 4 | 7 8 9 0 | Hot cues 1 to 4 (hold on a stopped deck; Shift clears) |

| Key | Action |
|---|---|
| Left / Right | Crossfader towards A / B |
| C | Centre the crossfader |
| `/` | Search the library |
| Up / Down | Select a track |
| Shift+Left / Shift+Right | Load the selected track onto A / B |
| G | Match (suggest next) on / off |
| V | Add the selected track to the crate |
| `=` / `-` | Zoom the waveforms |
| Ctrl+Z | Undo the last load |

Keys are matched by position, so the layout is the same on non-QWERTY
keyboards. Shortcuts keep working after you touch a fader, and pause while a
dialog is open.

## MIDI controllers

*Enable MIDI* connects any controller. The built-in mapping follows the common
Pioneer DDJ layout: transport, pads (and SHIFT+pads to clear), 14-bit tempo and
faders, jog wheels (touch the platter to scratch, turn the rim to nudge; on a
paused deck both search), and LED feedback. It has **not** been verified on real
hardware. *MIDI map* remaps anything by MIDI learn, and mappings can be exported
and imported as JSON. The top bar shows every message received.

## Browser support

| Browser | Status |
|---|---|
| Chrome, Edge | Everything, including folders, streaming recording, output choice and install |
| Firefox | Everything except folder access and output choice: use *Add files* or drag and drop; recordings download at the end |
| Safari | Should work (Web Audio, AudioWorklet); not tested |

## Troubleshooting

| Problem | What to do |
|---|---|
| No sound | Click anywhere on the page first: browsers keep audio paused until you interact. Check the channel fader, the crossfader position and the master level |
| A file will not load | The browser cannot decode it (see [Supported formats](#supported-formats)). Convert it to FLAC or WAV |
| *Open folder* is missing | Your browser has no folder access (Firefox, Safari). Use *Add files* or drag and drop |
| The BPM is half or double | Press /2 or x2 under the BPM. For a wrong tempo, TAP along; for a grid that is slightly off, GRID < / > or SET BEAT on a beat |
| The track has no BPM | It has no steady beat (ambient, spoken word), so none is shown rather than a wrong one. SYNC needs a BPM; TAP sets one |
| Headphone CUE does nothing | Choose *4-channel* (needs an interface with four outputs) or *Split* (cue left, master right) in the headphone routing |
| *Analyse library* says a track could not be read | The status line names the track and the reason. Usually the file is damaged or in a format the browser cannot decode |
| Key lock sounds phasey at big tempo changes | Expected beyond about 8%; see [Known limitations](#known-limitations) |
| MIDI controller does nothing | Press *Enable MIDI* and allow access. The top bar shows each message received; if messages arrive but nothing moves, map the control with *MIDI map* |

To start over, clear the site's data in the browser settings. This removes the
analysis cache, cue points, crates, history and MIDI mappings (not your music
files).

## Privacy

The app makes no network requests: no analytics, no fonts or scripts from a
CDN, no uploads. Music is read from your disk by the browser, and everything
the app remembers (analysis, cues, crates, history, settings) is stored in your
browser's own storage on this machine.

## Known limitations

- **BPM:** constant-tempo grids only. A live drummer who drifts in tempo reads
  close but not exact (a drifting 110 BPM track read 110.86), and a pattern
  genuinely ambiguous between two tempos can read as half or double: use /2,
  x2 or TAP.
- **Key:** 15 of 17 on the synthetic test corpus; not yet measured on real
  music. Most misses are harmonically compatible neighbours.
- **Key lock:** transients can smear a little beyond about +/-8%, and sub-bass
  can warble slightly. Kicks stay within 2 ms of the beat from -8% to +16%.
- **Pitching without key lock:** the Hermite resampler leaves faint
  high-frequency artefacts on very bright material.
- **Not built:** stem separation (the models are too large and slow for a
  browser today) and four decks. The MIDI mapping is unverified on real
  hardware, and Safari is untested.

## Development

```bash
npm test          # unit tests: analysis, key lock, loops, sync, mixer, MIDI...
npm run lint      # ESLint
npm run build     # typecheck + production build into dist/
npm run preview   # serve dist/ on http://localhost:4173
npm run e2e       # drive the built app in headless Chrome/Edge (run preview first)
```

`npm run e2e` clicks through the real app and checks what the audio does, not
just what the page shows (63 checks): audio reaches the master bus, beat grids
match, sync stays in phase through tempo changes, hot-cue jumps and key lock,
loops wrap in the audio thread, the kill removes the low band, echo tails ring
out, recordings decode, prelisten stays off the master, Auto DJ hands over, MIDI
bytes drive the decks, and reloads restore the cache and the session. It needs
Chrome or Edge installed (set `CHROME_PATH` if it is not found). Some bugs here
have shown up only 1 run in 5 to 1 in 12, so run it several times after
touching sync, the audio worklet or the library.

The deck worklet is unit-tested under Node through `tests/worklet-harness.ts`,
which runs the real processor: loop clicks, jump dropouts, key-lock pitch
(45 Hz to 440 Hz) and kick timing are all measured on its output.

**Test corpus.** `node scripts/make-corpus.mjs <dir>` writes 17 music-like WAV
files of known BPM, beat grid, key and loudness (several styles, sample rates,
bit depths, mono, float, an 8-minute track) plus `labels.json`, for checking
the analysers and the app against real decoding.

### How it works

- **Playback** runs in an AudioWorklet (`src/audio/worklets/deck-processor.ts`)
  that owns each track's PCM, a fractional read head and the rate, with
  Hermite interpolation. Loops and jumps are sample-accurate and crossfaded.
  **Key lock** is WSOLA in the same worklet: the head still moves at the tempo
  rate, and the output is rebuilt from grains read at normal speed around it,
  placed by a two-stage search (+/-12.5 ms coarse, wide enough for a 40 Hz
  bass period, then +/-3 samples fine).
- **Sync** (`src/audio/sync.ts`) matches tempo, then moves the follower to the
  leader's beat phase; seeks carry the audio-clock time they refer to, so late
  delivery does not shift the beat.
- **Analysis** (`src/analysis/`) runs in Web Workers in single streaming
  passes: band-split peaks, BPM (autocorrelation candidates, a tempo prior for
  the octave, and a whole-track comb), key (chroma against key profiles, with
  the bass tonic deciding between relative major and minor) and loudness
  (ITU-R BS.1770). Results are cached with a version number, so an improved
  detector re-analyses old entries.
- **Mixer** (`src/audio/mixer.ts`, `engine.ts`, `effects.ts`) is plain Web
  Audio: auto-gain and trim, a Linkwitz-Riley isolator EQ, resonant filters,
  effects after the fader, an equal-power crossfader, and a limiter plus
  ceiling on the master and headphone buses.

## License

MIT, see [LICENSE](LICENSE).
