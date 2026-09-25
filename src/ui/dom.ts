/**
 * Small DOM helpers: element construction, canvas sizing, press feedback.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

type Child = Node | string | null | undefined | false;

interface ElementOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

/** Create an element with classes, text, attributes, listeners and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.class) el.className = options.class;
  if (options.text !== undefined) el.textContent = options.text;
  if (options.title) el.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) el.setAttribute(name, value);
  for (const [type, listener] of Object.entries(options.on ?? {})) el.addEventListener(type, listener as EventListener);
  for (const child of children) if (child) el.append(child);
  return el;
}

/**
 * Briefly highlight an element to acknowledge a press.
 *
 * `:active` only covers mouse presses; this also shows keyboard and MIDI
 * triggers, and makes a press that changes nothing still visibly land.
 */
export function flash(el: HTMLElement): void {
  el.classList.remove('flash');
  // Force a reflow so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add('flash');
}

/** Set text only when it changed (cheap to call every frame). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggle a class only when it changed. */
export function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/**
 * Match a canvas's backing store to its CSS size and device pixel ratio.
 *
 * @returns false while the canvas has no layout size yet (drawing then would
 *   throw on zero-sized image operations or paint into a 300x150 default).
 */
export function fitCanvas(canvas: HTMLCanvasElement): boolean {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (width === 0 || height === 0) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return true;
}

/** Read a CSS custom property from the root element. */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
