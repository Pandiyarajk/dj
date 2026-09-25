/**
 * Small DOM helpers: element construction, canvas sizing, press feedback.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (timed flash, observed canvas sizes, slider drag tracking)
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
  // Removed by timer, not animationend: with reduced motion there is no
  // animation, only a static highlight that must still go away.
  const timers = flashTimers.get(el);
  if (timers !== undefined) clearTimeout(timers);
  flashTimers.set(el, setTimeout(() => el.classList.remove('flash'), FLASH_MS));
}

const FLASH_MS = 180;
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Set text only when it changed (cheap to call every frame). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggle a class only when it changed. */
export function setClass(el: HTMLElement, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** CSS size of each observed canvas, kept current by one ResizeObserver. */
const canvasSizes = new WeakMap<HTMLCanvasElement, { width: number; height: number }>();
let sizeObserver: ResizeObserver | null = null;

function observe(canvas: HTMLCanvasElement): void {
  sizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.contentRect;
      canvasSizes.set(entry.target as HTMLCanvasElement, { width: box.width, height: box.height });
    }
  });
  // Seed with a one-off read; the observer keeps it current from then on.
  canvasSizes.set(canvas, { width: canvas.clientWidth, height: canvas.clientHeight });
  sizeObserver.observe(canvas);
}

/**
 * Match a canvas's backing store to its CSS size and device pixel ratio.
 *
 * Sizes come from a ResizeObserver rather than clientWidth: reading layout
 * every frame, after text updates, forced a synchronous reflow per frame.
 *
 * @returns false while the canvas has no layout size yet (drawing then would
 *   throw on zero-sized image operations or paint into a 300x150 default).
 */
export function fitCanvas(canvas: HTMLCanvasElement): boolean {
  if (!canvasSizes.has(canvas)) observe(canvas);
  const size = canvasSizes.get(canvas);
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round((size?.width ?? 0) * ratio);
  const height = Math.round((size?.height ?? 0) * ratio);
  if (width === 0 || height === 0) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return true;
}

/**
 * Track whether the pointer is dragging a slider.
 *
 * Views sync a slider from state unless the user is dragging it. Guarding on
 * focus instead left the thumb behind after a double-click reset: the slider
 * keeps focus, so the reset value was never written back and the next touch
 * jumped the tempo back to where the thumb was.
 */
export function dragTracker(input: HTMLElement): () => boolean {
  let dragging = false;
  input.addEventListener('pointerdown', () => (dragging = true));
  const end = (): void => {
    dragging = false;
    // Hand the keyboard back to the shortcuts after a mouse touch.
    if (document.activeElement === input) input.blur();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  return () => dragging;
}

/** Read a CSS custom property from the root element. */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
