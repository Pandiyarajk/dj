/**
 * One deck's controls: track header, status line, overview waveform,
 * transport, hot cues, loops and the tempo section.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (hold CUE and pads, per-cue colours, BPM x2 / /2,
 *   track-end warning, fader synced unless dragged, accessible labels)
 */
import { formatBeats, formatTime, HOT_CUE_COUNT, LOOP_SIZES, type DeckController, type DeckState } from '../audio/deck-controller';
import type { Actions } from '../input/actions';
import { dragTracker, h, setClass, setText } from './dom';
import { HOT_CUE_COLOURS, OverviewWaveform } from './waveform';

/** MIME type used when dragging a library row onto a deck. */
export const ENTRY_DRAG_TYPE = 'application/x-dj-entry';
/** Warn when a playing track has this many seconds left. */
const END_WARNING_SECONDS = 30;

export interface DeckDropHandlers {
  onFile: (file: File) => void;
  onEntry: (entryId: string) => void;
}

export class DeckView {
  readonly el: HTMLElement;
  private readonly overview: OverviewWaveform;
  private readonly title: HTMLElement;
  private readonly artist: HTMLElement;
  private readonly bpm: HTMLElement;
  private readonly status: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly remaining: HTMLElement;
  private readonly tempoReadout: HTMLElement;
  private readonly tempoFader: HTMLInputElement;
  private readonly tempoDragging: () => boolean;
  private readonly rangeButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly cueButton: HTMLButtonElement;
  private readonly syncButton: HTMLButtonElement;
  private readonly quantizeButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly loopButton: HTMLButtonElement;
  private readonly loopInButton: HTMLButtonElement;
  private readonly pads: HTMLButtonElement[] = [];
  private readonly loopSizeButtons = new Map<number, HTMLButtonElement>();

  constructor(
    private readonly deck: DeckController,
    actions: Actions,
    drop: DeckDropHandlers,
  ) {
    const d = `deck.${deck.id}`;
    const btn = (label: string, action: string, title: string, cls = '', hold = false): HTMLButtonElement =>
      actions.button(`${d}.${action}`, h('button', { class: `btn ${cls}`.trim(), text: label, title, attrs: { type: 'button', 'aria-label': title } }), hold);

    this.title = h('div', { class: 'track-title', text: 'No track' });
    this.artist = h('div', { class: 'track-artist' });
    this.bpm = h('div', { class: 'bpm-value', text: '--.--' });
    this.status = h('div', { class: 'deck-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.elapsed = h('span', { class: 'time-elapsed', text: '0:00.0' });
    this.remaining = h('span', { class: 'time-remaining', text: '-0:00.0' });
    this.tempoReadout = h('span', { class: 'tempo-readout', text: '+0.00%' });

    const canvas = h('canvas', { class: 'overview', title: 'Track overview: click or drag to jump' });
    this.overview = new OverviewWaveform(canvas, (fraction) => deck.jump(fraction * deck.duration));

    this.cueButton = btn('CUE', 'cue', 'Cue: stopped sets the cue point and previews while held; playing returns to it', 'btn-cue', true);
    this.playButton = btn('PLAY', 'play', 'Play / pause', 'btn-play');
    this.syncButton = btn('SYNC', 'sync', 'Match tempo and phase to the other deck; press again to release', 'btn-sync');
    this.quantizeButton = btn('Q', 'quantize', 'Quantize: snap cues and loops to the beat grid, keep the beat on jumps', 'btn-small');
    this.rangeButton = btn('8%', 'range', 'Tempo fader range', 'btn-small');
    this.lockButton = btn('LOCK', 'lock', 'Lock on air: blocks loading, CUE and pause on this deck while it plays', 'btn-tiny btn-lock');

    for (let i = 0; i < HOT_CUE_COUNT; i++) this.pads.push(this.pad(actions, `${d}.hotcue.${i + 1}`, i));

    const loopSizes = LOOP_SIZES.map((size) => {
      const b = btn(String(size), `loop.${size}`, `Auto loop ${formatBeats(size)} (press again to exit)`, 'btn-small');
      this.loopSizeButtons.set(size, b);
      return b;
    });
    this.loopInButton = btn('IN', 'loop.in', 'Loop in point', 'btn-small');
    this.loopButton = btn('LOOP', 'loop.toggle', 'Loop on/off (re-engages the last loop)', 'btn-small');

    this.tempoFader = h('input', {
      class: 'tempo-fader',
      title: 'Tempo (top = slower, bottom = faster). Double-click resets.',
      attrs: { type: 'range', min: '0', max: '1', step: '0.0005', value: '0.5', 'aria-label': `Deck ${deck.id} tempo` },
    });
    this.tempoDragging = dragTracker(this.tempoFader);
    this.tempoFader.addEventListener('input', () => actions.trigger(`${d}.tempo`, Number(this.tempoFader.value)));
    this.tempoFader.addEventListener('dblclick', () => actions.trigger(`${d}.tempo.reset`));

    this.el = h('section', { class: `deck deck-${deck.id.toLowerCase()}`, attrs: { 'aria-label': `Deck ${deck.id}` } }, [
      h('header', { class: 'deck-header' }, [
        h('div', { class: 'deck-id', text: deck.id }),
        h('div', { class: 'track-info' }, [this.title, this.artist]),
        this.lockButton,
        h('div', { class: 'bpm' }, [
          this.bpm,
          h('div', { class: 'bpm-tools' }, [
            btn('/2', 'bpm.halve', 'BPM reads double: halve it', 'btn-tiny'),
            h('span', { class: 'bpm-label', text: 'BPM' }),
            btn('x2', 'bpm.double', 'BPM reads half: double it', 'btn-tiny'),
          ]),
        ]),
      ]),
      this.status,
      canvas,
      h('div', { class: 'time-row' }, [this.elapsed, this.tempoReadout, this.remaining]),
      h('div', { class: 'deck-body' }, [
        h('div', { class: 'deck-main' }, [
          h('div', { class: 'pads' }, this.pads),
          h('div', { class: 'loop-row' }, loopSizes),
          h('div', { class: 'loop-row' }, [
            this.loopInButton,
            btn('OUT', 'loop.out', 'Loop out point', 'btn-small'),
            this.loopButton,
            btn('1/2', 'loop.halve', 'Halve the loop (or the loop size)', 'btn-small'),
            btn('x2', 'loop.double', 'Double the loop (or the loop size)', 'btn-small'),
          ]),
          h('div', { class: 'loop-row' }, [
            btn('<< JUMP', 'jump.back', 'Beat jump back by the loop size', 'btn-small btn-wide'),
            btn('JUMP >>', 'jump.forward', 'Beat jump forward by the loop size', 'btn-small btn-wide'),
          ]),
          h('div', { class: 'transport' }, [this.cueButton, this.playButton]),
        ]),
        h('div', { class: 'tempo-section' }, [
          this.syncButton,
          h('div', { class: 'tempo-small-row' }, [this.quantizeButton, this.rangeButton]),
          this.tempoFader,
          h('div', { class: 'tempo-small-row' }, [
            btn('-', 'bend.down', 'Nudge slower (hold)', 'btn-small', true),
            btn('+', 'bend.up', 'Nudge faster (hold)', 'btn-small', true),
          ]),
        ]),
      ]),
    ]);

    this.attachDrop(drop);
    deck.store.subscribe((state) => this.renderState(state));
    this.renderState(deck.state);
  }

  /**
   * A hot-cue pad: a hold control (a stopped deck plays from the cue while
   * held), with Shift+press or right-click to clear. Wired by hand rather than
   * with actions.button(): Shift must choose the clear action instead of the
   * press, not in addition to it.
   */
  private pad(actions: Actions, name: string, index: number): HTMLButtonElement {
    const pad = h('button', {
      class: 'btn pad',
      text: String(index + 1),
      title: `Hot cue ${index + 1}: an empty pad stores the position; a set pad jumps to it (a stopped deck plays while held). Shift+click or right-click clears.`,
      attrs: { type: 'button', 'aria-label': `Hot cue ${index + 1}` },
    });
    pad.style.setProperty('--pad-colour', `var(--hotcue-${index + 1}, ${HOT_CUE_COLOURS[index]})`);
    actions.bind(name, pad);
    actions.bind(`${name}.clear`, pad);
    let held = false;
    const press = (shift: boolean): void => {
      if (shift) return actions.trigger(`${name}.clear`);
      held = true;
      actions.trigger(name, 1);
    };
    const release = (): void => {
      if (!held) return;
      held = false;
      actions.trigger(name, 0);
    };
    pad.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pad.setPointerCapture(event.pointerId);
      press(event.shiftKey);
    });
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    pad.addEventListener('lostpointercapture', release);
    pad.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      actions.trigger(`${name}.clear`);
    });
    pad.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) press(event.shiftKey);
    });
    pad.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') release();
    });
    pad.addEventListener('blur', release);
    return pad;
  }

  private attachDrop(drop: DeckDropHandlers): void {
    const accepts = (event: DragEvent): boolean => {
      const types = event.dataTransfer?.types ?? [];
      return types.includes('Files') || types.includes(ENTRY_DRAG_TYPE);
    };
    this.el.addEventListener('dragover', (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      this.el.classList.add('drop-target');
    });
    this.el.addEventListener('dragleave', (event) => {
      if (!this.el.contains(event.relatedTarget as Node | null)) this.el.classList.remove('drop-target');
    });
    this.el.addEventListener('drop', (event) => {
      this.el.classList.remove('drop-target');
      const transfer = event.dataTransfer;
      if (!transfer) return;
      event.preventDefault();
      const entryId = transfer.getData(ENTRY_DRAG_TYPE);
      if (entryId) return drop.onEntry(entryId);
      const file = Array.from(transfer.files)[0];
      if (file) drop.onFile(file);
      else this.deck.notice('Nothing to load in that drop', 'warn');
    });
  }

  private renderState(state: DeckState): void {
    setText(this.title, state.track?.title ?? 'No track');
    this.title.title = state.track?.title ?? '';
    setText(this.artist, state.track?.artist ?? '');
    const bpm = this.deck.effectiveBpm;
    let bpmText = bpm?.toFixed(2) ?? '--.--';
    if (bpm === null && state.analysis !== null) bpmText = '...';
    setText(this.bpm, bpmText);

    const notice = state.notice;
    setText(this.status, notice?.text ?? state.statusText);
    setClass(this.status, 'is-notice', notice !== null);
    setClass(this.status, 'is-warn', notice?.level === 'warn');
    setClass(this.status, 'is-error', notice === null && state.status === 'error');
    setClass(this.status, 'is-busy', notice === null && (state.status === 'loading' || state.analysis !== null));

    setClass(this.playButton, 'on', state.playing);
    setText(this.playButton, state.playing ? 'PAUSE' : 'PLAY');
    setClass(this.cueButton, 'on', state.previewing === 'cue');
    setClass(this.syncButton, 'on', state.synced);
    setClass(this.quantizeButton, 'on', state.quantize);
    setClass(this.lockButton, 'on', state.locked);
    setClass(this.el, 'locked', state.locked);
    setText(this.rangeButton, `${Math.round(state.tempoRange * 100)}%`);
    setClass(this.loopButton, 'on', state.loop !== null);
    setClass(this.loopInButton, 'on', state.loopIn !== null);
    for (const [size, button] of this.loopSizeButtons) {
      setClass(button, 'on', state.loop?.beats === size);
      setClass(button, 'selected', state.loopSize === size);
    }
    this.pads.forEach((pad, i) => {
      const set = state.hotCues[i] !== null;
      setClass(pad, 'set', set);
      setClass(pad, 'held', state.previewing === i);
      pad.setAttribute('aria-label', `Hot cue ${i + 1}, ${set ? 'set' : 'empty'}`);
    });

    // Round first: a tiny negative tempo otherwise reads "-0.00%".
    const percent = Math.round(state.tempo * 10000) / 100;
    const sign = percent < 0 ? '-' : '+';
    setText(this.tempoReadout, `${sign}${Math.abs(percent).toFixed(2)}%${state.bend ? ' nudge' : ''}`);
    // Synced from state unless being dragged: a focus guard left the thumb
    // behind after a double-click reset.
    const faderValue = String(0.5 + state.tempo / state.tempoRange / 2);
    if (!this.tempoDragging() && this.tempoFader.value !== faderValue) this.tempoFader.value = faderValue;
  }

  /** Per-frame update: playhead-dependent parts only. */
  frame(): void {
    const state = this.deck.state;
    const position = this.deck.position();
    const duration = this.deck.duration;
    const left = Math.max(0, duration - position);
    const ending = state.status === 'ready' && state.playing && !state.loop && left < END_WARNING_SECONDS;
    this.overview.draw(state, position, duration, ending);
    setClass(this.remaining, 'ending', ending);
    setClass(this.el, 'ending', ending);
    if (state.status === 'ready') {
      setText(this.elapsed, formatTime(position));
      setText(this.remaining, `-${formatTime(left)}`);
    } else {
      setText(this.elapsed, '0:00.0');
      setText(this.remaining, '-0:00.0');
    }
  }
}
