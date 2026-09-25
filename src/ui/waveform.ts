/**
 * Waveform views drawn from band peaks: a whole-track overview (click or drag
 * to seek) and a scrolling close-up with the beat grid, centred on the playhead.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 * Modified: Sep-25-2026 (grid drawn over the bands, playhead halo, gentler
 *   amplitude curve, per-cue colours, zoom, redraw only on change, drag-to-seek)
 */
import type { DeckState } from '../audio/deck-controller';
import type { Peaks } from '../analysis/peaks';
import { beatLength } from '../audio/sync';
import { cssVar, fitCanvas } from './dom';

interface Palette {
  background: string;
  low: string;
  mid: string;
  high: string;
  played: string;
  playhead: string;
  halo: string;
  beat: string;
  bar: string;
  cue: string;
  loop: string;
  text: string;
  hotCues: string[];
}

function readPalette(): Palette {
  return {
    background: cssVar('--wave-bg', '#0d1117'),
    low: cssVar('--wave-low', '#2f6fdf'),
    mid: cssVar('--wave-mid', '#e39b2d'),
    high: cssVar('--wave-high', '#e8edf5'),
    played: cssVar('--wave-played', 'rgba(0, 0, 0, 0.45)'),
    playhead: cssVar('--wave-playhead', '#ff4d4f'),
    halo: 'rgba(0, 0, 0, 0.75)',
    beat: cssVar('--wave-beat', 'rgba(255, 255, 255, 0.35)'),
    bar: cssVar('--wave-bar', 'rgba(255, 255, 255, 0.8)'),
    cue: cssVar('--wave-cue', '#f5c542'),
    loop: cssVar('--wave-loop', 'rgba(61, 220, 151, 0.18)'),
    text: cssVar('--text-dim', '#8b95a5'),
    hotCues: HOT_CUE_COLOURS.map((fallback, i) => cssVar(`--hotcue-${i + 1}`, fallback)),
  };
}

/** One colour per hot cue, shared with the pads (styles.css --hotcue-N). */
export const HOT_CUE_COLOURS = ['#ff4d6d', '#ff9f1c', '#ffd60a', '#3ddc97', '#2ec4f1', '#4d7cff', '#b37dff', '#ff6fd8'];

/** Max of each band over bins [from, to). */
function bandMax(peaks: Peaks, from: number, to: number): [number, number, number] {
  const start = Math.max(0, Math.floor(from));
  const end = Math.min(peaks.low.length, Math.max(start + 1, Math.ceil(to)));
  let l = 0;
  let m = 0;
  let hi = 0;
  for (let i = start; i < end; i++) {
    if (peaks.low[i] > l) l = peaks.low[i];
    if (peaks.mid[i] > m) m = peaks.mid[i];
    if (peaks.high[i] > hi) hi = peaks.high[i];
  }
  return [l, m, hi];
}

/**
 * Bar height for a 0..255 peak, as a fraction of the half-height. A 0.7 power
 * lifts quiet detail less than sqrt did (which made everything a solid block),
 * and the headroom keeps loud bins from touching the edges.
 */
function level(peak: number, headroom: number): number {
  return Math.pow(peak / 255, 0.7) * headroom;
}

/**
 * Draw mirrored band bars for columns 0..width-1.
 * `binAt(x)` returns the bin range [from, to) a column covers, or null if outside the track.
 */
function drawBands(ctx: CanvasRenderingContext2D, peaks: Peaks, width: number, height: number, palette: Palette, binAt: (x: number) => [number, number] | null): void {
  const mid = height / 2;
  const paths = { low: new Path2D(), mid: new Path2D(), high: new Path2D() };
  for (let x = 0; x < width; x++) {
    const range = binAt(x);
    if (!range) continue;
    const [l, m, hi] = bandMax(peaks, range[0], range[1]);
    const lh = level(l, 0.92) * mid;
    const mh = level(m, 0.7) * mid;
    const hh = level(hi, 0.5) * mid;
    if (lh > 0.5) paths.low.rect(x, mid - lh, 1, lh * 2);
    if (mh > 0.5) paths.mid.rect(x, mid - mh, 1, mh * 2);
    if (hh > 0.5) paths.high.rect(x, mid - hh, 1, hh * 2);
  }
  ctx.fillStyle = palette.low;
  ctx.fill(paths.low);
  ctx.fillStyle = palette.mid;
  ctx.fill(paths.mid);
  ctx.fillStyle = palette.high;
  ctx.fill(paths.high);
}

/** A vertical line with a dark halo, visible over any band colour. */
function haloLine(ctx: CanvasRenderingContext2D, x: number, height: number, colour: string, width: number, halo: string): void {
  const px = Math.round(x);
  ctx.fillStyle = halo;
  ctx.fillRect(px - Math.ceil(width / 2) - 1, 0, width + 2, height);
  ctx.fillStyle = colour;
  ctx.fillRect(px - Math.ceil(width / 2), 0, width, height);
}

function dpr(): number {
  return window.devicePixelRatio || 1;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette, text: string): void {
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = palette.beat;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.font = `${Math.round(12 * dpr())}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 - 12 * dpr());
}

function placeholderText(state: DeckState): string {
  if (state.status === 'loading') return state.statusText;
  if (state.status === 'error') return 'Load failed';
  if (state.status === 'empty') return 'Drop a track here or pick one from the library';
  return state.analysis !== null ? `Analysing ${Math.round(state.analysis * 100)}%` : '';
}

/** Skips a redraw when nothing that affects the picture changed. */
class RedrawGate {
  private last = '';
  changed(key: string): boolean {
    if (key === this.last) return false;
    this.last = key;
    return true;
  }
}

/** Whole-track overview. The static waveform is cached and only redrawn when data or size changes. */
export class OverviewWaveform {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache = document.createElement('canvas');
  private cachedPeaks: Peaks | null = null;
  private readonly palette = readPalette();
  private readonly gate = new RedrawGate();
  private state: DeckState | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    onSeek: (fraction: number) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.attachSeek(onSeek);
  }

  /**
   * Seek on release, or scrub while dragging horizontally. Seeking on
   * pointerdown made a vertical swipe over the overview on a tablet (meant to
   * scroll the page) jump the playing track.
   */
  private attachSeek(onSeek: (fraction: number) => void): void {
    const canvas = this.canvas;
    let start: { x: number; y: number; id: number } | null = null;
    let scrubbing = false;
    const fraction = (clientX: number): number => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      scrubbing = false;
    });
    canvas.addEventListener('pointermove', (event) => {
      if (start?.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (!scrubbing && dx > 8 && dx > dy) {
        scrubbing = true;
        canvas.setPointerCapture(event.pointerId);
      }
      if (scrubbing) onSeek(fraction(event.clientX));
    });
    canvas.addEventListener('pointerup', (event) => {
      if (start?.id !== event.pointerId) return;
      const moved = Math.abs(event.clientY - start.y) > 12;
      if (scrubbing || !moved) onSeek(fraction(event.clientX));
      start = null;
      scrubbing = false;
    });
    canvas.addEventListener('pointercancel', () => {
      start = null;
      scrubbing = false;
    });
  }

  draw(state: DeckState, position: number, duration: number, warning: boolean): void {
    if (!fitCanvas(this.canvas)) return;
    const { width, height } = this.canvas;
    const playX = duration > 0 ? Math.round((position / duration) * width) : 0;
    const blink = warning && Math.floor(performance.now() / 400) % 2 === 0;
    if (!this.gate.changed(`${width}x${height}|${playX}|${blink}`) && state === this.state) return;
    this.state = state;

    const ctx = this.ctx;
    const peaks = state.status === 'ready' ? state.peaks : null;
    if (!peaks || duration <= 0) {
      this.cachedPeaks = null;
      drawPlaceholder(ctx, width, height, this.palette, placeholderText(state));
      return;
    }

    if (this.cachedPeaks !== peaks || this.cache.width !== width || this.cache.height !== height) {
      this.cache.width = width;
      this.cache.height = height;
      const c = this.cache.getContext('2d');
      if (!c) return;
      c.fillStyle = this.palette.background;
      c.fillRect(0, 0, width, height);
      const binsPerColumn = peaks.low.length / width;
      drawBands(c, peaks, width, height, this.palette, (x) => [x * binsPerColumn, (x + 1) * binsPerColumn]);
      this.cachedPeaks = peaks;
    }

    ctx.drawImage(this.cache, 0, 0);
    const toX = (t: number): number => (t / duration) * width;
    ctx.fillStyle = this.palette.played;
    ctx.fillRect(0, 0, playX, height);
    if (blink) {
      // Track-end warning: the unplayed remainder flashes red.
      ctx.fillStyle = 'rgba(255, 77, 79, 0.35)';
      ctx.fillRect(playX, 0, width - playX, height);
    }

    if (state.loop) {
      ctx.fillStyle = this.palette.loop;
      ctx.fillRect(toX(state.loop.start), 0, Math.max(2, toX(state.loop.end) - toX(state.loop.start)), height);
    }
    state.hotCues.forEach((cue, i) => {
      if (cue === null) return;
      ctx.fillStyle = this.palette.hotCues[i];
      ctx.fillRect(Math.round(toX(cue)), 0, Math.ceil(2 * dpr()), height * 0.4);
    });
    ctx.fillStyle = this.palette.cue;
    ctx.fillRect(Math.round(toX(state.cuePoint)), height * 0.6, Math.ceil(2 * dpr()), height * 0.4);
    haloLine(ctx, playX, height, this.palette.playhead, Math.ceil(2 * dpr()), this.palette.halo);
  }
}

/** Zoom levels for the scrolling view: seconds of track time across its width. */
export const ZOOM_LEVELS = [2, 4, 8, 16, 32];

/** Close-up that scrolls under a fixed centre playhead. */
export class ScrollingWaveform {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly palette = readPalette();
  private readonly gate = new RedrawGate();
  private state: DeckState | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  draw(state: DeckState, position: number, windowSeconds: number): void {
    if (!fitCanvas(this.canvas)) return;
    const { width, height } = this.canvas;
    const pxPerSecond = width / windowSeconds;
    // Redraw only when the picture moved by at least a pixel or the state changed.
    const step = Math.round(position * pxPerSecond);
    if (!this.gate.changed(`${width}x${height}|${step}|${windowSeconds}`) && state === this.state) return;
    this.state = state;

    const ctx = this.ctx;
    const peaks = state.status === 'ready' ? state.peaks : null;
    if (!peaks) {
      drawPlaceholder(ctx, width, height, this.palette, placeholderText(state));
      return;
    }

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, width, height);
    const centre = width / 2;
    const toX = (t: number): number => centre + (t - position) * pxPerSecond;
    const binsPerPx = peaks.binsPerSecond / pxPerSecond;
    const totalBins = peaks.low.length;

    if (state.loop) {
      ctx.fillStyle = this.palette.loop;
      const x1 = toX(state.loop.start);
      ctx.fillRect(x1, 0, toX(state.loop.end) - x1, height);
    }

    drawBands(ctx, peaks, width, height, this.palette, (x) => {
      const t = position + (x - centre) / pxPerSecond;
      const bin = t * peaks.binsPerSecond;
      return bin < 0 || bin >= totalBins ? null : [bin, bin + Math.max(1, binsPerPx)];
    });

    // Played side dimmed, so "where am I" reads at a glance.
    ctx.fillStyle = this.palette.played;
    ctx.fillRect(0, 0, centre, height);

    this.drawGrid(state, position, windowSeconds, toX, pxPerSecond);

    ctx.font = `bold ${Math.round(10 * dpr())}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const marker = (t: number, colour: string, label: string): void => {
      const x = toX(t);
      if (x < -20 || x > width + 20) return;
      haloLine(ctx, x, height, colour, Math.ceil(2 * dpr()), this.palette.halo);
      ctx.fillStyle = colour;
      ctx.fillText(label, x + 4, 3);
    };
    state.hotCues.forEach((cue, i) => cue !== null && marker(cue, this.palette.hotCues[i], String(i + 1)));
    marker(state.cuePoint, this.palette.cue, 'CUE');

    haloLine(ctx, centre, height, this.palette.playhead, Math.ceil(3 * dpr()), this.palette.halo);
  }

  /**
   * Beat grid over the bands: drawn underneath, it only showed in silence,
   * exactly where it is not needed. Ticks at top and bottom plus a faint line.
   */
  private drawGrid(state: DeckState, position: number, windowSeconds: number, toX: (t: number) => number, pxPerSecond: number): void {
    if (state.bpm === null) return;
    const ctx = this.ctx;
    const { height } = this.canvas;
    const beat = beatLength(state.bpm);
    const first = Math.ceil((position - windowSeconds / 2 - state.firstBeat) / beat);
    const last = Math.floor((position + windowSeconds / 2 - state.firstBeat) / beat);
    // Skip beat lines closer than 6 px apart; bar lines still show.
    const showBeats = beat * pxPerSecond >= 6 * dpr();
    const tick = Math.round(height * 0.14);
    for (let b = first; b <= last; b++) {
      const isBar = ((b % 4) + 4) % 4 === 0;
      if (!isBar && !showBeats) continue;
      const x = Math.round(toX(state.firstBeat + b * beat));
      const w = isBar ? Math.ceil(2 * dpr()) : Math.ceil(dpr());
      ctx.fillStyle = isBar ? this.palette.bar : this.palette.beat;
      ctx.fillRect(x, 0, w, tick);
      ctx.fillRect(x, height - tick, w, tick);
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, tick, w, height - 2 * tick);
      ctx.globalAlpha = 1;
    }
  }
}
