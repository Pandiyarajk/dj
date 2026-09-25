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
 */
import { AnalysisClient } from './analysis/analysis-client';
import { DeckController } from './audio/deck-controller';
import { AudioEngine } from './audio/engine';
import { defaultMixer, type MixerState } from './audio/mixer';
import { SyncCoordinator } from './audio/sync-coordinator';
import { DEMO_TRACKS } from './demo/demo-tracks';
import { Actions } from './input/actions';
import { attachKeyboard } from './input/keyboard';
import { MidiInput } from './input/midi';
import { registerActions } from './input/register-actions';
import { errorText, Library, type LibraryEntry } from './library/library';
import { TrackLoader } from './library/track-loader';
import { Store } from './state/store';
import { DeckView } from './ui/deck-view';
import { h, setClass, setText } from './ui/dom';
import { HelpDialog } from './ui/help';
import { LibraryView } from './ui/library-view';
import { MixerView } from './ui/mixer-view';
import { ScrollingWaveform } from './ui/waveform';

const errors: string[] = [];
const errorBanner = h('div', { class: 'error-banner', attrs: { role: 'alert' } });

function reportError(context: string, error: unknown): void {
  const message = `${context}: ${errorText(error)}`;
  if (errors.includes(message)) return;
  errors.push(message);
  errorBanner.replaceChildren(...errors.map((e) => h('div', { text: e })));
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
  const loader = new TrackLoader(engine.ctx, new AnalysisClient(), library, decks);
  const actions = new Actions();
  registerActions(actions, decks, sync, mixer);
  const midi = new MidiInput(actions);

  const load = (entry: LibraryEntry, deck: DeckController): void => {
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
  const helpButton = h('button', { class: 'btn btn-small', text: 'Shortcuts (?)', attrs: { type: 'button' } });
  helpButton.addEventListener('click', () => help.toggle());

  const topbar = h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark' }), h('span', { text: 'dj' })]),
    audioPill,
    h('div', { class: 'topbar-right' }, [midiStatus, midiButton, helpButton]),
  ]);

  const waveViews: Array<{ view: ScrollingWaveform; deck: DeckController }> = [];
  const waves = h('section', { class: 'waves', attrs: { 'aria-label': 'Scrolling waveforms' } });
  for (const deck of decks) {
    start(`Waveform ${deck.id}`, () => {
      const canvas = h('canvas', { class: `wave wave-${deck.id.toLowerCase()}` });
      waves.append(h('div', { class: `wave-row wave-row-${deck.id.toLowerCase()}` }, [h('span', { class: 'wave-label', text: deck.id }), canvas]));
      waveViews.push({ view: new ScrollingWaveform(canvas), deck });
    });
  }

  const deckViews = decks
    .map((deck) =>
      start(`Deck ${deck.id}`, () => new DeckView(deck, actions, { onFile: (file) => void loader.loadFile(deck, file), onEntry: (id) => {
        const entry = entryById(id);
        if (entry) load(entry, deck);
        else deck.notice('That track is no longer in the library', 'warn');
      } })),
    )
    .filter((v): v is DeckView => v !== null);
  const mixerView = start('Mixer', () => new MixerView(engine, mixer, actions));
  const libraryView = start(
    'Library',
    () =>
      new LibraryView(library, {
        load: (entry, id) => load(entry, deckById(id)),
        loadAuto: (entry) => {
          const target = decks.find((d) => !d.loaded) ?? decks.find((d) => !d.state.playing);
          if (target) load(entry, target);
          else decks[0].notice('Both decks are playing: use the A / B buttons', 'warn');
        },
      }),
  );

  const console_ = h('main', { class: 'console' }, [deckViews[0]?.el ?? null, mixerView?.el ?? null, deckViews[1]?.el ?? null]);
  app.replaceChildren(topbar, errorBanner, waves, console_, libraryView?.el ?? h('div'), help.el);

  // ---- input ----
  start('Keyboard', () => attachKeyboard(actions, () => help.toggle()));
  const unlock = (): void => {
    void engine.resume();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  // Dropping a file outside a deck would navigate away from the app.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  // ---- render loop ----
  let lastAudio = '';
  const frame = (): void => {
    try {
      for (const { view, deck } of waveViews) view.draw(deck.state, deck.position());
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
  if (params.get('debug') === '1') {
    // Test hook for the end-to-end driver (scripts/e2e.mjs); not used by the app.
    Object.assign(window, { dj: { engine, decks, mixer, library, sync } });
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
