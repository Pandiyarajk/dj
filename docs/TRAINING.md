# dj training course

Author: Pandiyaraj Karuppasamy
Date: Sep-26-2026

A hands-on course for the dj browser mixer, from the first sound to a recorded
mix. Each lesson has a goal, steps to follow in the app, a "check yourself"
list (what you should see when it worked) and the mistakes people usually make.
Work through the lessons in order; each one takes 10 to 20 minutes.

You do not need any DJ experience. You do need a computer with Chrome or Edge,
and ideally headphones. No music of your own? The built-in demo tracks are
enough for every lesson except Lesson 2.

> **Protect your hearing.** Start every session with the master level and the
> headphone level low, and raise them slowly. The software is provided as is,
> with no warranty; see the disclaimer at the top of the [README](../README.md)
> and the [LICENSE](../LICENSE).

## Contents

1. [First sound](#lesson-1-first-sound)
2. [Your music](#lesson-2-your-music)
3. [Reading a deck](#lesson-3-reading-a-deck)
4. [Beatmatching with SYNC](#lesson-4-beatmatching-with-sync)
5. [Beatmatching by ear](#lesson-5-beatmatching-by-ear)
6. [The mixer: EQ, filter, crossfader](#lesson-6-the-mixer-eq-filter-crossfader)
7. [Headphones and cueing](#lesson-7-headphones-and-cueing)
8. [Cue points, hot cues and loops](#lesson-8-cue-points-hot-cues-and-loops)
9. [Harmonic mixing and choosing the next track](#lesson-9-harmonic-mixing-and-choosing-the-next-track)
10. [Effects and key lock](#lesson-10-effects-and-key-lock)
11. [Dialogue pads and the mic](#lesson-11-dialogue-pads-and-the-mic)
12. [Performing: record, lock, PERFORM mode, Auto DJ](#lesson-12-performing-record-lock-perform-mode-auto-dj)
13. [Keyboard and MIDI controllers](#lesson-13-keyboard-and-midi-controllers)
14. [When the analysis is wrong](#lesson-14-when-the-analysis-is-wrong)
- [Final exercise: a 10-minute mix](#final-exercise-a-10-minute-mix)
- [Before a gig: checklist](#before-a-gig-checklist)
- [Glossary](#glossary)

---

## Lesson 1: First sound

**Goal:** start the app, hear a track, and learn the transport buttons.

1. Start the app (see [Quick start](../README.md#quick-start)) and open it
   with `?demo=1` at the end of the address, for example
   `http://localhost:5173/?demo=1`. Two demo tracks load onto deck A and B.
2. Click anywhere on the page. Browsers keep audio paused until you interact;
   the pill at the top left changes from "Audio paused" to "Audio on".
3. Press **PLAY** on deck A. Press it again to pause.
4. Press **CUE** while the track plays: it jumps back to the cue point and
   stops.
5. With the deck stopped, hold **CUE**: the track plays while you hold it and
   snaps back when you let go. Hold CUE and press PLAY during the hold to keep
   playing.
6. Click anywhere on the small overview waveform under the track title to jump
   there.

**Check yourself**
- The big playhead waveform at the top scrolls while deck A plays.
- The time readouts count up (elapsed) and down (remaining).
- The channel meter for A moves in the mixer.

**Common mistakes**
- No sound: the crossfader (bottom of the mixer) is all the way to B, or the
  A channel fader is down. Move the crossfader to the centre (key `C`).
- Pressing CUE while playing and wondering why the music stopped: that is what
  CUE does while playing. Use PLAY to pause.

---

## Lesson 2: Your music

**Goal:** add your own tracks and know what the app does with them.

1. Open the app without `?demo=1`.
2. In the Library panel, click **Open folder** and choose your music folder
   (Chrome and Edge). Subfolders are included. In other browsers, use
   **Add files**.
3. Load a track: click **A** or **B** on its row, or double-click the row, or
   drag the row onto a deck. You can also drag a file from your file manager
   straight onto a deck.
4. Watch the deck's status line: "Analysing 40%", then "Ready".
5. Press **Analyse library** to analyse every track in the background, so the
   BPM and Key columns fill in before a set.
6. Next time, **Reopen last folder** rescans the same folder without picking it.

**Check yourself**
- The row shows a BPM and a key (such as 8A) after analysis.
- Loading the same track again is instant: the analysis is saved in the
  browser.

**Formats:** MP3, WAV, FLAC, Ogg, Opus and AAC/M4A play in Chrome and Edge.
AIFF and Apple Lossless usually do not; DRM-protected files never do. A file
that will not decode shows an error on the deck; convert it to FLAC or WAV.

**Common mistakes**
- Loading onto a deck that is playing: the app refuses if the deck is locked
  (Lesson 12). Load onto the other deck.
- Expecting the files to be uploaded somewhere: they are not. Everything stays
  on your computer (see [Privacy](../README.md#privacy)).

---

## Lesson 3: Reading a deck

**Goal:** know what every readout on a deck means.

Load a track and find each of these on the deck:

| Readout | Meaning |
|---|---|
| Track title and artist | From the file's tags, or its file name |
| **BPM** (large number) | Beats per minute at the current tempo. `/2` and `x2` fix a half or double reading |
| **KEY** | Musical key in Camelot notation (8A = A minor, 8B = C major). Shows `+0.7 st` when the tempo has shifted the pitch |
| Status line | "Ready", "Analysing...", or a note such as "tempo changes: the grid follows the main tempo" |
| Overview waveform | The whole track; colours show bass, mids and highs |
| Elapsed / remaining time | Remaining flashes red in the last 30 seconds |
| Tempo readout (such as `+0.00%`) | How far the tempo fader has moved |
| AUTO under TRIM (mixer) | How much auto-gain levelled this track (such as `AUTO -5.1 dB`) |

At the top of the screen, the two scrolling waveforms show beat markers. The
line between them is the **phase meter**: "In phase", "B 12 ms ahead", or
"Tempo differs by 3.23%".

**Check yourself:** load two tracks and read out both BPMs, both keys and what
the phase meter says.

---

## Lesson 4: Beatmatching with SYNC

**Goal:** make two tracks play at the same tempo with their beats lined up.

1. Load two tracks with a steady beat (the demo tracks are 124 and 128 BPM).
2. Play deck A. Move the crossfader towards A.
3. Press **SYNC** on deck B. Its tempo jumps to match A.
4. Press **PLAY** on deck B. It starts on the beat.
5. Move the crossfader slowly from A to B and listen: the kick drums land
   together.
6. Move deck A's tempo fader. Because B is synced, it follows.

**Check yourself**
- The phase meter says "In phase".
- Deck B's BPM readout equals deck A's (or half or double of it: a 70 BPM
  track syncs to 140 at half time).

**Common mistakes**
- SYNC does nothing: one of the tracks has no BPM ("no steady beat"). Use TAP
  (Lesson 14) or pick another track.
- Two tracks far apart in tempo (say 120 and 150): sync works, but the tempo
  change is large and audible. Prefer tracks within about 6% (Lesson 9).

---

## Lesson 5: Beatmatching by ear

**Goal:** match tempo and phase without SYNC, the classic DJ skill.

1. Load two tracks. Play deck A. Make sure SYNC is off on deck B.
2. Put your headphones on deck B (Lesson 7), or just listen to both.
3. Press PLAY on deck B on a kick drum of deck A.
4. **Tempo:** move deck B's tempo fader until the BPM readouts match. Top is
   slower, bottom is faster. Double-click the fader to reset it.
5. **Phase:** if the kicks flam (two hits close together), hold the `+` button
   (speed up briefly) or the `-` button (slow down briefly) under the tempo
   fader until they land together.
6. Watch the phase meter as feedback while you learn to hear it.

**Check yourself:** the phase meter reads "In phase" and stays there for 30
seconds without you touching anything.

**Practice drill:** do it five times in a row with SYNC off, each time from a
different starting point. Then do it with your eyes closed and check the meter
afterwards.

---

## Lesson 6: The mixer: EQ, filter, crossfader

**Goal:** blend two tracks smoothly.

Each channel has, from top to bottom: TRIM (with AUTO gain), HIGH, MID and LOW
EQ with **KILL** buttons, **FILTER**, the headphone **CUE** button, and the
channel fader with a meter. The centre has MASTER with the **LIMIT** light,
**AUTO GAIN**, the headphone controls, and the crossfader with its **Curve**.

1. **AUTO GAIN** (on by default) levels every track to the same loudness, so a
   quiet and a loud track sit together. Leave it on while learning.
2. **The bass swap:** with both tracks playing in sync, kill the LOW on the
   incoming deck. Bring it in with the fader or crossfader. At a phrase change,
   bring its LOW back and kill the LOW of the outgoing deck at the same time.
   Two bass lines at once sound muddy; this avoids it.
3. **FILTER:** turn left for a low-pass (muffled), right for a high-pass
   (thin). Centre is off. Sweep a track out with the filter as you fade it.
4. **Crossfader curve:** "Curve: smooth" for blends, "Curve: sharp" for quick
   cuts and scratching.
5. **LIMIT light:** lights when the master limiter is working. If it is on a
   lot, lower the channel faders or the MASTER. The output never clips, but a
   constantly limited mix sounds squashed.

**Check yourself:** blend from A to B over 16 beats with a bass swap, without
the LIMIT light staying on and without two bass lines at once.

**Common mistakes**
- Using EQ to make everything louder: the EQ goes up to +6 dB but is best used
  to cut. Cutting sounds cleaner.
- Forgetting a KILL is on after the blend: the track sounds thin. Check the
  KILL buttons after every transition.

---

## Lesson 7: Headphones and cueing

**Goal:** hear the next track in your headphones before the audience does.

Headphone cueing needs a second output.

1. **With a splitter cable** (one headphone, one speaker output): set the
   headphone routing to **Split (cue L / master R)**. Your headphones hear the
   cued channel in the left ear and the master in the right.
2. **With a DJ controller or interface with four outputs:** choose
   **4-channel (cue on 3/4)**. If it shows "(device has 2)", your device only
   has two outputs; use Split.
3. Press the **CUE** button (headphone icon) on channel B in the mixer. Deck B
   is now in your headphones.
4. **CUE MIX** blends cue and master in the headphones; **CUE VOL** is the
   headphone level.
5. **Prelisten** a track from the library without loading it: press the
   headphone button on its row. It plays in the headphones only.
6. In Chrome and Edge, the **Output** menu at the top sends all audio to
   another device.

**Check yourself:** with Split, deck B plays only in the left ear while deck A
plays to the audience.

---

## Lesson 8: Cue points, hot cues and loops

**Goal:** jump to the right moment and extend a section.

**Hot cues**
1. While a track plays, press an empty pad (1 to 8). It stores the position
   and lights in its own colour.
2. Press the lit pad to jump back to it. With **Q** (quantize) on, the jump
   keeps the beat.
3. On a stopped deck, a set pad plays while you hold it.
4. Shift+click or right-click a pad to clear it.

Hot cues are saved with the track, so they are there next time.

**Loops**
1. Press **4** in the loop row: the next 4 beats loop seamlessly.
2. **1/2** and **x2** halve or double the loop while it plays.
3. Press **LOOP** to turn it off (and again to re-loop).
4. **IN** and **OUT** set a manual loop at any two points.
5. **<< JUMP** and **JUMP >>** move by the loop size; an active loop moves with
   you.

**Check yourself:** set hot cues on the first beat of the intro, the drop and
the outro; loop 8 beats of the outro, halve it twice, then let it run out.

**Practice drill:** "extend the outro": loop the last 8 beats of deck A while
you blend in deck B, then release the loop at the end of the blend.

---

## Lesson 9: Harmonic mixing and choosing the next track

**Goal:** pick a next track that fits in tempo and key.

1. Play a track on deck A.
2. Press **Match** in the library (or key `G`). The list shows only tracks
   within 6% of deck A's tempo, ranked best first, with the tempo change each
   needs (such as `-3.1%`). Compatible keys are highlighted.
3. **Camelot rule of thumb:** the same number, one step round the wheel (8A to
   7A or 9A), or the letter swap (8A to 8B) mix well.
4. Search by BPM (`124`) or key (`8A`) in the search box (key `/`).
5. **Crates:** create a crate for a set, select tracks and press **+ Crate**
   (or `V`).
6. **History** logs every track that played for 30 seconds; played rows are
   dimmed and the list exports as CSV.

**Check yourself:** build a crate of 6 tracks where each one is within 6% of
the previous and in a compatible key.

---

## Lesson 10: Effects and key lock

**Goal:** use effects tastefully and change tempo without changing pitch.

**Effects (FX row on each deck)**
1. Click the type button to choose ECHO, REVERB or FLANGER.
2. The beat button sets the echo time or flanger sweep in beats (such as 3/4).
3. The slider sets the amount; **FX** turns it on and off. Switching off lets
   the echo or reverb tail ring out.
4. A classic move: echo on the last beat of a phrase, then cut the channel;
   the echo carries into the next track.

**Key lock**
1. Move a tempo fader by 6%: the pitch rises (the KEY readout shows the shift).
2. Press **KEYLOCK**: the tempo stays, the pitch returns to normal, bass
   included.
3. Use key lock when you change tempo a lot, especially with vocals.

**Check yourself:** at +6% with KEYLOCK on, a vocal sounds natural; with it off,
it sounds higher.

**Keep in mind:** beyond about 8%, key lock can smear drum hits slightly. For
big tempo differences, choose closer tracks instead.

---

## Lesson 11: Dialogue pads and the mic

**Goal:** fire a dialogue or sound drop at the right moment, and talk over the
mix.

**Dialogue pads (the DIALOGUES panel)**
1. Drag an audio file (up to 60 seconds) onto a pad, or drag a track from the
   library onto it, or use the pad's **Load** button.
2. Press the pad: the clip plays over the mix. Press again to cut it short.
   Numpad 1 to 8 fire pads; `B` stops them all.
3. **TALK** sets how far the music dips while a clip plays: off, -6, -10 or
   -16 dB. -10 dB is a good start.
4. **LEVEL** sets the dialogue volume.
5. Shift+click a pad to preview it in the headphones (it shows **PFL**); press
   it then to send it live.
6. Right-click or **×** clears a pad. Pads are saved, so they are still there
   next time.

**Mic**
1. Hold **MIC** (or Numpad 0) to talk. It shows **ON AIR** in red while held
   and mutes when you let go. The music dips by the TALK amount.
2. The first time, the browser asks for microphone access. Allow it.
3. Keep the microphone away from the speakers, or it will howl (feedback).
4. The mic level is set in your computer's sound input settings.

**Check yourself:** during a breakdown, fire a dialogue that ends exactly as
the drop hits. Then hold MIC, say the next track's name, and release.

**Common mistakes**
- A clip that is too long (over 60 seconds) is refused: load it on a deck.
- Talking with TALK off: your voice fights the music. Use -10 dB.

---

## Lesson 12: Performing: record, lock, PERFORM mode, Auto DJ

**Goal:** get ready to play for people.

1. **REC** records the master to a WAV file. In Chrome and Edge it asks where
   to save and writes as it goes, so a long set never fills memory. Dialogues
   and the mic are recorded too.
2. **LOCK** on a playing deck blocks loading, CUE and pause, so a stray click
   cannot stop the track on air.
3. **PERFORM** gives a compact layout: preparation controls are hidden, the
   library becomes a drawer, and the decks, mixer and pads fit on one screen.
   The screen stays awake while a deck plays.
4. **Auto DJ** plays the tracks on screen (a crate, a search, the library)
   from the selected row, with synced 16-beat crossfades. Useful for a break.
5. **Ctrl+Z** puts back the track a load replaced. After a crash or reload, a
   banner offers to restore the decks and mixer.
6. Chrome and Edge can **install** the app (install icon in the address bar)
   so it runs from the desktop and works offline.

**Check yourself:** record a 2-minute mix, then play the WAV file back in
another player.

---

## Lesson 13: Keyboard and MIDI controllers

**Goal:** play without the mouse.

**Keyboard** (press `?` in the app for the full list)

| Deck A | Deck B | Action |
|---|---|---|
| Q | P | Play / pause |
| W | O | Cue (hold to preview) |
| E | I | Sync |
| R | U | Loop on / off |
| 1 2 3 4 | 7 8 9 0 | Hot cues 1 to 4 |
| A / S | K / L | Nudge slower / faster (hold) |

Left and Right move the crossfader, `C` centres it, `/` searches, and
Shift+Left / Shift+Right load the selected track onto A / B.

**MIDI controllers**
1. Connect the controller and press **Enable MIDI**.
2. The built-in mapping follows the common Pioneer DDJ layout (not yet verified
   on real hardware). The top bar shows every message received.
3. **MIDI map** opens MIDI learn: pick an action, move a control, done.
   Mappings can be exported and imported as JSON.
4. Mapped hot cue, dialogue pad and MIC buttons light up on the controller.

**Check yourself:** map a spare button to "Dialogues: Pad 1" and fire a clip
from the controller.

---

## Lesson 14: When the analysis is wrong

**Goal:** fix a wrong BPM, grid or key in seconds.

| Problem | Fix |
|---|---|
| BPM is half or double | Press `/2` or `x2` under the BPM |
| BPM is wrong | Press **TAP** on the beat at least 3 times |
| Beat markers slightly off the kicks | **GRID <** / **GRID >** move the grid 5 ms |
| Beat markers way off | Pause on a kick and press **SET BEAT** |
| "no steady beat found" | The beat is too weak or absent; TAP sets one |
| "tempo changes: the grid follows the main tempo" | The song changes tempo part-way; the grid fits the main part. Mix out of it before the tempo change, or use SYNC off and ride the tempo fader |
| Key looks wrong | Trust your ears; most misses are a compatible neighbour |

Grid and BPM fixes are saved with the track.

**Check yourself:** on a demo track, press `x2`, then `/2` to put it back; nudge
the grid twice and put it back.

---

## Final exercise: a 10-minute mix

Put it all together. Aim for three tracks and two transitions.

1. Build a crate of three tracks within 6% of each other and in compatible
   keys (Lesson 9). Set hot cues on each intro and outro (Lesson 8).
2. Load a dialogue clip on pad 1 (Lesson 11).
3. Turn on **REC** (Lesson 12) and **PERFORM** mode.
4. Play track 1. Cue track 2 in the headphones (Lesson 7) and beatmatch it,
   by ear if you can (Lesson 5).
5. Transition over 16 beats with a bass swap (Lesson 6).
6. Before the second transition, loop track 2's outro (Lesson 8) and fire the
   dialogue on the last phrase.
7. Transition into track 3 with an echo out (Lesson 10).
8. Stop REC and listen back.

**Review your recording:** did the kicks ever flam? Were there two bass lines
at once? Did the LIMIT light stay on? Was the dialogue clear over the music?
Pick one thing to improve and record again.

---

## Before a gig: checklist

- [ ] Browser is Chrome or Edge, up to date; the app is installed or the page
      is open and working offline.
- [ ] Audio output chosen (Output menu), headphone routing set, levels low.
- [ ] Every track in the set loaded once, so its analysis is cached.
- [ ] BPMs and grids checked; wrong ones fixed (Lesson 14).
- [ ] Crate built in play order; hot cues set.
- [ ] Dialogue pads loaded and previewed; TALK and LEVEL set.
- [ ] Mic tested once (so the permission prompt is out of the way), away from
      the speakers.
- [ ] MIDI controller connected and tested; mapping exported as a backup.
- [ ] REC tested: start, stop, and the file opens.
- [ ] Laptop on power; notifications off; other tabs closed.
- [ ] A backup: the same set on a second device, or Auto DJ ready on a crate.

---

## Glossary

| Term | Meaning |
|---|---|
| BPM | Beats per minute: the tempo |
| Beat grid | The beat markers the app places on a track; SYNC and quantize use it |
| Beatmatching | Making two tracks play at the same tempo with beats lined up |
| Camelot | A key notation (1A to 12B) where neighbours mix well |
| Cue point | Where CUE returns to; set it with CUE on a stopped deck |
| Hot cue | A saved position on a pad that you can jump to |
| Kill | An EQ button that removes a band completely |
| Key lock | Changing tempo without changing pitch |
| Phase | Whether two tracks' beats land together |
| PFL | Pre-fader listen: hearing something in the headphones only |
| Quantize (Q) | Snapping cues, loops and jumps to the beat |
| Talk-over | Lowering the music while a dialogue or the mic is on |
