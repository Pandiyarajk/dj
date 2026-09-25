/**
 * Waveform views drawn from band peaks: a whole-track overview (click to seek)
 * and a scrolling close-up with the beat grid, centred on the playhead.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
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
  beat: string;
  bar: string;
  cue: string;
  hotCue: string;
  loop: string;
  text: string;
}

function readPalette(): Palette {
  return {
    background: cssVar('--wave-bg', '#0d1117'),
    low: cssVar('--wave-low', '#2f6fdf'),
    mid: cssVar('--wave-mid', '#e39b2d'),
    high: cssVar('--wave-high', '#e8edf5'),
    played: cssVar('--wave-played', 'rgba(0, 0, 0, 0.45)'),
    playhead: cssVar('--wave-playhead', '#ff4d4f'),
    beat: cssVar('--wave-beat', 'rgba(255, 255, 255, 0.18)'),
    bar: cssVar('--wave-bar', 'rgba(255, 255, 255, 0.45)'),
    cue: cssVar('--wave-cue', '#f5c542'),
    hotCue: cssVar('--wave-hotcue', '#3ddc97'),
    loop: cssVar('--wave-loop', 'rgba(61, 220, 151, 0.18)'),
    text: cssVar('--text-dim', '#8b95a5'),
  };
}

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
    // sqrt lifts quiet detail without letting loud bins clip.
    const lh = Math.sqrt(l / 255) * mid;
    const mh = Math.sqrt(m / 255) * mid * 0.8;
    const hh = Math.sqrt(hi / 255) * mid * 0.6;
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

function drawPlaceholder(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette, text: string): void {
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = palette.beat;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.fillStyle = palette.text;
  ctx.font = `${Math.round(12 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 - 12 * (window.devicePixelRatio || 1));
}

function placeholderText(state: DeckState): string {
  if (state.status === 'loading') return state.statusText;
  if (state.status === 'error') return 'Load failed';
  if (state.status === 'empty') return 'Drop a track here or pick one from the library';
  return state.analysis !== null ? `Analysing ${Math.round(state.analysis * 100)}%` : '';
}

/** Whole-track overview. The static waveform is cached and only redrawn when data or size changes. */
export class OverviewWaveform {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cache = document.createElement('canvas');
  private cachedPeaks: Peaks | null = null;
  private palette = readPalette();

  constructor(
    readonly canvas: HTMLCanvasElement,
    onSeek: (fraction: number) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    canvas.addEventListener('pointerdown', (event) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0) onSeek((event.clientX - rect.left) / rect.width);
    });
  }

  draw(state: DeckState, position: number, duration: number): void {
    if (!fitCanvas(this.canvas)) return;
    const { width, height } = this.canvas;
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
    const playX = toX(position);
    ctx.fillStyle = this.palette.played;
    ctx.fillRect(0, 0, playX, height);

    if (state.loop) {
      ctx.fillStyle = this.palette.loop;
      ctx.fillRect(toX(state.loop.start), 0, Math.max(2, toX(state.loop.end) - toX(state.loop.start)), height);
    }
    ctx.fillStyle = this.palette.hotCue;
    for (const cue of state.hotCues) if (cue !== null) ctx.fillRect(Math.round(toX(cue)), 0, 2, height * 0.35);
    ctx.fillStyle = this.palette.cue;
    ctx.fillRect(Math.round(toX(state.cuePoint)), height * 0.65, 2, height * 0.35);
    ctx.fillStyle = this.palette.playhead;
    ctx.fillRect(Math.round(playX) - 1, 0, 2, height);
  }
}

/** Seconds of track time visible across the scrolling view at 1x zoom. */
const WINDOW_SECONDS = 8;

/** Close-up that scrolls under a fixed centre playhead. */
export class ScrollingWaveform {
  private readonly ctx: CanvasRenderingContext2D;
  private palette = readPalette();

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  draw(state: DeckState, position: number): void {
    if (!fitCanvas(this.canvas)) return;
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    const peaks = state.status === 'ready' ? state.peaks : null;
    if (!peaks) {
      drawPlaceholder(ctx, width, height, this.palette, placeholderText(state));
      return;
    }

    ctx.fillStyle = this.palette.background;
    ctx.fillRect(0, 0, width, height);
    const pxPerSecond = width / WINDOW_SECONDS;
    const centre = width / 2;
    const toX = (t: number): number => centre + (t - position) * pxPerSecond;
    const binsPerPx = peaks.binsPerSecond / pxPerSecond;
    const totalBins = peaks.low.length;

    if (state.loop) {
      ctx.fillStyle = this.palette.loop;
      const x1 = toX(state.loop.start);
      ctx.fillRect(x1, 0, toX(state.loop.end) - x1, height);
    }

    if (state.bpm !== null) {
      const beat = beatLength(state.bpm);
      const first = Math.ceil((position - WINDOW_SECONDS / 2 - state.firstBeat) / beat);
      const last = Math.floor((position + WINDOW_SECONDS / 2 - state.firstBeat) / beat);
      for (let b = first; b <= last; b++) {
        const x = Math.round(toX(state.firstBeat + b * beat));
        const isBar = ((b % 4) + 4) % 4 === 0;
        ctx.fillStyle = isBar ? this.palette.bar : this.palette.beat;
        ctx.fillRect(x, 0, isBar ? 2 : 1, height);
      }
    }

    drawBands(ctx, peaks, width, height, this.palette, (x) => {
      const t = position + (x - centre) / pxPerSecond;
      const bin = t * peaks.binsPerSecond;
      return bin < 0 || bin >= totalBins ? null : [bin, bin + Math.max(1, binsPerPx)];
    });

    const marker = (t: number, colour: string, label: string): void => {
      const x = toX(t);
      if (x < -20 || x > width + 20) return;
      ctx.fillStyle = colour;
      ctx.fillRect(Math.round(x), 0, 2, height);
      ctx.font = `bold ${Math.round(10 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + 4, 3);
    };
    state.hotCues.forEach((cue, i) => cue !== null && marker(cue, this.palette.hotCue, String(i + 1)));
    marker(state.cuePoint, this.palette.cue, 'CUE');

    ctx.fillStyle = this.palette.playhead;
    ctx.fillRect(Math.round(centre) - 1, 0, 2, height);
  }
}
