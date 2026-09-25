/**
 * Every named action the app responds to.
 *
 * Naming: `deck.<A|B>.<verb>` and `mixer.<A|B|master|xfader>.<control>`.
 * Continuous controls take a 0..1 value, so MIDI and the UI share one scale.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { HOT_CUE_COUNT, LOOP_SIZES, type DeckController } from '../audio/deck-controller';
import { EQ_MAX_DB, EQ_MIN_DB, TRIM_MAX_DB, TRIM_MIN_DB, type ChannelSettings, type EqBand, type MixerState } from '../audio/mixer';
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
    press('cue', () => deck.cue());
    press('sync', () => sync.toggle(deck));
    press('quantize', () => deck.toggleQuantize());
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
    for (const size of LOOP_SIZES) press(`loop.${size}`, () => deck.autoLoop(size));
    for (let i = 0; i < HOT_CUE_COUNT; i++) {
      press(`hotcue.${i + 1}`, () => deck.hotCue(i));
      press(`hotcue.${i + 1}.clear`, () => deck.clearHotCue(i));
    }
    // Hold actions: 1 on press, 0 on release.
    actions.register(`${d}.bend.down`, (v) => deck.bend(v > 0 ? -1 : 0));
    actions.register(`${d}.bend.up`, (v) => deck.bend(v > 0 ? 1 : 0));
    // Tempo fader: 0..1 across the current range, 0.5 = no change.
    actions.register(`${d}.tempo`, (v) => deck.setTempo((v * 2 - 1) * deck.state.tempoRange));

    const ch = index as 0 | 1;
    const m = `mixer.${deck.id}`;
    actions.register(`${m}.fader`, (v) => updateChannel(mixer, ch, (c) => ({ ...c, fader: v })));
    actions.register(`${m}.trim`, (v) => updateChannel(mixer, ch, (c) => ({ ...c, trimDb: centeredDbFromKnob(v, TRIM_MIN_DB, TRIM_MAX_DB) })));
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
  actions.register('mixer.cueVolume', (v) => mixer.set({ cueVolume: v }));
}
