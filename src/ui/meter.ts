/**
 * Vertical level meter with a decaying peak-hold marker.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { MeterReading } from '../audio/engine';
import { h } from './dom';

/** Bottom of the meter scale, dBFS. */
const FLOOR_DB = -48;
/** Peak-hold fall rate, dB per second. */
const HOLD_FALL_DB = 18;

function toFraction(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

export class Meter {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly hold: HTMLDivElement;
  private holdLevel = 0;
  private lastTime = performance.now();

  constructor(label: string) {
    this.fill = h('div', { class: 'meter-fill' });
    this.hold = h('div', { class: 'meter-hold' });
    this.el = h('div', { class: 'meter', title: `${label} level`, attrs: { role: 'meter', 'aria-label': `${label} level` } }, [this.fill, this.hold]);
  }

  update(reading: MeterReading): void {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const peak = toFraction(reading.peak);
    this.holdLevel = Math.max(peak, this.holdLevel - (HOLD_FALL_DB / -FLOOR_DB) * dt);
    // Clip rather than scale: scaling squashes the gradient too, which put the
    // red "clip" band at the top of the bar at every level.
    const level = toFraction(reading.rms * 1.414);
    this.fill.style.clipPath = `inset(${((1 - level) * 100).toFixed(1)}% 0 0 0)`;
    this.hold.style.bottom = `${(this.holdLevel * 100).toFixed(1)}%`;
    this.el.classList.toggle('clip', reading.peak >= 0.99);
  }
}
