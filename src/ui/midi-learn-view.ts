/**
 * MIDI learn: map any controller control to any action, saved in the
 * browser, with JSON export and import.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (dialogue pads, level and mic are learnable)
 */
import { getSetting, setSetting } from '../library/db';
import { DEFAULT_MIDI_MAP, type MidiBinding, type MidiInput, type MidiMessage, type MidiMode } from '../input/midi';
import { h, setText } from './dom';

interface Learnable {
  action: string;
  label: string;
  group: string;
  mode: MidiMode;
}

const MAP_KEY = 'midiMap';

function learnables(): Learnable[] {
  const list: Learnable[] = [];
  for (const deck of ['A', 'B'] as const) {
    const group = `Deck ${deck}`;
    const d = `deck.${deck}`;
    const m = `mixer.${deck}`;
    const add = (action: string, label: string, mode: MidiMode = 'button'): void => void list.push({ action, label, group, mode });
    add(`${d}.play`, 'Play / pause');
    add(`${d}.cue`, 'Cue');
    add(`${d}.sync`, 'Sync');
    add(`${d}.keylock`, 'Key lock');
    add(`${d}.tempo`, 'Tempo fader', 'absolute');
    add(`${d}.jog.touch`, 'Jog touch');
    add(`${d}.jog.top`, 'Jog wheel (top)', 'relative');
    add(`${d}.jog.side`, 'Jog wheel (rim)', 'relative');
    for (let i = 1; i <= 8; i++) add(`${d}.hotcue.${i}`, `Hot cue ${i}`);
    add(`${d}.loop.4`, 'Auto loop 4');
    add(`${d}.loop.toggle`, 'Loop on / off');
    add(`${d}.loop.in`, 'Loop in');
    add(`${d}.loop.out`, 'Loop out');
    add(`${d}.jump.back`, 'Beat jump back');
    add(`${d}.jump.forward`, 'Beat jump forward');
    add(`${m}.fader`, 'Channel fader', 'absolute');
    add(`${m}.trim`, 'Trim', 'absolute');
    add(`${m}.eq.high`, 'EQ high', 'absolute');
    add(`${m}.eq.mid`, 'EQ mid', 'absolute');
    add(`${m}.eq.low`, 'EQ low', 'absolute');
    add(`${m}.filter`, 'Filter', 'absolute');
    add(`${m}.cue`, 'Headphone cue');
    add(`${m}.fx.toggle`, 'FX on / off');
    add(`${m}.fx.amount`, 'FX amount', 'absolute');
  }
  list.push({ action: 'mixer.xfader', label: 'Crossfader', group: 'Mixer', mode: 'absolute' });
  list.push({ action: 'mixer.master', label: 'Master level', group: 'Mixer', mode: 'absolute' });
  list.push({ action: 'mixer.cueVolume', label: 'Headphone level', group: 'Mixer', mode: 'absolute' });
  list.push({ action: 'mixer.cueMix', label: 'Cue mix', group: 'Mixer', mode: 'absolute' });
  for (let i = 1; i <= 8; i++) list.push({ action: `sampler.pad${i}`, label: `Pad ${i}`, group: 'Dialogues', mode: 'button' });
  list.push({ action: 'sampler.stop', label: 'Stop all', group: 'Dialogues', mode: 'button' });
  list.push({ action: 'sampler.level', label: 'Dialogue level', group: 'Dialogues', mode: 'absolute' });
  list.push({ action: 'sampler.mic', label: 'Mic (hold to talk)', group: 'Dialogues', mode: 'button' });
  return list;
}

export function describeBinding(b: MidiBinding): string {
  return `ch${b.channel + 1} ${b.kind} 0x${b.number.toString(16).padStart(2, '0')}${b.shift ? ' +shift' : ''}`;
}

/**
 * Bind `message` to `action`: replaces the action's previous (unshifted)
 * binding and frees that control from any other action.
 */
export function learnBinding(bindings: MidiBinding[], action: string, message: MidiMessage, mode: MidiMode): MidiBinding[] {
  // Notes are buttons; a CC learned for a button action is treated as a fader.
  let learnedMode: MidiMode = mode === 'button' ? 'absolute' : mode;
  if (message.kind === 'note') learnedMode = 'button';
  const next: MidiBinding = { kind: message.kind, channel: message.channel, number: message.number, action, mode: learnedMode };
  const sameControl = (b: MidiBinding): boolean => b.kind === next.kind && b.channel === next.channel && b.number === next.number && !b.shift;
  return [...bindings.filter((b) => !(b.action === action && !b.shift) && !sameControl(b)), next];
}

export class MidiLearnDialog {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly note: HTMLElement;
  private learning: string | null = null;

  constructor(private readonly midi: MidiInput) {
    this.button = h('button', { class: 'btn btn-small', text: 'MIDI map', title: 'Map controller buttons and knobs (MIDI learn)', attrs: { type: 'button' } });
    this.button.addEventListener('click', () => this.open());
    this.body = h('div', { class: 'learn-body' });
    this.note = h('p', { class: 'history-note', attrs: { role: 'status' } });
    const tool = (label: string, run: () => void): HTMLButtonElement => h('button', { class: 'btn btn-small', text: label, attrs: { type: 'button' }, on: { click: run } });
    const importInput = h('input', { attrs: { type: 'file', accept: 'application/json,.json', hidden: '' } });
    importInput.addEventListener('change', () => void this.importFile(importInput));
    this.el = h('dialog', { class: 'help history learn', attrs: { 'aria-label': 'MIDI mapping' } }, [
      h('div', { class: 'help-head' }, [
        h('h2', { text: 'MIDI mapping' }),
        h('div', { class: 'history-actions' }, [
          tool('Export', () => this.exportMap()),
          tool('Import', () => importInput.click()),
          tool('Reset to defaults', () => void this.save(DEFAULT_MIDI_MAP, 'Reset to the default DDJ mapping')),
          tool('Close', () => this.el.close()),
          importInput,
        ]),
      ]),
      h('p', { class: 'help-foot', text: 'Press Learn, then move the control on your controller. Enable MIDI first. Jog wheels learn as relative controls.' }),
      this.note,
      this.body,
    ]);
    this.el.addEventListener('close', () => this.cancelLearn());
  }

  /** Load the saved mapping (if any) into the MIDI input. */
  async restore(): Promise<void> {
    const saved = await getSetting<MidiBinding[]>(MAP_KEY).catch(() => null);
    if (saved?.length) this.midi.setBindings(saved);
  }

  open(): void {
    setText(this.note, this.midi.store.get().enabled ? '' : 'MIDI is not enabled yet: press Enable MIDI in the top bar to learn controls.');
    this.render();
    this.el.showModal();
  }

  private cancelLearn(): void {
    this.learning = null;
    this.midi.learnNext(null);
  }

  private startLearn(item: Learnable): void {
    this.learning = item.action;
    setText(this.note, `Learning "${item.group}: ${item.label}": move a control now...`);
    this.render();
    this.midi.learnNext((message) => {
      const bindings = learnBinding(this.midi.currentBindings, item.action, message, item.mode);
      this.learning = null;
      void this.save(bindings, `${item.group}: ${item.label} is now ${describeBinding(bindings[bindings.length - 1])}`);
    });
  }

  private async save(bindings: MidiBinding[], message: string): Promise<void> {
    this.midi.setBindings(bindings);
    await setSetting(MAP_KEY, bindings).catch(() => undefined);
    setText(this.note, message);
    this.render();
  }

  private render(): void {
    const bindings = this.midi.currentBindings;
    let group = '';
    const rows: HTMLElement[] = [];
    for (const item of learnables()) {
      if (item.group !== group) {
        group = item.group;
        rows.push(h('h3', { class: 'learn-group', text: group }));
      }
      const bound = bindings.filter((b) => b.action === item.action && !b.shift);
      const learnButton = h('button', { class: `btn btn-tiny${this.learning === item.action ? ' on' : ''}`, text: this.learning === item.action ? 'Listening...' : 'Learn', attrs: { type: 'button' } });
      learnButton.addEventListener('click', () => this.startLearn(item));
      const clearButton = h('button', { class: 'btn btn-tiny', text: 'Clear', attrs: { type: 'button' } });
      clearButton.disabled = bound.length === 0;
      clearButton.addEventListener('click', () => void this.save(bindings.filter((b) => !(b.action === item.action && !b.shift)), `${item.group}: ${item.label} unmapped`));
      rows.push(
        h('div', { class: 'learn-row', attrs: { 'data-action': item.action } }, [
          h('span', { class: 'learn-label', text: item.label }),
          h('span', { class: 'learn-binding', text: bound.length ? bound.map(describeBinding).join(', ') : 'not mapped' }),
          learnButton,
          clearButton,
        ]),
      );
    }
    this.body.replaceChildren(...rows);
  }

  private exportMap(): void {
    const blob = new Blob([JSON.stringify(this.midi.currentBindings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { attrs: { href: url, download: 'dj-midi-map.json' } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setText(this.note, `Exported ${this.midi.currentBindings.length} mappings`);
  }

  private async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const valid =
        Array.isArray(parsed) &&
        parsed.every((b) => b && (b.kind === 'note' || b.kind === 'cc') && Number.isInteger(b.channel) && Number.isInteger(b.number) && typeof b.action === 'string');
      if (!valid) throw new Error('not a dj MIDI map');
      await this.save(parsed as MidiBinding[], `Imported ${parsed.length} mappings from ${file.name}`);
    } catch (error) {
      setText(this.note, `Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
