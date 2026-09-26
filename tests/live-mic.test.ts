/**
 * Push-to-talk mic: permission, hold and release, talk-over.
 * Runs the real LiveMic against a fake audio context and getUserMedia.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { describe, expect, it } from 'vitest';
import { LiveMic, micError, type MicContext } from '../src/audio/live-mic';

class FakeParam {
  value = 0;
  setTargetAtTime(v: number): void {
    this.value = v;
  }
}
class FakeNode {
  readonly gain = new FakeParam();
  connect(): this {
    return this;
  }
  disconnect(): void {}
}

function setup(getMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null) {
  const lives: boolean[] = [];
  let gate: FakeNode | null = null;
  let constraints: MediaStreamConstraints | null = null;
  const ctx: MicContext = {
    currentTime: 0,
    createGain: () => (gate = new FakeNode()) as unknown as GainNode,
    createMediaStreamSource: () => new FakeNode() as unknown as MediaStreamAudioSourceNode,
  };
  const media = getMedia
    ? (c: MediaStreamConstraints) => {
        constraints = c;
        return getMedia(c);
      }
    : null;
  const mic = new LiveMic(ctx, {} as AudioNode, (live) => lives.push(live), media);
  return { mic, lives, gate: () => gate as FakeNode, constraints: () => constraints };
}

/** A fake stream whose track can be unplugged. */
function fakeStream(): { stream: MediaStream; unplug: () => void } {
  const listeners: (() => void)[] = [];
  const track = { addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
  return { stream: { getAudioTracks: () => [track] } as unknown as MediaStream, unplug: () => listeners.forEach((fn) => fn()) };
}
const granted = async (): Promise<MediaStream> => fakeStream().stream;

describe('LiveMic', () => {
  it('hold opens the mic and ducks the music; release mutes it', async () => {
    const { mic, lives, gate } = setup(granted);
    await mic.down();
    expect(mic.live).toBe(true);
    expect(gate().gain.value).toBe(1);
    expect(mic.store.get().status).toMatch(/LIVE/);
    mic.up();
    expect(mic.live).toBe(false);
    expect(gate().gain.value).toBe(0);
    expect(lives).toEqual([true, false]);
  });

  it('asks for a raw mic (no call processing)', async () => {
    const { mic, constraints } = setup(granted);
    await mic.down();
    expect(constraints()).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  });

  it('asks for access only once', async () => {
    let asks = 0;
    const { mic } = setup(async () => {
      asks++;
      return fakeStream().stream;
    });
    await mic.down();
    mic.up();
    await mic.down();
    mic.up();
    expect(asks).toBe(1);
  });

  it('a release while the permission prompt is up does not go live', async () => {
    let grant: (s: MediaStream) => void = () => undefined;
    const { mic, lives } = setup(() => new Promise((resolve) => (grant = resolve)));
    const pending = mic.down();
    expect(mic.store.get().mode).toBe('asking');
    mic.up();
    grant(fakeStream().stream);
    await pending;
    expect(mic.live).toBe(false);
    expect(mic.store.get().mode).toBe('ready');
    expect(lives).toEqual([]);
  });

  it('says why when access is refused or impossible', async () => {
    const refused = setup(async () => {
      throw new DOMException('no', 'NotAllowedError');
    });
    await refused.mic.down();
    expect(refused.mic.store.get().mode).toBe('denied');
    expect(refused.mic.store.get().status).toMatch(/refused/);
    const none = setup(null);
    await none.mic.down();
    expect(none.mic.store.get().status).toBe('This browser has no microphone access');
  });

  it('an unplugged mic stops being ON AIR, un-ducks, and reconnects on the next hold', async () => {
    const plug = fakeStream();
    let asks = 0;
    const { mic, lives } = setup(async () => {
      asks++;
      return asks === 1 ? plug.stream : fakeStream().stream;
    });
    await mic.down();
    plug.unplug();
    expect(mic.live).toBe(false);
    expect(mic.store.get().status).toMatch(/disconnected/);
    expect(lives).toEqual([true, false]);
    mic.up();
    await mic.down();
    expect(asks).toBe(2);
    expect(mic.live).toBe(true);
  });

  it('warns about feedback the first time only', async () => {
    const { mic } = setup(granted);
    await mic.down();
    expect(mic.store.get().status).toMatch(/feedback/);
    mic.up();
    await mic.down();
    expect(mic.store.get().status).toBe('MIC LIVE: release to mute');
  });

  it('names the real reason a mic fails', () => {
    expect(micError(new DOMException('x', 'NotReadableError')).status).toBe('The microphone is in use by another app');
    expect(micError(new DOMException('x', 'NotFoundError')).status).toBe('No microphone found');
    expect(micError(new DOMException('x', 'NotAllowedError')).mode).toBe('denied');
  });
});
