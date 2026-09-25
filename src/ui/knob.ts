/**
 * Rotary knob: drag vertically (Shift for fine), wheel, arrow keys,
 * double-click to reset. Works in a normalised 0..1 position.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { h, setText } from './dom';

export interface KnobOptions {
  label: string;
  /** Initial position, 0..1. */
  value: number;
  /** Position double-click resets to. */
  resetTo: number;
  /** Text shown under the knob for a position. */
  format: (position: number) => string;
  onInput: (position: number) => void;
  /** Accent for the value arc, e.g. to colour EQ bands. */
  accent?: string;
}

const SWEEP = 270;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Pixels of vertical drag for a full turn. */
const DRAG_RANGE = 180;

function polar(angleDeg: number, r: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [20 + r * Math.cos(a), 20 + r * Math.sin(a)];
}

function arc(fromDeg: number, toDeg: number, r: number): string {
  const [x1, y1] = polar(fromDeg, r);
  const [x2, y2] = polar(toDeg, r);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export class Knob {
  readonly el: HTMLDivElement;
  private position: number;
  private readonly valueArc: SVGPathElement;
  private readonly pointer: SVGLineElement;
  private readonly readout: HTMLSpanElement;
  private readonly dial: HTMLDivElement;

  constructor(private readonly options: KnobOptions) {
    this.position = options.value;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const track = document.createElementNS(SVG_NS, 'path');
    track.setAttribute('d', arc(-SWEEP / 2, SWEEP / 2, 16));
    track.setAttribute('class', 'knob-track');
    this.valueArc = document.createElementNS(SVG_NS, 'path');
    this.valueArc.setAttribute('class', 'knob-value');
    if (options.accent) this.valueArc.style.stroke = options.accent;
    const cap = document.createElementNS(SVG_NS, 'circle');
    cap.setAttribute('cx', '20');
    cap.setAttribute('cy', '20');
    cap.setAttribute('r', '11');
    cap.setAttribute('class', 'knob-cap');
    this.pointer = document.createElementNS(SVG_NS, 'line');
    this.pointer.setAttribute('class', 'knob-pointer');
    svg.append(track, this.valueArc, cap, this.pointer);

    this.dial = h('div', { class: 'knob-dial', attrs: { role: 'slider', tabindex: '0', 'aria-label': options.label, 'aria-valuemin': '0', 'aria-valuemax': '1' } });
    this.dial.append(svg);
    this.readout = h('span', { class: 'knob-readout' });
    this.el = h('div', { class: 'knob', title: `${options.label}: drag, scroll or use arrow keys; double-click resets` }, [
      h('span', { class: 'knob-label', text: options.label }),
      this.dial,
      this.readout,
    ]);
    this.attach();
    this.render();
  }

  /** Move the knob without calling onInput (for external changes). */
  setValue(position: number): void {
    if (Math.abs(position - this.position) < 1e-6) return;
    this.position = position;
    this.render();
  }

  private change(position: number): void {
    const p = Math.max(0, Math.min(1, position));
    if (p === this.position) return;
    this.position = p;
    this.render();
    this.options.onInput(p);
  }

  private attach(): void {
    let startY = 0;
    let startPos = 0;
    this.dial.addEventListener('pointerdown', (event) => {
      this.dial.setPointerCapture(event.pointerId);
      startY = event.clientY;
      startPos = this.position;
      this.el.classList.add('dragging');
    });
    this.dial.addEventListener('pointermove', (event) => {
      if (!this.dial.hasPointerCapture(event.pointerId)) return;
      const scale = event.shiftKey ? 0.2 : 1;
      this.change(startPos + ((startY - event.clientY) / DRAG_RANGE) * scale);
    });
    const end = (): void => this.el.classList.remove('dragging');
    this.dial.addEventListener('pointerup', end);
    this.dial.addEventListener('pointercancel', end);
    this.dial.addEventListener('dblclick', () => this.change(this.options.resetTo));
    this.dial.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.change(this.position - Math.sign(event.deltaY) * (event.shiftKey ? 0.01 : 0.04));
      },
      { passive: false },
    );
    this.dial.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.01 : 0.05;
      if (event.key === 'ArrowUp' || event.key === 'ArrowRight') this.change(this.position + step);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') this.change(this.position - step);
      else if (event.key === 'Home' || event.key === 'Enter') this.change(this.options.resetTo);
      else return;
      // Keep the global shortcut map from also seeing this key.
      event.preventDefault();
      event.stopPropagation();
    });
  }

  private render(): void {
    const angle = -SWEEP / 2 + this.position * SWEEP;
    const origin = -SWEEP / 2 + this.options.resetTo * SWEEP;
    this.valueArc.setAttribute('d', Math.abs(angle - origin) < 0.5 ? '' : arc(Math.min(angle, origin), Math.max(angle, origin), 16));
    const [x1, y1] = polar(angle, 4);
    const [x2, y2] = polar(angle, 10);
    this.pointer.setAttribute('x1', x1.toFixed(2));
    this.pointer.setAttribute('y1', y1.toFixed(2));
    this.pointer.setAttribute('x2', x2.toFixed(2));
    this.pointer.setAttribute('y2', y2.toFixed(2));
    const text = this.options.format(this.position);
    setText(this.readout, text);
    this.dial.setAttribute('aria-valuenow', this.position.toFixed(3));
    this.dial.setAttribute('aria-valuetext', text);
  }
}
