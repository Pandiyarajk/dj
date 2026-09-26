/**
 * Dialogue pads panel: eight pads that fire clips over the mix, with the
 * dialogue level, talk-over depth and stop-all.
 *
 * Clips are assigned by dropping an audio file or a library row on a pad, or
 * with the pad's load button. A playing pad lights and shows how much is left.
 * MIC is push-to-talk: hold it to speak live over the mix.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { formatTime } from '../audio/deck-controller';
import type { LiveMic, MicState } from '../audio/live-mic';
import { MAX_CLIP_SECONDS, PAD_COUNT, clipTitle, duckLabel, type PadState, type Sampler, type SamplerState } from '../audio/sampler';
import type { Actions } from '../input/actions';
import { AUDIO_EXTENSIONS } from '../library/fs';
import { ENTRY_DRAG_TYPE } from './deck-view';
import { dragTracker, h, setClass, setText } from './dom';

export interface SamplerViewHandlers {
  /** A library row was dropped on pad `index`. */
  onEntry: (index: number, entryId: string) => void;
}

interface PadElements {
  slot: HTMLElement;
  pad: HTMLButtonElement;
  title: HTMLElement;
  time: HTMLElement;
  progress: HTMLElement;
  clear: HTMLButtonElement;
}

export class SamplerView {
  readonly el: HTMLElement;
  private readonly pads: PadElements[] = [];
  private readonly status: HTMLElement;
  private readonly level: HTMLInputElement;
  private readonly talk: HTMLButtonElement;
  private readonly micButton: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private loadTarget = 0;
  private frame = 0;

  constructor(
    private readonly sampler: Sampler,
    mic: LiveMic,
    actions: Actions,
    handlers: SamplerViewHandlers,
  ) {
    this.fileInput = h('input', { attrs: { type: 'file', accept: AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',') + ',audio/*', hidden: '' } });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) void sampler.assign(this.loadTarget, clipTitle(file.name), file);
      this.fileInput.value = '';
    });

    for (let i = 0; i < PAD_COUNT; i++) this.pads.push(this.padElements(i, actions, handlers));

    this.status = h('div', { class: 'sampler-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.level = h('input', { class: 'sampler-level', title: 'Dialogue level', attrs: { type: 'range', min: '0', max: '1', step: '0.01', 'aria-label': 'Dialogue level' } });
    const dragging = dragTracker(this.level);
    this.level.addEventListener('input', () => actions.trigger('sampler.level', Number(this.level.value)));
    this.talk = actions.button('sampler.talk', h('button', { class: 'btn btn-small sampler-talk', title: 'Talk-over: how far the music dips while a dialogue plays (click to change)', attrs: { type: 'button' } }));
    // Push-to-talk: a hold button (pointer down = live, up = mute), like CUE.
    this.micButton = actions.button(
      'sampler.mic',
      h('button', { class: 'btn btn-small sampler-mic', text: 'MIC', title: 'Hold to talk live over the mix (Numpad 0). Keep the mic away from the speakers to avoid feedback', attrs: { type: 'button' } }),
      true,
    );
    const stop = actions.button('sampler.stop', h('button', { class: 'btn btn-small', text: 'STOP ALL', title: 'Stop every dialogue (B)', attrs: { type: 'button' } }));

    this.el = h('section', { class: 'panel sampler-panel', attrs: { 'aria-label': 'Dialogue pads' } }, [
      h('div', { class: 'sampler-head' }, [
        h('h2', { class: 'sampler-heading', text: 'DIALOGUES' }),
        this.status,
        h('label', { class: 'sampler-level-label', text: 'LEVEL' }, [this.level]),
        this.talk,
        stop,
        this.micButton,
      ]),
      h('div', { class: 'sampler-pads' }, this.pads.map((p) => p.slot)),
      this.fileInput,
    ]);

    // One status line for pads and mic: whichever spoke last. A separate mic
    // line appearing next to MIC shifted the button under the finger.
    let padStatus = sampler.store.get().status;
    let micStatus = mic.store.get().status;
    const render = (state: SamplerState): void => {
      if (state.status !== padStatus) {
        padStatus = state.status;
        setText(this.status, state.status);
        setClass(this.status, 'warn', false);
      }
      setText(this.talk, duckLabel(state.duckDb));
      setClass(this.talk, 'on', state.duckDb < 0);
      if (!dragging()) this.level.value = String(state.level);
      state.pads.forEach((pad, i) => this.renderPad(i, pad));
      if (state.pads.some((p) => p.playing) && !this.frame) this.frame = requestAnimationFrame(() => this.tick());
    };
    setText(this.status, padStatus);
    sampler.store.subscribe(render);
    render(sampler.store.get());
    const renderMic = (state: MicState): void => {
      setText(this.micButton, state.mode === 'live' ? 'ON AIR' : 'MIC');
      setClass(this.micButton, 'live', state.mode === 'live');
      setClass(this.micButton, 'asking', state.mode === 'asking');
      this.micButton.setAttribute('aria-pressed', String(state.mode === 'live'));
      if (state.status !== micStatus && state.mode !== 'off') {
        micStatus = state.status;
        setText(this.status, state.status);
        setClass(this.status, 'warn', state.mode === 'denied' || state.mode === 'unsupported' || state.mode === 'error');
      }
    };
    mic.store.subscribe(renderMic);
    renderMic(mic.store.get());
  }

  private padElements(index: number, actions: Actions, handlers: SamplerViewHandlers): PadElements {
    const action = `sampler.pad${index + 1}`;
    const title = h('span', { class: 'dialog-title' });
    const time = h('span', { class: 'dialog-time' });
    const progress = h('span', { class: 'dialog-progress' });
    const pad = h('button', { class: 'dialog-pad', attrs: { type: 'button' } }, [h('span', { class: 'dialog-number', text: String(index + 1) }), title, time, progress]);
    actions.bind(action, pad);
    pad.addEventListener('click', (event) => {
      if (event.shiftKey) this.sampler.preview(index);
      else actions.trigger(action, 1);
    });
    pad.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void this.sampler.clear(index);
    });
    const load = h('button', { class: 'dialog-tool', text: 'Load', title: `Choose an audio file for pad ${index + 1} (up to ${MAX_CLIP_SECONDS} s)`, attrs: { type: 'button' } });
    load.addEventListener('click', () => {
      this.loadTarget = index;
      this.fileInput.click();
    });
    const clear = h('button', { class: 'dialog-tool', text: '\u00d7', title: `Clear pad ${index + 1}`, attrs: { type: 'button', 'aria-label': `Clear pad ${index + 1}` } });
    clear.addEventListener('click', () => void this.sampler.clear(index));
    const slot = h('div', { class: 'dialog-slot' }, [pad, h('div', { class: 'dialog-tools' }, [load, clear])]);

    const accepts = (event: DragEvent): boolean => {
      const types = event.dataTransfer?.types ?? [];
      return types.includes('Files') || types.includes(ENTRY_DRAG_TYPE);
    };
    slot.addEventListener('dragover', (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      // Keep the drop off the deck behind: the pad takes it.
      event.stopPropagation();
      slot.classList.add('drop-target');
    });
    slot.addEventListener('dragleave', (event) => {
      if (!slot.contains(event.relatedTarget as Node | null)) slot.classList.remove('drop-target');
    });
    slot.addEventListener('drop', (event) => {
      slot.classList.remove('drop-target');
      const transfer = event.dataTransfer;
      if (!transfer || !accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const entryId = transfer.getData(ENTRY_DRAG_TYPE);
      if (entryId) {
        handlers.onEntry(index, entryId);
        return;
      }
      const files = [...transfer.files];
      if (files.length === 0) return;
      void this.sampler.assign(index, clipTitle(files[0].name), files[0]).then(() => {
        if (files.length > 1) this.sampler.store.set({ status: `${this.sampler.store.get().status} (one clip per pad: only "${clipTitle(files[0].name)}" of ${files.length} files was used)` });
      });
    });
    return { slot, pad, title, time, progress, clear };
  }

  private renderPad(index: number, pad: PadState): void {
    const el = this.pads[index];
    const empty = pad.title === null;
    setText(el.title, pad.loading ? 'Loading...' : (pad.title ?? 'Empty'));
    el.pad.title = empty ? `Pad ${index + 1}: drop an audio file or a library track here` : `${pad.title}: click to play or stop, Shift+click to preview in the headphones, right-click to clear`;
    setClass(el.pad, 'empty', empty && !pad.loading);
    setClass(el.pad, 'playing', pad.playing && !pad.previewing);
    setClass(el.pad, 'previewing', pad.previewing);
    el.pad.setAttribute('aria-pressed', String(pad.playing));
    // x also cancels a clip still loading.
    el.clear.disabled = empty && !pad.loading;
    if (!pad.playing) {
      setText(el.time, empty ? '' : formatTime(pad.duration));
      el.progress.style.transform = 'scaleX(0)';
    }
  }

  /** Progress bars and time left while pads play; stops when none does. */
  private tick(): void {
    this.frame = 0;
    const pads = this.sampler.store.get().pads;
    let any = false;
    pads.forEach((pad, i) => {
      if (!pad.playing || pad.duration <= 0) return;
      any = true;
      const elapsed = Math.max(0, this.sampler.now - pad.startedAt);
      const fraction = Math.min(1, elapsed / pad.duration);
      this.pads[i].progress.style.transform = `scaleX(${fraction})`;
      setText(this.pads[i].time, `-${formatTime(Math.max(0, pad.duration - elapsed))}`);
    });
    if (any) this.frame = requestAnimationFrame(() => this.tick());
  }
}
