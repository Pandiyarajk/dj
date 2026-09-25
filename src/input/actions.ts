/**
 * Action registry shared by the on-screen controls, the keyboard and MIDI.
 *
 * Every input source triggers the same named action, and every element bound
 * to an action flashes when it fires, whatever the source.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { flash } from '../ui/dom';

/**
 * Handler for an action.
 *
 * @param value 1 for a press (0 for its release on hold actions), or 0..1 for
 *   continuous controls such as faders.
 */
export type ActionHandler = (value: number) => void;

export class Actions {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly bound = new Map<string, Set<HTMLElement>>();

  register(name: string, handler: ActionHandler): void {
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Fire an action. Presses (value 1) flash bound elements; releases and continuous moves do not. */
  trigger(name: string, value = 1): void {
    const handler = this.handlers.get(name);
    if (!handler) return;
    handler(value);
    if (value === 1) for (const el of this.bound.get(name) ?? []) flash(el);
  }

  /** Flash `el` whenever `name` is pressed from any source. */
  bind(name: string, el: HTMLElement): void {
    let set = this.bound.get(name);
    if (!set) this.bound.set(name, (set = new Set()));
    set.add(el);
  }

  /**
   * Wire a button: click presses the action.
   * With `hold`, pointer down/up send 1/0 instead (for pitch bend).
   */
  button(name: string, el: HTMLButtonElement, hold = false): HTMLButtonElement {
    this.bind(name, el);
    if (hold) {
      el.addEventListener('pointerdown', (event) => {
        el.setPointerCapture(event.pointerId);
        this.trigger(name, 1);
      });
      const release = (): void => this.trigger(name, 0);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    } else {
      el.addEventListener('click', () => this.trigger(name, 1));
    }
    return el;
  }
}
