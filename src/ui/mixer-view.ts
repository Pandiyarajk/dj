/**
 * Mixer: per-channel trim, 3-band EQ with kills, headphone cue, fader and
 * meter; master and cue levels, cue routing, crossfader and its curve.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (filter knob, limiter LED, faders synced unless dragged)
 */
import type { DeckController } from '../audio/deck-controller';
import type { AudioEngine } from '../audio/engine';
import { EQ_MAX_DB, EQ_MIN_DB, TRIM_MAX_DB, TRIM_MIN_DB, type CueMode, type EqBand, type MixerState } from '../audio/mixer';
import { centeredDbFromKnob, filterFrequencies, FILTER_OPEN_HIGH, FILTER_OPEN_LOW, knobFromCenteredDb } from '../audio/mixer-math';
import type { Actions } from '../input/actions';
import type { Store } from '../state/store';
import { cssVar, dragTracker, h, setClass, setText } from './dom';
import { Knob } from './knob';
import { Meter } from './meter';

const BANDS: EqBand[] = ['high', 'mid', 'low'];

function formatDb(db: number): string {
  if (db <= EQ_MIN_DB + 0.01) return 'cut';
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

/** Filter knob readout: which filter is engaged and where. */
function formatFilter(position: number): string {
  const { lowpass, highpass } = filterFrequencies(position * 2 - 1);
  const hz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`);
  if (lowpass < FILTER_OPEN_LOW) return `LPF ${hz(lowpass)}`;
  if (highpass > FILTER_OPEN_HIGH) return `HPF ${hz(highpass)}`;
  return 'off';
}

interface ChannelControls {
  trim: Knob;
  autoGain: HTMLElement;
  filter: Knob;
  faderDragging: () => boolean;
  eq: Record<EqBand, Knob>;
  kills: Record<EqBand, HTMLButtonElement>;
  cue: HTMLButtonElement;
  fader: HTMLInputElement;
  meter: Meter;
}

export class MixerView {
  readonly el: HTMLElement;
  private readonly channels: ChannelControls[] = [];
  private readonly masterMeter: Meter;
  private readonly crossfader: HTMLInputElement;
  private readonly crossfaderDragging: () => boolean;
  private readonly limitLed: HTMLElement;
  private readonly autoGainButton: HTMLButtonElement;
  private readonly curveButton: HTMLButtonElement;
  private readonly master: Knob;
  private readonly cueVolume: Knob;
  private readonly cueMode: HTMLSelectElement;
  private readonly cueHint: HTMLElement;

  constructor(
    private readonly engine: AudioEngine,
    mixer: Store<MixerState>,
    actions: Actions,
    decks: DeckController[] = [],
  ) {
    const state = mixer.get();
    const strips = (['A', 'B'] as const).map((id, index) => this.buildChannel(id, index as 0 | 1, state, actions));

    this.master = new Knob({
      label: 'MASTER',
      value: state.master,
      resetTo: 0.8,
      format: (p) => `${Math.round(p * 100)}%`,
      onInput: (p) => actions.trigger('mixer.master', p),
    });
    this.cueVolume = new Knob({
      label: 'CUE VOL',
      value: state.cueVolume,
      resetTo: 0.7,
      format: (p) => `${Math.round(p * 100)}%`,
      onInput: (p) => actions.trigger('mixer.cueVolume', p),
    });
    this.masterMeter = new Meter('Master');
    this.autoGainButton = actions.button(
      'mixer.autoGain',
      h('button', { class: 'btn btn-small btn-autogain', text: 'AUTO GAIN', title: 'Level every track to the same loudness (-10 LUFS), shown under each TRIM', attrs: { type: 'button' } }),
    );
    this.limitLed = h('div', { class: 'limit-led', text: 'LIMIT', title: 'Lights while the master limiter is reducing gain: turn the channels or master down' });

    this.cueMode = h('select', { class: 'cue-mode', title: 'Headphone cue routing', attrs: { 'aria-label': 'Headphone cue routing' } });
    const modes: Array<[CueMode, string]> = [
      ['off', 'Cue off'],
      ['split', 'Split (cue L / master R)'],
      ['quad', engine.supportsQuad ? '4-channel (cue on 3/4)' : '4-channel (device has 2)'],
    ];
    for (const [value, label] of modes) {
      const option = h('option', { text: label, attrs: { value } });
      if (value === 'quad' && !engine.supportsQuad) option.disabled = true;
      this.cueMode.append(option);
    }
    this.cueMode.value = state.cueMode;
    this.cueMode.addEventListener('change', () => mixer.set({ cueMode: this.cueMode.value as CueMode }));
    this.cueHint = h('div', { class: 'cue-hint' });

    this.crossfader = h('input', {
      class: 'crossfader',
      title: 'Crossfader. Double-click centres.',
      attrs: { type: 'range', min: '0', max: '1', step: '0.001', value: String((state.crossfader + 1) / 2), 'aria-label': 'Crossfader' },
    });
    this.crossfaderDragging = dragTracker(this.crossfader);
    this.crossfader.addEventListener('input', () => actions.trigger('mixer.xfader', Number(this.crossfader.value)));
    this.crossfader.addEventListener('dblclick', () => actions.trigger('mixer.xfader.center'));
    this.curveButton = actions.button(
      'mixer.xfader.curve',
      h('button', { class: 'btn btn-small', title: 'Crossfader curve: smooth (equal power) or sharp (scratch cut)', attrs: { type: 'button' } }),
    );

    this.el = h('section', { class: 'mixer', attrs: { 'aria-label': 'Mixer' } }, [
      h('div', { class: 'mixer-strips' }, [
        strips[0],
        h('div', { class: 'master-strip' }, [
          this.master.el,
          h('div', { class: 'master-meter' }, [this.masterMeter.el]),
          this.limitLed,
          this.autoGainButton,
          this.cueVolume.el,
          this.cueMode,
          this.cueHint,
        ]),
        strips[1],
      ]),
      h('div', { class: 'xfader-row' }, [h('span', { class: 'xfader-label', text: 'A' }), this.crossfader, h('span', { class: 'xfader-label', text: 'B' })]),
      h('div', { class: 'xfader-options' }, [this.curveButton]),
    ]);

    mixer.subscribe((s) => this.render(s));
    this.render(state);
    decks.forEach((deck, i) => {
      const show = (): void => this.renderAutoGain(i, deck.state.autoGainDb, deck.loaded, mixer.get().autoGain);
      deck.store.subscribe(show);
      mixer.subscribe(show);
      show();
    });
  }

  private renderAutoGain(index: number, db: number, loaded: boolean, on: boolean): void {
    const el = this.channels[index]?.autoGain;
    if (!el) return;
    const text = !loaded ? 'AUTO --' : `AUTO ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
    setText(el, on ? text : 'AUTO off');
    setClass(el, 'is-off', !on);
  }

  private buildChannel(id: 'A' | 'B', index: 0 | 1, state: MixerState, actions: Actions): HTMLElement {
    const m = `mixer.${id}`;
    const settings = state.channels[index];
    const trim = new Knob({
      label: 'TRIM',
      value: knobFromCenteredDb(settings.trimDb, TRIM_MIN_DB, TRIM_MAX_DB),
      resetTo: 0.5,
      format: (p) => formatDb(centeredDbFromKnob(p, TRIM_MIN_DB, TRIM_MAX_DB)),
      onInput: (p) => actions.trigger(`${m}.trim`, p),
    });
    const autoGain = h('div', { class: 'autogain-readout', text: 'AUTO --', title: 'Gain applied to this track by AUTO GAIN' });
    const accents: Record<EqBand, string> = {
      high: cssVar('--wave-high', '#e8edf5'),
      mid: cssVar('--wave-mid', '#e39b2d'),
      low: cssVar('--wave-low', '#2f6fdf'),
    };
    const eq = {} as Record<EqBand, Knob>;
    const kills = {} as Record<EqBand, HTMLButtonElement>;
    const eqRows = BANDS.map((band) => {
      eq[band] = new Knob({
        label: band.toUpperCase(),
        value: knobFromCenteredDb(settings.eqDb[band], EQ_MIN_DB, EQ_MAX_DB),
        resetTo: 0.5,
        accent: accents[band],
        format: (p) => formatDb(centeredDbFromKnob(p, EQ_MIN_DB, EQ_MAX_DB)),
        onInput: (p) => actions.trigger(`${m}.eq.${band}`, p),
      });
      kills[band] = actions.button(
        `${m}.kill.${band}`,
        h('button', { class: 'btn btn-kill', text: 'KILL', title: `Kill ${band}s on deck ${id}`, attrs: { type: 'button' } }),
      );
      return h('div', { class: 'eq-row' }, [eq[band].el, kills[band]]);
    });
    const cue = actions.button(`${m}.cue`, h('button', { class: 'btn btn-headphone', text: 'CUE', title: `Send deck ${id} to headphones`, attrs: { type: 'button' } }));
    const fader = h('input', {
      class: 'channel-fader',
      title: `Deck ${id} volume. Double-click resets.`,
      attrs: { type: 'range', min: '0', max: '1', step: '0.001', value: String(settings.fader), 'aria-label': `Deck ${id} volume` },
    });
    fader.addEventListener('input', () => actions.trigger(`${m}.fader`, Number(fader.value)));
    fader.addEventListener('dblclick', () => actions.trigger(`${m}.fader`, 0.8));
    const faderDragging = dragTracker(fader);
    const meter = new Meter(`Deck ${id}`);
    const filter = new Knob({
      label: 'FILTER',
      value: (settings.filter + 1) / 2,
      resetTo: 0.5,
      format: formatFilter,
      onInput: (p) => actions.trigger(`${m}.filter`, p),
    });
    filter.el.title = 'Filter: left is low-pass, right is high-pass, centre is off. Double-click resets.';
    this.channels[index] = { trim, autoGain, filter, faderDragging, eq, kills, cue, fader, meter };

    return h('div', { class: `channel-strip channel-${id.toLowerCase()}` }, [
      h('div', { class: 'channel-id', text: id }),
      trim.el,
      autoGain,
      ...eqRows,
      filter.el,
      cue,
      h('div', { class: 'fader-meter' }, [meter.el, fader]),
    ]);
  }

  private render(state: MixerState): void {
    state.channels.forEach((settings, index) => {
      const c = this.channels[index];
      c.trim.setValue(knobFromCenteredDb(settings.trimDb, TRIM_MIN_DB, TRIM_MAX_DB));
      c.filter.setValue((settings.filter + 1) / 2);
      for (const band of BANDS) {
        c.eq[band].setValue(knobFromCenteredDb(settings.eqDb[band], EQ_MIN_DB, EQ_MAX_DB));
        setClass(c.kills[band], 'on', settings.kill[band]);
      }
      setClass(c.cue, 'on', settings.cue);
      setClass(c.cue, 'inactive', state.cueMode === 'off');
      // Synced unless dragged: a focus guard left the thumb behind after a double-click reset.
      if (!c.faderDragging()) c.fader.value = String(settings.fader);
    });
    setClass(this.autoGainButton, 'on', state.autoGain);
    this.master.setValue(state.master);
    this.cueVolume.setValue(state.cueVolume);
    if (!this.crossfaderDragging()) this.crossfader.value = String((state.crossfader + 1) / 2);
    this.curveButton.textContent = state.curve === 'smooth' ? 'Curve: smooth' : 'Curve: sharp';
    this.cueMode.value = state.cueMode;
    const anyCue = state.channels.some((c) => c.cue);
    this.cueHint.textContent = state.cueMode === 'off' && anyCue ? 'Choose a cue mode to hear CUE' : '';
  }

  /** Per-frame meter update. */
  frame(): void {
    this.channels.forEach((c, i) => c.meter.update(this.engine.meter(this.engine.strips[i].analyser)));
    const master = this.engine.meter(this.engine.masterAnalyser);
    this.masterMeter.update(master);
    // The meter is post-limiter, so it never shows an over: this does. Only
    // while there is signal: the compressor stops updating its reduction
    // reading once its input goes silent, leaving the last value stuck.
    setClass(this.limitLed, 'on', master.peak > 0.05 && this.engine.limiterReduction < -1);
  }
}
