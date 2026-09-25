/**
 * Action registry shared by the on-screen controls, the keyboard and MIDI.
 *
 * Every input source triggers the same named action, and every element bound
 * to an action flashes when it fires, whatever the source.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (hold buttons work from the keyboard)
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
      let held = false;
      const press = (): void => {
        if (held) return;
        held = true;
        this.trigger(name, 1);
      };
      const release = (): void => {
        if (!held) return;
        held = false;
        this.trigger(name, 0);
      };
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        el.setPointerCapture(event.pointerId);
        press();
      });
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      // Keyboard users hold Enter or Space on the focused button.
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) press();
      });
      el.addEventListener('keyup', (event) => {
        if (event.key === 'Enter' || event.key === ' ') release();
      });
      el.addEventListener('blur', release);
    } else {
      el.addEventListener('click', () => this.trigger(name, 1));
    }
    return el;
  }
}
