/**
 * Keyboard shortcuts. Keys are matched by physical position (KeyboardEvent.code),
 * so the layout is the same on QWERTY, AZERTY and others.
 *
 * The on-screen help is generated from KEYMAP, so the two cannot drift apart.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (sliders keep only arrow keys, hold cue and pads,
 *   shortcuts blocked behind the help dialog, Shift+Down recentres)
 */
import type { Actions } from './actions';

export interface KeyBinding {
  code: string;
  /** Label shown in the help overlay. */
  key: string;
  action: string;
  /** Shift+key triggers this action instead. */
  shiftAction?: string;
  /** Only with Shift held (for keys that are too easy to hit by accident). */
  shiftOnly?: boolean;
  /** Send 1 on press and 0 on release (pitch bend). */
  hold?: boolean;
  description: string;
  group: 'Deck A' | 'Deck B' | 'Mixer' | 'View';
}

function deckKeys(deck: 'A' | 'B', keys: Record<string, string>, cues: string[]): KeyBinding[] {
  const group = `Deck ${deck}` as const;
  const d = `deck.${deck}`;
  const letter = (k: string): { code: string; key: string } => ({ code: `Key${k}`, key: k });
  const bindings: KeyBinding[] = [
    { ...letter(keys.play), action: `${d}.play`, description: 'Play / pause', group },
    { ...letter(keys.cue), action: `${d}.cue`, hold: true, description: 'Cue (hold to preview)', group },
    { ...letter(keys.sync), action: `${d}.sync`, description: 'Sync on / off', group },
    { ...letter(keys.lock), action: `${d}.lock`, description: 'Lock on air (blocks load, CUE, pause)', group },
    { ...letter(keys.loop), action: `${d}.loop.toggle`, description: 'Loop on / off', group },
    { ...letter(keys.halve), action: `${d}.loop.halve`, description: 'Halve loop', group },
    { ...letter(keys.double), action: `${d}.loop.double`, description: 'Double loop', group },
    { ...letter(keys.back), action: `${d}.jump.back`, description: 'Beat jump back', group },
    { ...letter(keys.forward), action: `${d}.jump.forward`, description: 'Beat jump forward', group },
    { ...letter(keys.slower), action: `${d}.bend.down`, hold: true, description: 'Nudge slower (hold)', group },
    { ...letter(keys.faster), action: `${d}.bend.up`, hold: true, description: 'Nudge faster (hold)', group },
  ];
  cues.forEach((digit, i) =>
    bindings.push({
      code: `Digit${digit}`,
      key: digit,
      action: `${d}.hotcue.${i + 1}`,
      shiftAction: `${d}.hotcue.${i + 1}.clear`,
      hold: true,
      description: `Hot cue ${i + 1} (Shift clears)`,
      group,
    }),
  );
  return bindings;
}

export const KEYMAP: KeyBinding[] = [
  ...deckKeys('A', { play: 'Q', cue: 'W', sync: 'E', lock: 'T', loop: 'R', halve: 'D', double: 'F', back: 'Z', forward: 'X', slower: 'A', faster: 'S' }, ['1', '2', '3', '4']),
  ...deckKeys('B', { play: 'P', cue: 'O', sync: 'I', lock: 'Y', loop: 'U', halve: 'H', double: 'J', back: 'N', forward: 'M', slower: 'K', faster: 'L' }, ['7', '8', '9', '0']),
  { code: 'Equal', key: '=', action: 'view.zoom.in', description: 'Zoom waveforms in', group: 'View' },
  { code: 'Minus', key: '-', action: 'view.zoom.out', description: 'Zoom waveforms out', group: 'View' },
  { code: 'ArrowLeft', key: 'Left', action: 'mixer.xfader.left', description: 'Crossfader towards A', group: 'Mixer' },
  { code: 'ArrowRight', key: 'Right', action: 'mixer.xfader.right', description: 'Crossfader towards B', group: 'Mixer' },
  // Shift-only: recentring mid-mix is destructive, and Down alone is a scroll key.
  { code: 'ArrowDown', key: 'Shift+Down', action: 'mixer.xfader.center', shiftOnly: true, description: 'Centre the crossfader', group: 'Mixer' },
];

/** Keys a focused slider handles itself. */
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Focus targets that own this key. Text fields and selects own every key; a
 * range slider owns only its navigation keys. Treating sliders as text fields
 * killed every shortcut after any mouse touch on a fader.
 */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement && target.type === 'range') return SLIDER_KEYS.has(key);
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

/**
 * @param isBlocked true while a modal (the help dialog) is open: shortcuts
 *   must not start decks behind it.
 */
export function attachKeyboard(actions: Actions, onHelp: () => void, isBlocked: () => boolean = () => false): void {
  const byCode = new Map(KEYMAP.map((b) => [b.code, b]));
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || ownsKey(event.target, event.key)) return;
    if (event.key === '?') {
      event.preventDefault();
      onHelp();
      return;
    }
    if (isBlocked()) return;
    const binding = byCode.get(event.code);
    if (!binding || (binding.shiftOnly && !event.shiftKey)) return;
    event.preventDefault();
    if (event.repeat) return;
    actions.trigger(event.shiftKey && binding.shiftAction ? binding.shiftAction : binding.action, 1);
  });
  window.addEventListener('keyup', (event) => {
    const binding = byCode.get(event.code);
    if (!binding?.hold) return;
    // Release whichever of the pair was pressed; releasing the other is a no-op.
    actions.trigger(binding.action, 0);
    if (binding.shiftAction) actions.trigger(binding.shiftAction, 0);
  });
  // A held bend must not stay stuck if the window loses focus mid-press.
  window.addEventListener('blur', () => {
    for (const binding of KEYMAP) if (binding.hold) actions.trigger(binding.action, 0);
  });
}
