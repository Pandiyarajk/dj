/**
 * Keyboard shortcut overlay, generated from the key map.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-26-2026 (Dialogues group and pad gestures)
 */
import { KEYMAP } from '../input/keyboard';
import { h } from './dom';

export class HelpDialog {
  readonly el: HTMLDialogElement;

  constructor() {
    const groups = ['Deck A', 'Deck B', 'Mixer', 'Library', 'Dialogues', 'View'] as const;
    const sections = groups.map((group) =>
      h('div', { class: 'help-group' }, [
        h('h3', { text: group }),
        h(
          'dl',
          {},
          KEYMAP.filter((b) => b.group === group).flatMap((b) => [h('dt', {}, [h('kbd', { text: b.key })]), h('dd', { text: b.description })]),
        ),
      ]),
    );
    const close = h('button', { class: 'btn btn-small', text: 'Close', attrs: { type: 'button' } });
    this.el = h('dialog', { class: 'help', attrs: { 'aria-label': 'Keyboard shortcuts' } }, [
      h('div', { class: 'help-head' }, [h('h2', { text: 'Keyboard shortcuts' }), close]),
      h('div', { class: 'help-body' }, sections),
      h('p', {
        class: 'help-foot',
        text: 'Press ? to toggle this list. Knobs: drag up/down (Shift for fine), scroll, or arrow keys; double-click resets. Ctrl+Z undoes the last load. CUE and hot cues on a stopped deck play while held; press PLAY during the hold to keep playing. Hot cue pads: Shift+click or right-click clears. Dialogue pads: click plays or stops, Shift+click previews in the headphones, right-click clears; hold MIC to talk.',
      }),
    ]);
    close.addEventListener('click', () => this.el.close());
    this.el.addEventListener('click', (event) => {
      if (event.target === this.el) this.el.close();
    });
  }

  toggle(): void {
    if (this.el.open) this.el.close();
    else this.el.showModal();
  }
}
