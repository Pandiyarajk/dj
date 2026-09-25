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

## Quick start

```bash
npm install
npm run dev
```

Open the address Vite prints (usually <http://localhost:5173>). Browsers keep
audio paused until you interact with the page, so click anywhere first. A
three-step guide at the top walks you through the first mix.

No music at hand? Open `http://localhost:5173/?demo=1` to load two built-in
demo tracks (124 and 128 BPM), or use the demo rows at the top of the library.

Chrome and Edge can **install** it (the install icon in the address bar); it
then launches from the desktop and works offline.

## Using it

### Loading and preparing tracks

*Open folder* scans a music folder (Chrome and Edge); *Add files* picks
individual files (every browser). Load a track with **A** or **B** on its row,
a double-click, a drag onto a deck, or by dropping a file on a deck.

Each track is analysed once: waveform, **BPM** and beat grid, **musical key**
(Camelot notation, such as 8A) and **loudness**. *Analyse library* does the whole
library in the background, so the BPM and Key columns are filled before a set.
Results, cue points and hot cues are cached in the browser.

- **Search** matches title, artist and album; a number searches BPM (`124`), a
  Camelot code searches key (`8A`).
- **Match** (or `G`) suggests the next track: only tracks within 6% of the
  deck on air (half and double time count), ranked by the tempo change needed,
  key compatibility and whether you have already played them. Compatible keys
  are highlighted.
- **Prelisten** (the headphone button on a row) plays a track in your
  headphones only, without touching the decks.
- **Crates** group tracks for a set: pick or create one, then add the selected
  track with *+ crate* or `V`.
- **History** logs every track that was audible for 30 seconds; played rows are
  dimmed, and the tracklist exports as CSV.

### Decks

| Control | What it does |
|---|---|
| PLAY / CUE | CDJ style. CUE while playing returns to the cue point and stops. CUE while stopped sets the cue point there and plays while held; release to snap back, or press PLAY during the hold to keep playing. New tracks cue to their first beat |
| Overview waveform | Click or drag to jump; with Q on, a playing deck keeps its beat phase |
| SYNC | Matches tempo and beat phase to the other deck and keeps following it (half and double time handled). Moving a synced deck's tempo fader moves both decks |
| KEYLOCK | Tempo changes keep the pitch. Without it, the KEY readout shows the pitch shift |
| Tempo fader | Top is slower, bottom is faster; double-click resets. Range: 8%, 16%, 50% |
| `-` / `+` | Hold to nudge the tempo while beat-matching by ear |
| Q | Quantize: cues and loops snap to the beat grid |
| LOCK | On-air lock: blocks loading, CUE and pause on a playing deck |
| Pads 1 to 8 | Hot cues in their own colours: an empty pad stores the position, a set pad jumps to it. On a stopped deck a set pad plays while held. Shift+click or right-click clears |
| 1, 2, 4, 8, 16 | Auto loop of that many beats (loops crossfade at the wrap, so they do not click) |
| IN / OUT / LOOP, 1/2, x2 | Manual loops, reloop, halve and double |
| JUMP | Move by the loop size in beats; an active loop moves with you |
| TAP, GRID, SET BEAT | Fix a wrong reading: tap the tempo, nudge the grid 5 ms, or put a beat at the playhead. /2 and x2 correct half or double time |
| FX | Echo (tempo-synced), reverb or flanger, with beat division and amount. Switching it off lets the tail ring out |

**Undo:** `Ctrl+Z` puts back the track a load replaced, at its old position.
**Session restore:** after a reload or crash, a banner offers the decks and
mixer back. Closing the tab while a deck plays asks first.

### Mixer

Per channel: trim with **auto-gain** (every track levelled to the same loudness,
shown under TRIM), a 3-band isolator EQ (-26 dB to +6 dB, crossovers at 250 Hz
and 2.5 kHz) whose KILL buttons remove the band completely, a FILTER knob (left
low-pass, right high-pass), headphone CUE, fader and meter. In the middle:
master level with a LIMIT light, AUTO GAIN switch, headphone level, CUE MIX
(cue to master blend in the headphones) and headphone routing, then the
crossfader and its curve.

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
  library) from the selected row, with synced 16-beat crossfades.
- **PERFORM** is a compact layout for playing: prep controls are hidden and
  the library shrinks to a drawer. The screen stays awake while a deck plays.

### Keyboard

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

### MIDI controllers

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

Which audio formats load depends on the browser's decoders: MP3, WAV, AAC/M4A,
FLAC and Ogg/Opus work in current Chrome and Edge.

## Development

```bash
npm test          # unit tests (BPM, key, loudness, key lock, sync, MIDI...)
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
Chrome or Edge installed (set `CHROME_PATH` if it is not found).

### How it works

- **Playback** runs in an AudioWorklet (`src/audio/worklets/deck-processor.ts`)
  that owns each track's PCM, a fractional read head and the rate, with
  Hermite interpolation; loops and jumps are sample-accurate and de-clicked.
  **Key lock** is WSOLA in the same worklet: the head still moves at the tempo
  rate, and the output is rebuilt from grains read at normal speed around it.
- **Sync** (`src/audio/sync.ts`) matches tempo, then moves the follower to the
  leader's beat phase; seeks carry the audio-clock time they refer to, so late
  delivery does not shift the beat.
- **Analysis** (`src/analysis/`) runs in Web Workers in single streaming
  passes: band-split peaks, BPM (autocorrelation candidates, an octave check,
  and a whole-track comb with a length-scaled step), key (chroma and key
  profiles) and loudness (ITU-R BS.1770). Results are cached with a version
  number, so an improved detector re-analyses old entries.
- **Mixer** (`src/audio/mixer.ts`, `engine.ts`, `effects.ts`) is plain Web
  Audio: auto-gain and trim, a Linkwitz-Riley isolator EQ, resonant filters,
  effects after the fader, an equal-power crossfader, and limiters on the
  master and headphone buses.

## Not yet

Stem separation (the models are too large and slow for a browser today),
four decks, and verification of the MIDI mapping on real hardware. The BPM
detector can still misread a track whose pattern is genuinely ambiguous between
two tempos (85 BPM house with off-beat hats reads as 170): use /2 and x2, or TAP.
Key detection is expected to be right about two times in three on real music
(the published figure for this method, not yet measured here); most misses are
harmonically compatible neighbours.

## License

MIT, see [LICENSE](LICENSE).
