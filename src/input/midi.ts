/**
 * Web MIDI: a default DDJ-style mapping, 14-bit controls, jog wheels, a
 * SHIFT layer, LED feedback, and a learn hook for user mappings.
 *
 * The default map follows the common Pioneer DDJ layout (deck A on MIDI
 * channel 1, deck B on channel 2). It has not been verified on hardware; the
 * status line shows every incoming message so a mismatch is easy to see, and
 * MIDI learn can remap anything.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (14-bit CC pairs, jog wheels, shift layer, LED
 *   output, learn hook)
 * Modified: Sep-26-2026 (14-bit controls, jog wheels, SHIFT layer, LED
 *   feedback; dialogue pad and MIC LEDs: lit with a clip, blinking while
 *   playing; MIC lit while live)
 */
import { Store } from '../state/store';
import type { Actions } from './actions';

/**
 * How a control's value reaches its action:
 * - button:   note on = 1, note off = 0
 * - absolute: CC 0..1 (a 14-bit pair when the controller sends CC+32 too)
 * - relative: CC centred on 64, sent as signed ticks (jog wheels)
 */
export type MidiMode = 'button' | 'absolute' | 'relative';

export interface MidiBinding {
  kind: 'note' | 'cc';
  /** MIDI channel, 0-based. */
  channel: number;
  number: number;
  action: string;
  mode?: MidiMode;
  /** Only while a SHIFT control is held. */
  shift?: boolean;
}

/** Note that acts as SHIFT on the DDJ layout (per deck channel). */
const SHIFT_NOTE = 0x3f;

function deckBindings(deck: 'A' | 'B', channel: number, padChannel: number, shiftPadChannel: number): MidiBinding[] {
  const d = `deck.${deck}`;
  const m = `mixer.${deck}`;
  const bindings: MidiBinding[] = [
    { kind: 'note', channel, number: 0x0b, action: `${d}.play` },
    { kind: 'note', channel, number: 0x0c, action: `${d}.cue` },
    { kind: 'note', channel, number: 0x58, action: `${d}.sync` },
    { kind: 'note', channel, number: 0x58, action: `${d}.keylock`, shift: true },
    { kind: 'note', channel, number: 0x10, action: `${d}.loop.in` },
    { kind: 'note', channel, number: 0x11, action: `${d}.loop.out` },
    { kind: 'note', channel, number: 0x4d, action: `${d}.loop.toggle` },
    { kind: 'note', channel, number: 0x54, action: `${m}.cue` },
    { kind: 'note', channel, number: 0x36, action: `${d}.jog.touch` },
    { kind: 'cc', channel, number: 0x22, action: `${d}.jog.top`, mode: 'relative' },
    { kind: 'cc', channel, number: 0x21, action: `${d}.jog.side`, mode: 'relative' },
    { kind: 'cc', channel, number: 0x00, action: `${d}.tempo`, mode: 'absolute' },
    { kind: 'cc', channel, number: 0x04, action: `${m}.trim`, mode: 'absolute' },
    { kind: 'cc', channel, number: 0x07, action: `${m}.eq.high`, mode: 'absolute' },
    { kind: 'cc', channel, number: 0x0b, action: `${m}.eq.mid`, mode: 'absolute' },
    { kind: 'cc', channel, number: 0x0f, action: `${m}.eq.low`, mode: 'absolute' },
    { kind: 'cc', channel, number: 0x13, action: `${m}.fader`, mode: 'absolute' },
  ];
  for (let pad = 0; pad < 8; pad++) {
    bindings.push(
      { kind: 'note', channel: padChannel, number: pad, action: `${d}.hotcue.${pad + 1}` },
      { kind: 'note', channel: shiftPadChannel, number: pad, action: `${d}.hotcue.${pad + 1}.clear` },
    );
  }
  return bindings;
}

export const DEFAULT_MIDI_MAP: MidiBinding[] = [
  ...deckBindings('A', 0, 7, 8),
  ...deckBindings('B', 1, 9, 10),
  { kind: 'cc', channel: 6, number: 0x1f, action: 'mixer.xfader', mode: 'absolute' },
  { kind: 'cc', channel: 6, number: 0x17, action: 'mixer.A.filter', mode: 'absolute' },
  { kind: 'cc', channel: 6, number: 0x18, action: 'mixer.B.filter', mode: 'absolute' },
];

/** Half a blink cycle, ms, for a flashing LED (the waveform's end warning uses the same). */
export const LED_BLINK_MS = 400;

/**
 * LED states for the dialogue pads and the mic, in the shape `setLedSource`
 * takes. LEDs are on/off only, so a pad with a clip is lit, a playing pad (on
 * the master or previewing in the headphones) blinks, and an empty pad is
 * dark. MIC is lit while the mic is live.
 *
 * @param pads   pad states in pad order (pad 1 first).
 * @param micLive whether the mic is on air.
 * @param now    clock in ms (performance.now()), which drives the blink.
 * @returns action name -> lit, for `sampler.pad1..8` and `sampler.mic`.
 */
export function samplerLeds(pads: readonly { title: string | null; playing: boolean }[], micLive: boolean, now: number): Map<string, boolean> {
  const lit = new Map<string, boolean>();
  const blinkOn = Math.floor(now / LED_BLINK_MS) % 2 === 0;
  pads.forEach((pad, i) => lit.set(`sampler.pad${i + 1}`, pad.title !== null && (!pad.playing || blinkOn)));
  lit.set('sampler.mic', micLive);
  return lit;
}

/** A decoded MIDI message. */
export interface MidiMessage {
  kind: 'note' | 'cc';
  channel: number;
  number: number;
  value: number;
  /** Note on with velocity > 0. */
  pressed: boolean;
}

/** Decode note on/off and CC; null for anything else (clock, sysex, pitch bend). */
export function decodeMidi(data: ArrayLike<number>): MidiMessage | null {
  if (data.length < 3) return null;
  const type = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  if (type === 0x90 || type === 0x80) return { kind: 'note', channel, number: data[1], value: data[2], pressed: type === 0x90 && data[2] > 0 };
  if (type === 0xb0) return { kind: 'cc', channel, number: data[1], value: data[2], pressed: false };
  return null;
}

/** Signed ticks from a relative (64-centred) CC value. */
export function relativeTicks(value: number): number {
  return value - 64;
}

export interface MidiState {
  enabled: boolean;
  /** Always-visible description: inputs found, last message, or the error. */
  status: string;
}

const key = (b: { kind: string; channel: number; number: number }, shift = false): string => `${b.kind}:${b.channel}:${b.number}${shift ? ':shift' : ''}`;

export class MidiInput {
  readonly store = new Store<MidiState>({ enabled: false, status: 'MIDI off' });
  private map = new Map<string, MidiBinding>();
  private bindings: MidiBinding[] = [];
  /** Last MSB per absolute CC, for 14-bit pairing with CC+32. */
  private readonly msb = new Map<string, number>();
  private readonly shiftHeld = new Set<number>();
  private outputs: MIDIOutput[] = [];
  private readonly ledState = new Map<string, boolean>();
  private ledSource: (() => Map<string, boolean>) | null = null;
  private ledTimer: ReturnType<typeof setInterval> | undefined;
  /** When set, the next control moved is handed here instead of triggering (MIDI learn). */
  private learner: ((message: MidiMessage) => void) | null = null;

  constructor(
    private readonly actions: Actions,
    bindings: MidiBinding[] = DEFAULT_MIDI_MAP,
  ) {
    this.setBindings(bindings);
  }

  static supported(): boolean {
    return typeof navigator.requestMIDIAccess === 'function';
  }

  setBindings(bindings: MidiBinding[]): void {
    this.bindings = bindings;
    this.map = new Map(bindings.map((b) => [key(b, b.shift), b]));
    this.ledState.clear();
  }

  get currentBindings(): MidiBinding[] {
    return this.bindings;
  }

  /** Hand the next control moved to `callback` (for MIDI learn); null cancels. */
  learnNext(callback: ((message: MidiMessage) => void) | null): void {
    this.learner = callback;
  }

  /**
   * Light controller LEDs from app state: `source` returns action name ->
   * lit. Only changes are sent, to every output sharing a name with an input.
   */
  setLedSource(source: () => Map<string, boolean>): void {
    this.ledSource = source;
  }

  async enable(): Promise<void> {
    if (!MidiInput.supported()) {
      this.store.set({ status: 'This browser has no Web MIDI' });
      return;
    }
    this.store.set({ status: 'Asking for MIDI access...' });
    let access: MIDIAccess;
    try {
      access = await navigator.requestMIDIAccess();
    } catch (error) {
      this.store.set({ status: `MIDI blocked: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const attach = (): void => {
      const inputs = Array.from(access.inputs.values());
      for (const input of inputs) input.onmidimessage = (event) => event.data && this.handleMessage(event.data);
      const names = new Set(inputs.map((i) => i.name));
      this.outputs = Array.from(access.outputs.values()).filter((o) => names.has(o.name));
      this.ledState.clear();
      this.store.set({
        enabled: true,
        status: inputs.length ? `MIDI: ${inputs.map((i) => i.name ?? 'input').join(', ')}` : 'MIDI on, no controller connected',
      });
    };
    access.onstatechange = attach;
    attach();
    clearInterval(this.ledTimer);
    this.ledTimer = setInterval(() => this.updateLeds(), 100);
  }

  /** Send changed LED states (note on 127 = lit, 0 = dark). */
  updateLeds(send: (bytes: number[]) => void = (bytes) => this.outputs.forEach((o) => o.send(bytes))): void {
    const source = this.ledSource?.();
    if (!source) return;
    for (const b of this.bindings) {
      if (b.kind !== 'note' || b.shift) continue;
      const lit = source.get(b.action);
      if (lit === undefined) continue;
      const k = key(b);
      if (this.ledState.get(k) === lit) continue;
      this.ledState.set(k, lit);
      send([0x90 | b.channel, b.number, lit ? 127 : 0]);
    }
  }

  /** Which binding a message triggers and with what value. */
  private resolve(message: MidiMessage, shift: boolean): { binding: MidiBinding | undefined; actionValue: number; detail: string } {
    const { kind, number, value, pressed } = message;
    const binding = (shift ? this.map.get(key(message, true)) : undefined) ?? this.map.get(key(message));
    if (kind === 'note') return { binding, actionValue: pressed ? 1 : 0, detail: pressed ? ' on' : ' off' };
    if (!binding && number >= 0x20 && number < 0x40) return this.resolveLsb(message);
    if (binding?.mode === 'relative') return { binding, actionValue: relativeTicks(value), detail: ` = ${value}` };
    this.msb.set(key(message), value);
    return { binding, actionValue: value / 127, detail: ` = ${value}` };
  }

  /** CC+32 is the low 7 bits of a 14-bit control whose MSB came first. */
  private resolveLsb(message: MidiMessage): { binding: MidiBinding | undefined; actionValue: number; detail: string } {
    const base = { kind: message.kind, channel: message.channel, number: message.number - 0x20 };
    const pair = this.map.get(key(base));
    const high = this.msb.get(key(base));
    if (!pair || (pair.mode ?? 'absolute') !== 'absolute' || high === undefined) return { binding: undefined, actionValue: 0, detail: ` = ${message.value}` };
    const combined = high * 128 + message.value;
    return { binding: pair, actionValue: combined / 16383, detail: ` = ${combined} (14-bit)` };
  }

  /** Handle one raw MIDI message (public for tests and diagnostics). */
  handleMessage(data: ArrayLike<number>): void {
    const message = decodeMidi(data);
    if (!message) return;
    const { kind, channel, number, pressed } = message;

    if (kind === 'note' && number === SHIFT_NOTE) {
      if (pressed) this.shiftHeld.add(channel);
      else this.shiftHeld.delete(channel);
      this.store.set({ status: `MIDI SHIFT ${pressed ? 'held' : 'released'} (ch${channel + 1})` });
      return;
    }
    if (this.learner && (kind === 'cc' || pressed)) {
      const learn = this.learner;
      this.learner = null;
      learn(message);
      return;
    }

    const shift = this.shiftHeld.has(channel);
    const { binding, actionValue, detail } = this.resolve(message, shift);
    const hex = number.toString(16).padStart(2, '0');
    const label = `ch${channel + 1} ${kind} 0x${hex}${detail}${shift ? ' +shift' : ''}`;
    this.store.set({ status: binding ? `MIDI ${label}: ${binding.action}` : `MIDI ${label}: not mapped` });
    if (binding) this.actions.trigger(binding.action, actionValue);
  }
}
