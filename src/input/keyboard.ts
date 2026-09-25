/**
 * Keyboard shortcuts. Keys are matched by physical position (KeyboardEvent.code),
 * so the layout is the same on QWERTY, AZERTY and others.
 *
 * The on-screen help is generated from KEYMAP, so the two cannot drift apart.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { Actions } from './actions';

export interface KeyBinding {
  code: string;
  /** Label shown in the help overlay. */
  key: string;
  action: string;
  /** Shift+key triggers this action instead. */
  shiftAction?: string;
  /** Send 1 on press and 0 on release (pitch bend). */
  hold?: boolean;
  description: string;
  group: 'Deck A' | 'Deck B' | 'Mixer';
}

function deckKeys(deck: 'A' | 'B', keys: Record<string, string>, cues: string[]): KeyBinding[] {
  const group = `Deck ${deck}` as const;
  const d = `deck.${deck}`;
  const letter = (k: string): { code: string; key: string } => ({ code: `Key${k}`, key: k });
  const bindings: KeyBinding[] = [
    { ...letter(keys.play), action: `${d}.play`, description: 'Play / pause', group },
    { ...letter(keys.cue), action: `${d}.cue`, description: 'Cue', group },
    { ...letter(keys.sync), action: `${d}.sync`, description: 'Sync on / off', group },
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
      description: `Hot cue ${i + 1} (Shift clears)`,
      group,
    }),
  );
  return bindings;
}

export const KEYMAP: KeyBinding[] = [
  ...deckKeys('A', { play: 'Q', cue: 'W', sync: 'E', loop: 'R', halve: 'D', double: 'F', back: 'Z', forward: 'X', slower: 'A', faster: 'S' }, ['1', '2', '3', '4']),
  ...deckKeys('B', { play: 'P', cue: 'O', sync: 'I', loop: 'U', halve: 'H', double: 'J', back: 'N', forward: 'M', slower: 'K', faster: 'L' }, ['7', '8', '9', '0']),
  { code: 'ArrowLeft', key: 'Left', action: 'mixer.xfader.left', description: 'Crossfader towards A', group: 'Mixer' },
  { code: 'ArrowRight', key: 'Right', action: 'mixer.xfader.right', description: 'Crossfader towards B', group: 'Mixer' },
  { code: 'ArrowDown', key: 'Down', action: 'mixer.xfader.center', description: 'Centre the crossfader', group: 'Mixer' },
];

/** Focus targets that own the keyboard (typing, sliders, selects). */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

export function attachKeyboard(actions: Actions, onHelp: () => void): void {
  const byCode = new Map(KEYMAP.map((b) => [b.code, b]));
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
    if (event.key === '?') {
      event.preventDefault();
      onHelp();
      return;
    }
    const binding = byCode.get(event.code);
    if (!binding) return;
    event.preventDefault();
    if (event.repeat) return;
    actions.trigger(event.shiftKey && binding.shiftAction ? binding.shiftAction : binding.action, 1);
  });
  window.addEventListener('keyup', (event) => {
    const binding = byCode.get(event.code);
    if (binding?.hold) actions.trigger(binding.action, 0);
  });
  // A held bend must not stay stuck if the window loses focus mid-press.
  window.addEventListener('blur', () => {
    for (const binding of KEYMAP) if (binding.hold) actions.trigger(binding.action, 0);
  });
}
