/**
 * Boot: build the engine, decks and views, then start the render loop.
 *
 * Each subsystem is started through `start()`, so one that throws is reported
 * on screen instead of silently aborting everything after it.
 *
 * URL flags:
 *   ?demo=1   load the built-in demo tracks onto both decks (for trying the app
 *             and for smoke tests).
 *   ?debug=1  expose `window.dj` (engine, decks, mixer, library, sync) for scripts/e2e.mjs.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (phase meter, waveform zoom, drop guard, dismissable
 *   error banner, shortcuts blocked behind the help dialog)
 */
import { DeckController, formatTime } from './audio/deck-controller';
import { Prelisten } from './audio/prelisten';
import { formatDuration } from './audio/recorder';
import { toPcm16, wavHeader } from './audio/wav';
import { renderDemo } from './demo/demo-tracks';
import { AudioEngine } from './audio/engine';
import { defaultMixer, type MixerState } from './audio/mixer';
import { SyncCoordinator } from './audio/sync-coordinator';
import { DEMO_TRACKS } from './demo/demo-tracks';
import { Actions } from './input/actions';
import { attachKeyboard } from './input/keyboard';
import { MidiInput } from './input/midi';
import { registerActions } from './input/register-actions';
import { errorText, Library, type LibraryEntry } from './library/library';
import { requestPersistence } from './library/db';
import { BackgroundAnalyser } from './library/background-analyser';
import { PLAYED_AFTER, PlayHistory } from './library/history';
import { TrackLoader } from './library/track-loader';
import { describeDeck, SessionManager } from './state/session';
import { Store } from './state/store';
import { DeckView } from './ui/deck-view';
import { flash, h, setClass, setText } from './ui/dom';
import { HelpDialog } from './ui/help';
import { HistoryDialog } from './ui/history-view';
import { MidiLearnDialog } from './ui/midi-learn-view';
import { LibraryView } from './ui/library-view';
import { MixerView } from './ui/mixer-view';
import { PhaseMeter } from './ui/phase-meter';
import { ScrollingWaveform, ZOOM_LEVELS } from './ui/waveform';

/** Errors shown at most; older ones are dropped (they are also in the console). */
const MAX_ERRORS = 5;
const errors: string[] = [];
const errorList = h('div', { class: 'error-list' });
const errorBanner = h('div', { class: 'error-banner', attrs: { role: 'alert' } }, [
  errorList,
  h('button', {
    class: 'btn btn-small',
    text: 'Dismiss',
    attrs: { type: 'button' },
    on: {
      click: () => {
        errors.length = 0;
        errorBanner.classList.remove('visible');
      },
    },
  }),
]);

function reportError(context: string, error: unknown): void {
  const message = `${context}: ${errorText(error)}`;
  if (errors.includes(message)) return;
  errors.push(message);
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
  errorList.replaceChildren(...errors.map((e) => h('div', { text: e })));
  errorBanner.classList.add('visible');
  console.error(message, error);
}

/** Run one boot step; a failure is shown and the rest of boot continues. */
function start<T>(context: string, step: () => T): T | null {
  try {
    return step();
  } catch (error) {
    reportError(context, error);
    return null;
  }
}

function audioStatusText(engine: AudioEngine): string {
  if (engine.ctx.state !== 'running') return 'Audio paused: click or press a key to start';
  const khz = (engine.ctx.sampleRate / 1000).toFixed(1);
  const ms = Math.round(engine.outputLatency * 1000);
  return `Audio on, ${khz} kHz, ${ms} ms output latency`;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app element missing');

  let engine: AudioEngine;
  try {
    engine = await AudioEngine.create();
  } catch (error) {
    const message = h('p', { class: 'boot-message is-error', text: `Audio could not start: ${errorText(error)}. This app needs a browser with Web Audio and AudioWorklet (Chrome, Edge, Firefox or Safari).` });
    app.replaceChildren(message);
    return;
  }

  const mixer = new Store<MixerState>(defaultMixer());
  engine.bindMixer(mixer);
  const decks: [DeckController, DeckController] = [new DeckController('A', engine, engine.strips[0]), new DeckController('B', engine, engine.strips[1])];
  const sync = new SyncCoordinator(decks);
  const library = new Library();
  library.addDemos(DEMO_TRACKS);
  const loader = new TrackLoader(engine.ctx, library, decks);
  void requestPersistence();
  const actions = new Actions();
  registerActions(actions, decks, sync, mixer);
  const midi = new MidiInput(actions);
  // Controller LEDs follow the app: transport, sync, pads, loop, cue buttons.
  midi.setLedSource(() => {
    const lit = new Map<string, boolean>();
    decks.forEach((deck, i) => {
      const s = deck.state;
      const d = `deck.${deck.id}`;
      lit.set(`${d}.play`, s.playing);
      lit.set(`${d}.cue`, s.previewing === 'cue' || (!s.playing && deck.loaded));
      lit.set(`${d}.sync`, s.synced);
      lit.set(`${d}.loop.toggle`, s.loop !== null);
      lit.set(`mixer.${deck.id}.cue`, mixer.get().channels[i].cue);
      s.hotCues.forEach((cue, n) => lit.set(`${d}.hotcue.${n + 1}`, cue !== null));
    });
    return lit;
  });

  const load = (entry: LibraryEntry, deck: DeckController): void => {
    if (deck.state.locked) {
      deck.notice(`Deck ${deck.id} is locked (on air): unlock it to load`, 'warn');
      return;
    }
    if (deck.state.playing) {
      deck.notice('Deck is playing: pause it before loading', 'warn');
      return;
    }
    void loader.loadEntry(deck, entry);
  };
  const deckById = (id: 'A' | 'B'): DeckController => (id === 'A' ? decks[0] : decks[1]);
  const entryById = (id: string): LibraryEntry | undefined => library.store.get().entries.find((e) => e.id === id);

  // ---- views ----
  const help = new HelpDialog();
  const audioPill = h('button', { class: 'pill', attrs: { type: 'button' }, title: 'Browsers keep audio paused until you interact with the page' });
  audioPill.addEventListener('click', () => void engine.resume());
  const midiButton = h('button', { class: 'btn btn-small', text: 'Enable MIDI', attrs: { type: 'button' } });
  const midiStatus = h('span', { class: 'midi-status', attrs: { role: 'status' } });
  midiButton.addEventListener('click', () => void midi.enable());
  midi.store.subscribe((s) => {
    setText(midiStatus, s.status);
    midiButton.hidden = s.enabled;
  });
  setText(midiStatus, MidiInput.supported() ? '' : 'No Web MIDI in this browser');
  midiButton.disabled = !MidiInput.supported();
  // ---- output device (Chrome/Edge: AudioContext.setSinkId) ----
  const outputSelect = h('select', { class: 'output-select', title: 'Output device', attrs: { 'aria-label': 'Output device' } });
  const fillOutputs = async (): Promise<void> => {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
    outputSelect.replaceChildren(
      h('option', { text: 'Output: system default', attrs: { value: '' } }),
      // Browsers hide device names until a permission is granted; number them instead.
      ...outputs.map((d, i) => h('option', { text: `Output: ${d.label || `device ${i + 1}`}`, attrs: { value: d.deviceId } })),
    );
  };
  outputSelect.addEventListener('change', () => {
    const label = outputSelect.selectedOptions[0]?.textContent ?? '';
    engine
      .setOutputDevice(outputSelect.value)
      .then(() => setText(midiStatus, `${label.replace('Output: ', 'Audio now on ')}`))
      .catch((error) => setText(midiStatus, `Could not switch output: ${errorText(error)}`));
  });
  outputSelect.hidden = !engine.canChooseOutput;
  if (engine.canChooseOutput) {
    void fillOutputs();
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void fillOutputs());
  }

  const recorder = engine.createRecorder();
  const recButton = h('button', { class: 'btn btn-small btn-rec', text: 'REC', title: 'Record the master output as a WAV file', attrs: { type: 'button' } });
  recButton.addEventListener('click', () => recorder.toggle());
  const recStatus = h('span', { class: 'rec-status', attrs: { role: 'status' } });
  recorder.store.subscribe((s) => {
    setClass(recButton, 'on', s.recording);
    setText(recButton, s.recording ? `REC ${formatDuration(s.seconds)}` : 'REC');
    setText(recStatus, s.recording ? `${(s.bytes / 1e6).toFixed(1)} MB` : s.status);
  });
  const learnDialog = new MidiLearnDialog(midi);
  void learnDialog.restore();
  const helpButton = h('button', { class: 'btn btn-small', text: 'Shortcuts (?)', attrs: { type: 'button' } });
  helpButton.addEventListener('click', () => help.toggle());

  const topbar = h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), h('span', { text: 'dj' })]),
    audioPill,
    h('div', { class: 'topbar-right' }, [recStatus, recButton, outputSelect, midiStatus, midiButton, learnDialog.button, helpButton]),
  ]);

  // Waveform zoom, shared by both decks so their beats line up on screen.
  let zoomIndex = ZOOM_LEVELS.indexOf(8);
  const zoomLabel = h('span', { class: 'zoom-label', attrs: { role: 'status' } });
  const showZoom = (): void => setText(zoomLabel, `${ZOOM_LEVELS[zoomIndex]} s`);
  const zoom = (step: -1 | 1): void => {
    const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + step));
    // At a limit, say so: a press that changes nothing must still show it landed.
    if (next === zoomIndex) setText(zoomLabel, `${ZOOM_LEVELS[zoomIndex]} s (${step < 0 ? 'closest' : 'widest'})`);
    else {
      zoomIndex = next;
      showZoom();
    }
  };
  actions.register('view.zoom.in', (v) => v > 0 && zoom(-1));
  actions.register('view.zoom.out', (v) => v > 0 && zoom(1));
  showZoom();
  const zoomButton = (label: string, action: string, title: string): HTMLButtonElement =>
    actions.button(action, h('button', { class: 'btn btn-tiny', text: label, title, attrs: { type: 'button', 'aria-label': title } }));

  const waveViews: Array<{ view: ScrollingWaveform; deck: DeckController }> = [];
  const phaseMeter = start('Phase meter', () => new PhaseMeter(decks));
  const waves = h('section', { class: 'waves', attrs: { 'aria-label': 'Scrolling waveforms' } }, [
    h('div', { class: 'zoom-tools' }, [
      zoomButton('+', 'view.zoom.in', 'Zoom in (=)'),
      zoomLabel,
      zoomButton('-', 'view.zoom.out', 'Zoom out (-)'),
    ]),
  ]);
  decks.forEach((deck, i) => {
    start(`Waveform ${deck.id}`, () => {
      const canvas = h('canvas', { class: `wave wave-${deck.id.toLowerCase()}` });
      waves.append(h('div', { class: `wave-row wave-row-${deck.id.toLowerCase()}` }, [h('span', { class: 'wave-label', text: deck.id }), canvas]));
      waveViews.push({ view: new ScrollingWaveform(canvas), deck });
    });
    if (i === 0 && phaseMeter) waves.append(phaseMeter.el);
  });

  const deckViews = decks
    .map((deck) =>
      start(`Deck ${deck.id}`, () => new DeckView(deck, actions, { onFile: (file) => {
        // Same guards as library loads: a drop must not replace a playing or locked track.
        if (deck.state.locked) deck.notice(`Deck ${deck.id} is locked (on air): unlock it to load`, 'warn');
        else if (deck.state.playing) deck.notice('Deck is playing: pause it before loading', 'warn');
        else void loader.loadFile(deck, file);
      }, onEntry: (id) => {
        const entry = entryById(id);
        if (entry) load(entry, deck);
        else deck.notice('That track is no longer in the library', 'warn');
      } }, mixer)),
    )
    .filter((v): v is DeckView => v !== null);
  const mixerView = start('Mixer', () => new MixerView(engine, mixer, actions, decks));
  const background = new BackgroundAnalyser(engine.ctx, library, decks);
  // ---- prelisten (headphones only) ----
  const prelisten = new Prelisten(engine.ctx, engine.cueInput, () => engine.cueAudible);
  const listenTitle = h('span', { class: 'listen-title' });
  const listenTrack = h('div', { class: 'listen-track', title: 'Click to jump' }, [h('div', { class: 'listen-fill' })]);
  listenTrack.addEventListener('pointerdown', (event) => {
    const rect = listenTrack.getBoundingClientRect();
    if (rect.width > 0) prelisten.seek((event.clientX - rect.left) / rect.width);
  });
  const listenStop = h('button', { class: 'btn btn-tiny', text: 'Stop', attrs: { type: 'button' }, on: { click: () => prelisten.stop() } });
  const listenBar = h('div', { class: 'listen-bar', attrs: { role: 'status' } }, [h('span', { class: 'listen-icon' }), listenTitle, listenTrack, listenStop]);
  prelisten.store.subscribe((s) => {
    const active = s.title !== null;
    setClass(listenBar, 'active', active);
    setText(listenTitle, active ? `${s.title}  ${formatTime(s.position)} / ${formatTime(s.duration)}` : s.status);
    (listenTrack.firstElementChild as HTMLElement).style.width = `${s.duration ? (s.position / s.duration) * 100 : 0}%`;
    listenStop.hidden = !active;
  });
  listenStop.hidden = true;
  const startPrelisten = async (entry: LibraryEntry): Promise<void> => {
    try {
      let blob: Blob;
      if (entry.source.kind === 'demo') {
        const audio = renderDemo(entry.source.spec, engine.ctx);
        blob = new Blob([wavHeader(audio.length * 4, audio.sampleRate), toPcm16(audio.getChannelData(0), audio.getChannelData(1))], { type: 'audio/wav' });
      } else {
        blob = await entry.source.getFile();
      }
      await engine.resume();
      await prelisten.play(entry.title, blob);
    } catch (error) {
      prelisten.stop(`Cannot prelisten "${entry.title}": ${errorText(error)}`);
    }
  };

  const history = new PlayHistory();
  void history.load();
  const historyDialog = new HistoryDialog(history);
  /** The deck on air: the playing one, or the one the crossfader favours when both play. */
  const onAir = (): DeckController | null => {
    const playing = decks.filter((d) => d.state.playing && d.loaded);
    if (playing.length === 1) return playing[0];
    if (playing.length === 2) return mixer.get().crossfader <= 0 ? decks[0] : decks[1];
    return decks.find((d) => d.loaded && d.state.bpm !== null) ?? null;
  };
  const analyseButton = h('button', { class: 'btn btn-small', text: 'Analyse library', title: 'Find BPM and key for every track in the background (pauses while a deck loads)', attrs: { type: 'button' } });
  analyseButton.addEventListener('click', () => background.toggle());
  const analyseStatus = h('span', { class: 'library-status analyse-status', attrs: { role: 'status' } });
  background.store.subscribe((s) => {
    setText(analyseButton, s.running ? 'Pause analysis' : 'Analyse library');
    setClass(analyseButton, 'on', s.running);
    setText(analyseStatus, s.status);
    setClass(analyseStatus, 'is-busy', s.running);
  });
  const libraryView = start(
    'Library',
    () =>
      new LibraryView(library, {
        tools: [analyseButton, analyseStatus, historyDialog.button],
        reference: () => {
          const deck = onAir();
          return deck ? { deck: deck.id, bpm: deck.effectiveBpm, key: deck.state.key } : null;
        },
        playedIds: () => history.playedIds(),
        prelisten: (entry) => void startPrelisten(entry),
        load: (entry, id) => load(entry, deckById(id)),
        loadAuto: (entry) => {
          const target = decks.find((d) => !d.loaded) ?? decks.find((d) => !d.state.playing);
          if (target) load(entry, target);
          else decks[0].notice('Both decks are playing: use the A / B buttons', 'warn');
        },
      }),
  );

  const console_ = h('main', { class: 'console' }, [deckViews[0]?.el ?? null, mixerView?.el ?? null, deckViews[1]?.el ?? null]);
  if (libraryView) libraryView.el.insertBefore(listenBar, libraryView.el.children[1] ?? null);
  app.replaceChildren(topbar, errorBanner, waves, console_, libraryView?.el ?? h('div'), help.el, historyDialog.el, learnDialog.el);

  // The Match filter and key highlights follow the deck on air; played rows dim.
  for (const deck of decks) deck.store.subscribe((s, p) => (s.playing !== p.playing || s.tempo !== p.tempo || s.key !== p.key || s.bpm !== p.bpm) && libraryView?.refresh());
  mixer.subscribe((s, p) => s.crossfader !== p.crossfader && libraryView?.refresh());
  history.store.subscribe(() => libraryView?.refresh());

  // Library keyboard control.
  actions.register('library.search', (v) => v > 0 && libraryView?.focusSearch());
  actions.register('library.up', (v) => v > 0 && libraryView?.moveSelection(-1));
  actions.register('library.down', (v) => v > 0 && libraryView?.moveSelection(1));
  actions.register('library.loadA', (v) => v > 0 && libraryView?.loadSelected('A'));
  actions.register('library.loadB', (v) => v > 0 && libraryView?.loadSelected('B'));
  actions.register('library.match', (v) => v > 0 && libraryView?.toggleMatch());

  // Played history: a track counts once audible (playing, fader up, not
  // crossfaded out) for PLAYED_AFTER seconds.
  const audibleFor = new Map<DeckController, { key: string; seconds: number; logged: boolean }>();
  setInterval(() => {
    const m = mixer.get();
    decks.forEach((deck, i) => {
      const track = deck.state.track;
      if (!track) return;
      let entry = audibleFor.get(deck);
      if (!entry || entry.key !== track.key) audibleFor.set(deck, (entry = { key: track.key, seconds: 0, logged: false }));
      const xfade = i === 0 ? 1 - m.crossfader : 1 + m.crossfader;
      const audible = deck.state.playing && m.channels[i].fader > 0.05 && (m.curve === 'sharp' || xfade > 0.1);
      if (!audible || entry.logged) return;
      entry.seconds += 1;
      if (entry.seconds >= PLAYED_AFTER) {
        entry.logged = true;
        const source = loader.sourceOf(deck);
        history.add({
          at: Date.now(),
          deck: deck.id,
          title: track.title,
          artist: track.artist,
          bpm: deck.state.bpm,
          key: deck.state.key,
          entryId: source && 'entry' in source ? source.entry.id : null,
        });
        // Acknowledged on the History button (its count goes up), not on the
        // deck: the deck's notice line is busy with what the DJ is doing.
        flash(historyDialog.button);
      }
    });
  }, 1000);

  // ---- input ----
  start('Keyboard', () => attachKeyboard(actions, () => help.toggle(), () => help.el.open));
  const unlock = (): void => {
    void engine.resume();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  // Ctrl+Z (Cmd+Z) undoes the last load, outside text fields.
  window.addEventListener('keydown', (event) => {
    const editing = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && (event.target as HTMLInputElement).type !== 'range';
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey || editing) return;
    event.preventDefault();
    void loader.undo();
  });
  // Closing or reloading mid-set loses the decks: ask first while anything plays.
  window.addEventListener('beforeunload', (event) => {
    if (decks.some((d) => d.state.playing) || recorder.store.get().recording) event.preventDefault();
  });
  // Dropping a file outside a deck would navigate away from the app.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  // ---- render loop ----
  let lastAudio = '';
  const frame = (): void => {
    try {
      for (const { view, deck } of waveViews) view.draw(deck.state, deck.position(), ZOOM_LEVELS[zoomIndex]);
      phaseMeter?.frame();
      for (const view of deckViews) view.frame();
      mixerView?.frame();
      const audio = audioStatusText(engine);
      if (audio !== lastAudio) {
        lastAudio = audio;
        setText(audioPill, audio);
        setClass(audioPill, 'is-on', engine.ctx.state === 'running');
      }
    } catch (error) {
      reportError('Render', error);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  const params = new URLSearchParams(location.search);
  const session = new SessionManager(decks, mixer, loader, library);
  // Offer the last session back (never restored unasked). Skipped for ?demo=1,
  // which loads its own tracks.
  if (params.get('demo') !== '1') {
    const saved = await session.saved();
    if (saved) {
      const when = new Date(saved.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const detail = saved.decks.map((d, i) => describeDeck(i === 0 ? 'A' : 'B', d)).join('  |  ');
      const restoreButton = h('button', { class: 'btn btn-small btn-restore', text: 'Restore', attrs: { type: 'button' } });
      const dismissButton = h('button', { class: 'btn btn-small', text: 'Dismiss', attrs: { type: 'button' } });
      const text = h('div', { class: 'restore-text' }, [
        h('strong', { text: `Restore your session from ${when}?` }),
        h('span', { class: 'restore-detail', text: detail }),
      ]);
      const banner = h('div', { class: 'restore-banner', attrs: { role: 'region', 'aria-label': 'Restore session' } }, [text, restoreButton, dismissButton]);
      restoreButton.addEventListener('click', () => {
        restoreButton.disabled = true;
        dismissButton.disabled = true;
        setText(restoreButton, 'Restoring...');
        void session.restore(saved).then((results) => {
          text.replaceChildren(h('strong', { text: 'Session restored' }), h('span', { class: 'restore-detail', text: results.join('  |  ') }));
          restoreButton.remove();
          setText(dismissButton, 'Close');
          dismissButton.disabled = false;
        });
      });
      dismissButton.addEventListener('click', () => {
        banner.remove();
        void session.discard();
      });
      app.insertBefore(banner, waves);
    }
  }
  session.start();
  if (params.get('debug') === '1') {
    // Test hook for the end-to-end driver (scripts/e2e.mjs); not used by the app.
    Object.assign(window, { dj: { engine, decks, mixer, library, sync, loader, session, background, history, recorder, prelisten, midi } });
  }
  if (params.get('demo') === '1') {
    const entries = library.store.get().entries;
    const first = entries.find((e) => e.id === 'demo:house-124');
    const second = entries.find((e) => e.id === 'demo:house-128');
    if (first) void loader.loadEntry(decks[0], first);
    if (second) void loader.loadEntry(decks[1], second);
  }
}

try {
  await boot();
} catch (error) {
  const app = document.getElementById('app');
  const message = h('p', { class: 'boot-message is-error', text: `The app failed to start: ${errorText(error)}` });
  if (app) app.replaceChildren(message);
  console.error(error);
}
