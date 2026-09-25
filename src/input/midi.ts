/**
 * Web MIDI input with a fixed default mapping.
 *
 * The default map follows the common Pioneer DDJ layout (deck A on MIDI
 * channel 1, deck B on channel 2). It has not been verified on hardware; the
 * status line shows every incoming message so a mismatch is easy to see.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { Store } from '../state/store';
import type { Actions } from './actions';

export interface MidiBinding {
  kind: 'note' | 'cc';
  /** MIDI channel, 0-based. */
  channel: number;
  number: number;
  action: string;
}

function deckBindings(deck: 'A' | 'B', channel: number, padChannel: number): MidiBinding[] {
  const d = `deck.${deck}`;
  const m = `mixer.${deck}`;
  const bindings: MidiBinding[] = [
    { kind: 'note', channel, number: 0x0b, action: `${d}.play` },
    { kind: 'note', channel, number: 0x0c, action: `${d}.cue` },
    { kind: 'note', channel, number: 0x58, action: `${d}.sync` },
    { kind: 'note', channel, number: 0x10, action: `${d}.loop.in` },
    { kind: 'note', channel, number: 0x11, action: `${d}.loop.out` },
    { kind: 'note', channel, number: 0x4d, action: `${d}.loop.toggle` },
    { kind: 'note', channel, number: 0x54, action: `${m}.cue` },
    { kind: 'cc', channel, number: 0x00, action: `${d}.tempo` },
    { kind: 'cc', channel, number: 0x04, action: `${m}.trim` },
    { kind: 'cc', channel, number: 0x07, action: `${m}.eq.high` },
    { kind: 'cc', channel, number: 0x0b, action: `${m}.eq.mid` },
    { kind: 'cc', channel, number: 0x0f, action: `${m}.eq.low` },
    { kind: 'cc', channel, number: 0x13, action: `${m}.fader` },
  ];
  for (let pad = 0; pad < 8; pad++) bindings.push({ kind: 'note', channel: padChannel, number: pad, action: `${d}.hotcue.${pad + 1}` });
  return bindings;
}

export const DEFAULT_MIDI_MAP: MidiBinding[] = [
  ...deckBindings('A', 0, 7),
  ...deckBindings('B', 1, 9),
  { kind: 'cc', channel: 6, number: 0x1f, action: 'mixer.xfader' },
];

export interface MidiState {
  enabled: boolean;
  /** Always-visible description: inputs found, last message, or the error. */
  status: string;
}

export class MidiInput {
  readonly store = new Store<MidiState>({ enabled: false, status: 'MIDI off' });
  private readonly map = new Map<string, MidiBinding>();

  constructor(
    private readonly actions: Actions,
    bindings: MidiBinding[] = DEFAULT_MIDI_MAP,
  ) {
    for (const b of bindings) this.map.set(`${b.kind}:${b.channel}:${b.number}`, b);
  }

  static supported(): boolean {
    return typeof navigator.requestMIDIAccess === 'function';
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
      for (const input of inputs) input.onmidimessage = (event) => this.onMessage(event);
      this.store.set({
        enabled: true,
        status: inputs.length ? `MIDI: ${inputs.map((i) => i.name ?? 'input').join(', ')}` : 'MIDI on, no controller connected',
      });
    };
    access.onstatechange = attach;
    attach();
  }

  private onMessage(event: MIDIMessageEvent): void {
    const data = event.data;
    if (!data || data.length < 3) return;
    const type = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const number = data[1];
    const value = data[2];
    let kind: 'note' | 'cc' | null = null;
    let actionValue = 0;
    if (type === 0x90 || type === 0x80) {
      kind = 'note';
      actionValue = type === 0x90 && value > 0 ? 1 : 0;
    } else if (type === 0xb0) {
      kind = 'cc';
      actionValue = value / 127;
    }
    if (!kind) return;
    const binding = this.map.get(`${kind}:${channel}:${number}`);
    const hex = number.toString(16).padStart(2, '0');
    let detail = ` = ${value}`;
    if (kind === 'note') detail = actionValue ? ' on' : ' off';
    const label = `ch${channel + 1} ${kind} 0x${hex}${detail}`;
    this.store.set({ status: binding ? `MIDI ${label}: ${binding.action}` : `MIDI ${label}: not mapped` });
    if (binding) this.actions.trigger(binding.action, actionValue);
  }
}
