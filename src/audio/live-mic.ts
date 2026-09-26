/**
 * Push-to-talk microphone: hold to speak live over the mix.
 *
 * The first press asks for microphone access; the stream then stays open so
 * later presses are instant. While held, a gate opens the mic into the
 * master (limited and recorded) and the music ducks. An unplugged mic drops
 * the stream, so the next hold reconnects.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { Store } from '../state/store';

export type MicMode = 'off' | 'asking' | 'ready' | 'live' | 'denied' | 'unsupported' | 'error';

export interface MicState {
  mode: MicMode;
  /** Always-visible status or refusal. */
  status: string;
}

/** Audio context surface the mic uses (a real AudioContext in the app). */
export interface MicContext {
  readonly currentTime: number;
  createGain(): GainNode;
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode;
}

/** Gate open and close times (time constants, seconds): quick in, a touch slower out. */
const OPEN_SECONDS = 0.005;
const CLOSE_SECONDS = 0.03;

/**
 * Raw mic for a PA: the browser's echo cancellation, noise suppression and
 * auto-gain are built for calls and pump or smear a live voice over music.
 */
const CONSTRAINTS: MediaStreamConstraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };

export class LiveMic {
  readonly store = new Store<MicState>({ mode: 'off', status: 'Hold MIC to talk over the mix' });
  private readonly gate: GainNode;
  private stream: MediaStream | null = null;
  /** The button is down right now (a release during the permission prompt cancels going live). */
  private held = false;
  private source: MediaStreamAudioSourceNode | null = null;
  /** The feedback warning is shown the first time the mic goes live. */
  private warned = false;

  /**
   * @param output where the mic goes (the master, before the limiter).
   * @param onLive told when the mic goes live or mutes (for talk-over ducking).
   * @param getMedia opens the microphone (navigator.mediaDevices.getUserMedia in the app).
   */
  constructor(
    private readonly ctx: MicContext,
    output: AudioNode,
    private readonly onLive: (live: boolean) => void,
    private readonly getMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null,
  ) {
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(output);
  }

  get live(): boolean {
    return this.store.get().mode === 'live';
  }

  /** Button down: open the mic (asking for access the first time). */
  async down(): Promise<void> {
    this.held = true;
    if (!this.getMedia) {
      this.store.set({ mode: 'unsupported', status: 'This browser has no microphone access' });
      return;
    }
    if (!this.stream) {
      if (this.store.get().mode === 'asking') return;
      this.store.set({ mode: 'asking', status: 'Allow microphone access to talk (the browser is asking)' });
      try {
        this.stream = await this.getMedia(CONSTRAINTS);
      } catch (error) {
        this.store.set(micError(error));
        return;
      }
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.source.connect(this.gate);
      // Unplugged, or taken by another app: drop the stream so the next hold
      // reconnects, instead of showing ON AIR while sending silence.
      for (const track of this.stream.getAudioTracks()) track.addEventListener('ended', () => this.lost());
      // Released while the prompt was up: ready, not live.
      if (!this.held) {
        this.store.set({ mode: 'ready', status: 'Mic ready: hold MIC to talk' });
        return;
      }
    }
    this.open();
  }

  /** Button up: mute. */
  up(): void {
    this.held = false;
    if (!this.live) return;
    this.gate.gain.setTargetAtTime(0, this.ctx.currentTime, CLOSE_SECONDS);
    this.store.set({ mode: 'ready', status: 'Mic muted' });
    this.onLive(false);
  }

  private open(): void {
    if (this.live) return;
    this.gate.gain.setTargetAtTime(1, this.ctx.currentTime, OPEN_SECONDS);
    // Point-of-use safety note, once: a live mic near the speakers howls.
    const status = this.warned ? 'MIC LIVE: release to mute' : 'MIC LIVE: keep the mic away from the speakers (feedback), release to mute';
    this.warned = true;
    this.store.set({ mode: 'live', status });
    this.onLive(true);
  }

  private lost(): void {
    const wasLive = this.live;
    this.source?.disconnect();
    this.source = null;
    this.stream = null;
    this.gate.gain.setTargetAtTime(0, this.ctx.currentTime, CLOSE_SECONDS);
    this.store.set({ mode: 'error', status: 'Microphone disconnected: hold MIC to reconnect' });
    if (wasLive) this.onLive(false);
  }
}

/** A mic failure as a state with the real reason. */
export function micError(error: unknown): MicState {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return { mode: 'denied', status: 'Microphone access was refused: allow it in the site settings to talk' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { mode: 'error', status: 'No microphone found' };
  if (name === 'NotReadableError') return { mode: 'error', status: 'The microphone is in use by another app' };
  return { mode: 'error', status: `Microphone failed: ${error instanceof Error ? error.message : String(error)}` };
}
