/**
 * Every named action the app responds to.
 *
 * Naming: `deck.<A|B>.<verb>` and `mixer.<A|B|master|xfader>.<control>`.
 * Continuous controls take a 0..1 value, so MIDI and the UI share one scale.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (hold CUE and hot cues, BPM x2 / /2, filter)
 */
import { HOT_CUE_COUNT, LOOP_SIZES, type DeckController } from '../audio/deck-controller';
import { EQ_MAX_DB, EQ_MIN_DB, TRIM_MAX_DB, TRIM_MIN_DB, type ChannelSettings, type EqBand, type MixerState } from '../audio/mixer';
import { FX_BEATS, FX_TYPES } from '../audio/effects';
import { centeredDbFromKnob } from '../audio/mixer-math';
import type { SyncCoordinator } from '../audio/sync-coordinator';
import type { Store } from '../state/store';
import type { Actions } from './actions';

/** Crossfader step for keyboard nudges. */
const XFADER_STEP = 0.1;

export function updateChannel(mixer: Store<MixerState>, index: 0 | 1, patch: (c: ChannelSettings) => ChannelSettings): void {
  const channels = mixer.get().channels.slice() as MixerState['channels'];
  channels[index] = patch(channels[index]);
  mixer.set({ channels });
}

export function registerActions(actions: Actions, decks: [DeckController, DeckController], sync: SyncCoordinator, mixer: Store<MixerState>): void {
  decks.forEach((deck, index) => {
    const d = `deck.${deck.id}`;
    const press = (name: string, fn: () => void): void => actions.register(`${d}.${name}`, (v) => v > 0 && fn());

    press('play', () => deck.togglePlay());
    // CUE and hot cues are hold actions: CDJ-style preview while held.
    actions.register(`${d}.cue`, (v) => (v > 0 ? deck.cueDown() : deck.cueUp()));
    press('sync', () => sync.toggle(deck));
    press('quantize', () => deck.toggleQuantize());
    press('lock', () => deck.toggleLock());
    press('keylock', () => deck.toggleKeyLock());
    press('range', () => deck.cycleTempoRange());
    press('tempo.reset', () => deck.resetTempo());
    press('loop.toggle', () => deck.toggleLoop());
    press('loop.auto', () => deck.autoLoop());
    press('loop.in', () => deck.loopInPoint());
    press('loop.out', () => deck.loopOutPoint());
    press('loop.halve', () => deck.resizeLoop(0.5));
    press('loop.double', () => deck.resizeLoop(2));
    press('jump.back', () => deck.beatJump(-1));
    press('jump.forward', () => deck.beatJump(1));
    press('bpm.double', () => deck.scaleBpm(2));
    press('tap', () => deck.tap());
    press('grid.earlier', () => deck.nudgeGrid(-5));
    press('grid.later', () => deck.nudgeGrid(5));
    press('grid.here', () => deck.setBeatHere());
    press('bpm.halve', () => deck.scaleBpm(0.5));
    for (const size of LOOP_SIZES) press(`loop.${size}`, () => deck.autoLoop(size));
    for (let i = 0; i < HOT_CUE_COUNT; i++) {
      actions.register(`${d}.hotcue.${i + 1}`, (v) => (v > 0 ? deck.hotCueDown(i) : deck.hotCueUp(i)));
      press(`hotcue.${i + 1}.clear`, () => deck.clearHotCue(i));
    }
    // Jog wheel: touch is a hold, top and side carry signed ticks.
    actions.register(`${d}.jog.touch`, (v) => deck.jogTouch(v > 0));
    actions.register(`${d}.jog.top`, (v) => deck.jogTop(v));
    actions.register(`${d}.jog.side`, (v) => deck.jogSide(v));
    // Hold actions: 1 on press, 0 on release.
    actions.register(`${d}.bend.down`, (v) => deck.bend(v > 0 ? -1 : 0));
    actions.register(`${d}.bend.up`, (v) => deck.bend(v > 0 ? 1 : 0));
    // Tempo fader: 0..1 across the current range, 0.5 = no change.
    actions.register(`${d}.tempo`, (v) => deck.setTempo((v * 2 - 1) * deck.state.tempoRange));

    const ch = index as 0 | 1;
    const m = `mixer.${deck.id}`;
    actions.register(`${m}.fader`, (v) => updateChannel(mixer, ch, (c) => ({ ...c, fader: v })));
    actions.register(`${m}.trim`, (v) => updateChannel(mixer, ch, (c) => ({ ...c, trimDb: centeredDbFromKnob(v, TRIM_MIN_DB, TRIM_MAX_DB) })));
    // Effect unit: on/off, type and beat division cycle, amount 0..1.
    const fx = (change: (f: ChannelSettings['fx']) => ChannelSettings['fx']): void => updateChannel(mixer, ch, (c) => ({ ...c, fx: change(c.fx) }));
    actions.register(`${m}.fx.toggle`, (v) => v > 0 && fx((f) => ({ ...f, on: !f.on })));
    actions.register(`${m}.fx.type`, (v) => v > 0 && fx((f) => ({ ...f, type: FX_TYPES[(FX_TYPES.indexOf(f.type) + 1) % FX_TYPES.length] })));
    actions.register(`${m}.fx.beats`, (v) => v > 0 && fx((f) => ({ ...f, beats: FX_BEATS[(FX_BEATS.indexOf(f.beats as (typeof FX_BEATS)[number]) + 1) % FX_BEATS.length] })));
    actions.register(`${m}.fx.amount`, (v) => fx((f) => ({ ...f, amount: v })));
    // Filter knob: 0..1, 0.5 = off (see filterFrequencies).
    actions.register(`${m}.filter`, (v) => updateChannel(mixer, ch, (c) => ({ ...c, filter: v * 2 - 1 })));
    actions.register(`${m}.cue`, (v) => v > 0 && updateChannel(mixer, ch, (c) => ({ ...c, cue: !c.cue })));
    for (const band of ['high', 'mid', 'low'] as EqBand[]) {
      actions.register(`${m}.eq.${band}`, (v) =>
        updateChannel(mixer, ch, (c) => ({ ...c, eqDb: { ...c.eqDb, [band]: centeredDbFromKnob(v, EQ_MIN_DB, EQ_MAX_DB) } })),
      );
      actions.register(`${m}.kill.${band}`, (v) =>
        v > 0 && updateChannel(mixer, ch, (c) => ({ ...c, kill: { ...c.kill, [band]: !c.kill[band] } })),
      );
    }
  });

  actions.register('mixer.xfader', (v) => mixer.set({ crossfader: v * 2 - 1 }));
  actions.register('mixer.xfader.left', (v) => v > 0 && mixer.set({ crossfader: Math.max(-1, mixer.get().crossfader - XFADER_STEP) }));
  actions.register('mixer.xfader.right', (v) => v > 0 && mixer.set({ crossfader: Math.min(1, mixer.get().crossfader + XFADER_STEP) }));
  actions.register('mixer.xfader.center', (v) => v > 0 && mixer.set({ crossfader: 0 }));
  actions.register('mixer.xfader.curve', (v) => v > 0 && mixer.set({ curve: mixer.get().curve === 'smooth' ? 'sharp' : 'smooth' }));
  actions.register('mixer.master', (v) => mixer.set({ master: v }));
  actions.register('mixer.autoGain', (v) => v > 0 && mixer.set({ autoGain: !mixer.get().autoGain }));
  actions.register('mixer.cueVolume', (v) => mixer.set({ cueVolume: v }));
  actions.register('mixer.cueMix', (v) => mixer.set({ cueMix: v }));
}
