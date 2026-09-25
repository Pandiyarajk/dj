/**
 * Beat-phase meter: how far deck B's beat is from deck A's, and each deck's
 * bar.beat position, so beat-matching by ear (with the nudge buttons) can be
 * checked by eye.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import type { DeckController } from '../audio/deck-controller';
import { beatIndexAt, beatLength, tempoForSync, wrapPhase } from '../audio/sync';
import { cssVar, fitCanvas, h, setClass, setText } from './dom';

/** Phase error, as a fraction of a beat, counted as "locked". */
const LOCKED = 0.02;
/** Tempo difference, as a fraction, below which phase is meaningful. */
const MATCHED = 0.003;

export class PhaseMeter {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly label: HTMLElement;
  private readonly barA: HTMLElement;
  private readonly barB: HTMLElement;
  private readonly colours = {
    track: cssVar('--line', '#262f3d'),
    good: cssVar('--good', '#3ddc97'),
    warn: cssVar('--warn', '#f5c542'),
    bad: cssVar('--bad', '#ff5d5d'),
  };
  private lastKey = '';

  constructor(private readonly decks: [DeckController, DeckController]) {
    this.canvas = h('canvas', { class: 'phase-canvas', attrs: { 'aria-hidden': 'true' } });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.label = h('span', { class: 'phase-label', attrs: { role: 'status' } });
    this.barA = h('span', { class: 'phase-bar phase-bar-a', title: 'Deck A bar.beat' });
    this.barB = h('span', { class: 'phase-bar phase-bar-b', title: 'Deck B bar.beat' });
    this.el = h('div', { class: 'phase-meter', title: 'Beat phase of deck B relative to deck A' }, [this.barA, this.canvas, this.label, this.barB]);
  }

  private static barBeat(deck: DeckController): string {
    const grid = deck.grid;
    if (!deck.loaded || !grid) return '--.-';
    const index = Math.floor(beatIndexAt(grid, deck.position()) + 1e-6);
    // Before the first beat there is no bar yet.
    if (index < 0) return '-';
    return `${Math.floor(index / 4) + 1}.${(((index % 4) + 4) % 4) + 1}`;
  }

  frame(): void {
    const [a, b] = this.decks;
    setText(this.barA, `A ${PhaseMeter.barBeat(a)}`);
    setText(this.barB, `B ${PhaseMeter.barBeat(b)}`);

    const gridA = a.grid;
    const gridB = b.grid;
    const bpmA = a.effectiveBpm;
    let offset: number | null = null;
    let text = 'Load two analysed tracks to see beat phase';
    if (a.loaded && b.loaded && gridA && gridB && bpmA !== null && b.effectiveBpm !== null) {
      const { multiplier } = tempoForSync(bpmA, gridB.bpm);
      const tempoGap = (b.effectiveBpm / multiplier - bpmA) / bpmA;
      if (Math.abs(tempoGap) > MATCHED) {
        text = `Tempo differs by ${(tempoGap * 100).toFixed(2)}%`;
      } else {
        const at = a.now();
        offset = wrapPhase(beatIndexAt(gridB, b.renderPosition(at)) - beatIndexAt(gridA, a.renderPosition(at)) * multiplier);
        const ms = Math.round(offset * beatLength(gridB.bpm * (1 + b.state.tempo)) * 1000);
        if (Math.abs(offset) < LOCKED) text = 'In phase';
        else text = `B ${Math.abs(ms)} ms ${ms > 0 ? 'ahead' : 'behind'}`;
      }
    }
    setText(this.label, text);
    setClass(this.el, 'locked', offset !== null && Math.abs(offset) < LOCKED);
    this.draw(offset);
  }

  private draw(offset: number | null): void {
    if (!fitCanvas(this.canvas)) return;
    const { width, height } = this.canvas;
    const x = offset === null ? null : Math.round(width / 2 + offset * width);
    const key = `${width}x${height}|${x}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.colours.track;
    ctx.fillRect(0, height / 2 - 1, width, 2);
    ctx.fillRect(Math.round(width / 2) - 1, 0, 2, height);
    if (x === null || offset === null) return;
    const error = Math.abs(offset);
    let colour = this.colours.bad;
    if (error < LOCKED) colour = this.colours.good;
    else if (error < 0.08) colour = this.colours.warn;
    ctx.fillStyle = colour;
    const w = Math.max(4, Math.round(height * 0.5));
    ctx.fillRect(x - w / 2, 2, w, height - 4);
  }
}
