/**
 * MIDI decoding, 14-bit pairing, relative jogs, shift layer, LED output.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (dialogue pad and MIC LEDs)
 */
import { describe, expect, it } from 'vitest';
import { Actions } from '../src/input/actions';
import { decodeMidi, DEFAULT_MIDI_MAP, LED_BLINK_MS, MidiInput, relativeTicks, samplerLeds, type MidiBinding } from '../src/input/midi';
import { learnBinding } from '../src/ui/midi-learn-view';

function harness(bindings?: MidiBinding[]) {
  const actions = new Actions();
  const calls: Array<[string, number]> = [];
  for (const name of ['deck.A.tempo', 'deck.A.play', 'deck.A.sync', 'deck.A.keylock', 'deck.A.jog.top', 'deck.A.hotcue.1', 'deck.A.hotcue.1.clear', 'mixer.A.fader']) {
    actions.register(name, (v) => calls.push([name, v]));
  }
  const midi = new MidiInput(actions, bindings);
  return { midi, calls };
}

describe('decodeMidi', () => {
  it('decodes notes (note on with velocity 0 is an off) and CCs', () => {
    expect(decodeMidi([0x91, 0x0b, 127])).toEqual({ kind: 'note', channel: 1, number: 0x0b, value: 127, pressed: true });
    expect(decodeMidi([0x90, 0x0b, 0])?.pressed).toBe(false);
    expect(decodeMidi([0x80, 0x0b, 64])?.pressed).toBe(false);
    expect(decodeMidi([0xb6, 0x1f, 100])).toMatchObject({ kind: 'cc', channel: 6, number: 0x1f, value: 100 });
    expect(decodeMidi([0xf8, 0, 0])).toBeNull();
    expect(decodeMidi([0x90, 1])).toBeNull();
  });

  it('reads relative jog ticks around 64', () => {
    expect(relativeTicks(65)).toBe(1);
    expect(relativeTicks(60)).toBe(-4);
  });
});

describe('MidiInput', () => {
  it('pairs an MSB with its CC+32 LSB into 14 bits', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0xb0, 0x00, 64]);
    midi.handleMessage([0xb0, 0x20, 1]);
    expect(calls[0]).toEqual(['deck.A.tempo', 64 / 127]);
    expect(calls[1][0]).toBe('deck.A.tempo');
    expect(calls[1][1]).toBeCloseTo((64 * 128 + 1) / 16383, 9);
  });

  it('sends jog wheels as signed ticks', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0xb0, 0x22, 67]);
    midi.handleMessage([0xb0, 0x22, 61]);
    expect(calls).toEqual([
      ['deck.A.jog.top', 3],
      ['deck.A.jog.top', -3],
    ]);
  });

  it('uses the shift layer while SHIFT is held', () => {
    const { midi, calls } = harness();
    midi.handleMessage([0x90, 0x58, 127]);
    midi.handleMessage([0x90, 0x3f, 127]);
    midi.handleMessage([0x90, 0x58, 127]);
    midi.handleMessage([0x90, 0x3f, 0]);
    expect(calls.map((c) => c[0])).toEqual(['deck.A.sync', 'deck.A.keylock']);
  });

  it('hands the next control to MIDI learn instead of triggering', () => {
    const { midi, calls } = harness();
    let learned: unknown = null;
    midi.learnNext((m) => (learned = m));
    midi.handleMessage([0x92, 0x40, 127]);
    expect(learned).toMatchObject({ kind: 'note', channel: 2, number: 0x40 });
    expect(calls).toEqual([]);
  });

  it('sends only changed LED states', () => {
    const { midi } = harness();
    const sent: number[][] = [];
    let playing = true;
    midi.setLedSource(() => new Map([['deck.A.play', playing]]));
    midi.updateLeds((b) => sent.push(b));
    midi.updateLeds((b) => sent.push(b));
    playing = false;
    midi.updateLeds((b) => sent.push(b));
    expect(sent).toEqual([
      [0x90, 0x0b, 127],
      [0x90, 0x0b, 0],
    ]);
  });
});

describe('samplerLeds', () => {
  const pad = (title: string | null, playing = false) => ({ title, playing });

  it('lights pads with a clip, leaves empty pads dark, and lights MIC while live', () => {
    const lit = samplerLeds([pad('Intro'), pad(null), pad('Drop')], true, 0);
    expect(lit.get('sampler.pad1')).toBe(true);
    expect(lit.get('sampler.pad2')).toBe(false);
    expect(lit.get('sampler.pad3')).toBe(true);
    expect(lit.get('sampler.mic')).toBe(true);
    expect(samplerLeds([pad('Intro')], false, 0).get('sampler.mic')).toBe(false);
  });

  it('blinks a playing pad and keeps a loaded pad steady', () => {
    const at = (now: number) => samplerLeds([pad('Intro', true), pad('Drop')], false, now);
    expect(at(0).get('sampler.pad1')).toBe(true);
    expect(at(LED_BLINK_MS).get('sampler.pad1')).toBe(false);
    expect(at(2 * LED_BLINK_MS).get('sampler.pad1')).toBe(true);
    expect(at(LED_BLINK_MS).get('sampler.pad2')).toBe(true);
  });

  it('drives learned pad and MIC notes through the LED diffing', () => {
    const actions = new Actions();
    let bindings = learnBinding([], 'sampler.pad1', { kind: 'note', channel: 5, number: 0x20, value: 127, pressed: true }, 'button');
    bindings = learnBinding(bindings, 'sampler.mic', { kind: 'note', channel: 5, number: 0x28, value: 127, pressed: true }, 'button');
    const midi = new MidiInput(actions, bindings);
    const sent: number[][] = [];
    const state = { title: null as string | null, playing: false, live: false, now: 0 };
    midi.setLedSource(() => samplerLeds([pad(state.title, state.playing)], state.live, state.now));
    const step = (change: Partial<typeof state>) => {
      Object.assign(state, change);
      midi.updateLeds((b) => sent.push(b));
    };
    step({});
    step({ title: 'Intro' });
    step({ playing: true, now: LED_BLINK_MS });
    step({ now: 2 * LED_BLINK_MS });
    step({ now: 2 * LED_BLINK_MS + 50 });
    step({ live: true });
    step({ playing: false, live: false });
    expect(sent).toEqual([
      [0x95, 0x20, 0],
      [0x95, 0x28, 0],
      [0x95, 0x20, 127],
      [0x95, 0x20, 0],
      [0x95, 0x20, 127],
      [0x95, 0x28, 127],
      [0x95, 0x28, 0],
    ]);
  });
});

describe('learnBinding', () => {
  it('rebinds an action, frees the control from others, and keeps shift bindings', () => {
    const learned = learnBinding(DEFAULT_MIDI_MAP, 'deck.A.play', { kind: 'note', channel: 0, number: 0x0c, value: 127, pressed: true }, 'button');
    const play = learned.filter((b) => b.action === 'deck.A.play');
    expect(play).toEqual([{ kind: 'note', channel: 0, number: 0x0c, action: 'deck.A.play', mode: 'button' }]);
    // 0x0C was CUE: that control now plays, so CUE lost it.
    expect(learned.some((b) => b.action === 'deck.A.cue' && b.number === 0x0c && b.channel === 0)).toBe(false);
    expect(learned.some((b) => b.action === 'deck.A.keylock' && b.shift)).toBe(true);
  });

  it('learns a CC as absolute, or relative for jog actions', () => {
    const cc = { kind: 'cc' as const, channel: 3, number: 0x30, value: 10, pressed: false };
    expect(learnBinding([], 'mixer.A.fader', cc, 'absolute')[0].mode).toBe('absolute');
    expect(learnBinding([], 'deck.A.jog.top', cc, 'relative')[0].mode).toBe('relative');
    expect(learnBinding([], 'deck.A.play', cc, 'button')[0].mode).toBe('absolute');
  });
});
