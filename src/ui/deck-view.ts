/**
 * One deck's controls: track header, status line, overview waveform,
 * transport, hot cues, loops and the tempo section.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { formatBeats, formatTime, HOT_CUE_COUNT, LOOP_SIZES, type DeckController, type DeckState } from '../audio/deck-controller';
import type { Actions } from '../input/actions';
import { h, setClass, setText } from './dom';
import { OverviewWaveform } from './waveform';

/** MIME type used when dragging a library row onto a deck. */
export const ENTRY_DRAG_TYPE = 'application/x-dj-entry';

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
  private readonly rangeButton: HTMLButtonElement;
  private readonly playButton: HTMLButtonElement;
  private readonly cueButton: HTMLButtonElement;
  private readonly syncButton: HTMLButtonElement;
  private readonly quantizeButton: HTMLButtonElement;
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
      actions.button(`${d}.${action}`, h('button', { class: `btn ${cls}`.trim(), text: label, title, attrs: { type: 'button' } }), hold);

    this.title = h('div', { class: 'track-title', text: 'No track' });
    this.artist = h('div', { class: 'track-artist' });
    this.bpm = h('div', { class: 'bpm-value', text: '--.--' });
    this.status = h('div', { class: 'deck-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.elapsed = h('span', { class: 'time-elapsed', text: '0:00.0' });
    this.remaining = h('span', { class: 'time-remaining', text: '-0:00.0' });
    this.tempoReadout = h('span', { class: 'tempo-readout', text: '+0.00%' });

    const canvas = h('canvas', { class: 'overview', title: 'Track overview: click to jump' });
    this.overview = new OverviewWaveform(canvas, (fraction) => deck.seek(fraction * deck.duration));

    this.cueButton = btn('CUE', 'cue', 'Cue: stopped sets the cue point, playing returns to it', 'btn-cue');
    this.playButton = btn('PLAY', 'play', 'Play / pause', 'btn-play');
    this.syncButton = btn('SYNC', 'sync', 'Match tempo and phase to the other deck; press again to release', 'btn-sync');
    this.quantizeButton = btn('Q', 'quantize', 'Quantize: snap cues and loops to the beat grid', 'btn-small');
    this.rangeButton = btn('8%', 'range', 'Tempo fader range', 'btn-small');

    for (let i = 0; i < HOT_CUE_COUNT; i++) {
      const name = `${d}.hotcue.${i + 1}`;
      const pad = h('button', {
        class: 'btn pad',
        text: String(i + 1),
        title: `Hot cue ${i + 1}: empty pad stores the position, set pad jumps to it. Shift+click or right-click clears.`,
        attrs: { type: 'button' },
      });
      // Wired by hand rather than with actions.button(): Shift must choose the
      // clear action instead of the press, not in addition to it.
      actions.bind(name, pad);
      actions.bind(`${name}.clear`, pad);
      pad.addEventListener('click', (event) => actions.trigger(event.shiftKey ? `${name}.clear` : name));
      pad.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        actions.trigger(`${name}.clear`);
      });
      this.pads.push(pad);
    }

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
    this.tempoFader.addEventListener('input', () => actions.trigger(`${d}.tempo`, Number(this.tempoFader.value)));
    this.tempoFader.addEventListener('dblclick', () => actions.trigger(`${d}.tempo.reset`));

    this.el = h('section', { class: `deck deck-${deck.id.toLowerCase()}`, attrs: { 'aria-label': `Deck ${deck.id}` } }, [
      h('header', { class: 'deck-header' }, [
        h('div', { class: 'deck-id', text: deck.id }),
        h('div', { class: 'track-info' }, [this.title, this.artist]),
        h('div', { class: 'bpm' }, [this.bpm, h('div', { class: 'bpm-label', text: 'BPM' })]),
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
    setClass(this.syncButton, 'on', state.synced);
    setClass(this.quantizeButton, 'on', state.quantize);
    setText(this.rangeButton, `${Math.round(state.tempoRange * 100)}%`);
    setClass(this.loopButton, 'on', state.loop !== null);
    setClass(this.loopInButton, 'on', state.loopIn !== null);
    for (const [size, button] of this.loopSizeButtons) {
      setClass(button, 'on', state.loop?.beats === size);
      setClass(button, 'selected', state.loopSize === size);
    }
    this.pads.forEach((pad, i) => setClass(pad, 'set', state.hotCues[i] !== null));

    const sign = state.tempo >= 0 ? '+' : '-';
    setText(this.tempoReadout, `${sign}${Math.abs(state.tempo * 100).toFixed(2)}%${state.bend ? ' nudge' : ''}`);
    const faderValue = String(0.5 + state.tempo / state.tempoRange / 2);
    if (document.activeElement !== this.tempoFader && this.tempoFader.value !== faderValue) this.tempoFader.value = faderValue;
  }

  /** Per-frame update: playhead-dependent parts only. */
  frame(): void {
    const state = this.deck.state;
    const position = this.deck.position();
    const duration = this.deck.duration;
    this.overview.draw(state, position, duration);
    if (state.status === 'ready') {
      setText(this.elapsed, formatTime(position));
      setText(this.remaining, `-${formatTime(Math.max(0, duration - position))}`);
    } else {
      setText(this.elapsed, '0:00.0');
      setText(this.remaining, '-0:00.0');
    }
  }
}
