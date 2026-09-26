/**
 * Dialogue sampler: clip limits, talk-over, press/stop, persistence.
 * Runs the real Sampler against a fake audio context and storage.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { describe, expect, it } from 'vitest';
import { Sampler, TalkOver, clipProblem, clipTitle, duckLabel, nextDuck, type SamplerContext, type StoredPads, type StoredSampler } from '../src/audio/sampler';

class FakeParam {
  value = 1;
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
class FakeSource extends FakeNode {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  /** Simulate the clip reaching its end. */
  end(): void {
    this.onended?.();
  }
}

function setup(saved: StoredSampler | null = null, durations: Record<string, number> = {}, loadGate?: Promise<void>) {
  const sources: FakeSource[] = [];
  const ducks: number[] = [];
  const saves: StoredPads[] = [];
  const settings: { level: number; duckDb: number }[] = [];
  const ctx: SamplerContext = {
    currentTime: 0,
    createGain: () => new FakeNode() as unknown as GainNode,
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s as unknown as AudioBufferSourceNode;
    },
    decodeAudioData: async (data: ArrayBuffer) => {
      const text = new TextDecoder().decode(data);
      if (text === 'broken') throw new Error('decode');
      return { duration: durations[text] ?? 3 } as AudioBuffer;
    },
  };
  let preview = true;
  // The app's wiring: pads report on/off to talk-over, which follows the TALK depth.
  const talk = new TalkOver((db) => ducks.push(db));
  const sampler = new Sampler(ctx, {} as AudioNode, {} as AudioNode, () => preview, (on) => talk.set('pads', on), {
    load: async () => {
      await loadGate;
      return saved;
    },
    saveClips: async (pads) => void saves.push(pads),
    saveSettings: async (v) => void settings.push(v),
  });
  sampler.store.subscribe((st) => talk.setDepth(st.duckDb));
  talk.setDepth(sampler.store.get().duckDb);
  return { sampler, sources, ducks, saves, settings, talk, setPreview: (v: boolean) => (preview = v) };
}

const clip = (text: string): Blob => new Blob([text]);

describe('sampler helpers', () => {
  it('refuses clips that are too large or too long', () => {
    expect(clipProblem(1000, 5)).toBeNull();
    expect(clipProblem(25 * 1024 * 1024, null)).toMatch(/too large/);
    expect(clipProblem(1000, 75)).toMatch(/too long.*deck/);
    expect(clipProblem(1000, 0)).toBe('empty');
  });

  it('cycles talk-over off, -6, -10, -16', () => {
    expect([0, -6, -10, -16].map(nextDuck)).toEqual([-6, -10, -16, 0]);
    expect(duckLabel(0)).toBe('TALK OFF');
    expect(duckLabel(-10)).toBe('TALK -10 dB');
  });

  it('titles a clip from its file name', () => {
    expect(clipTitle('Vadivelu - enna koduma.mp3')).toBe('Vadivelu - enna koduma');
    expect(clipTitle('.wav')).toBe('Clip');
  });
});

describe('Sampler', () => {
  it('a press plays, a second press stops, and the music ducks meanwhile', async () => {
    const { sampler, sources, ducks } = setup();
    expect(await sampler.assign(0, 'Punch', clip('a'))).toBe(true);
    sampler.press(0);
    expect(sources[0].started).toBe(true);
    expect(sampler.store.get().pads[0].playing).toBe(true);
    expect(ducks).toEqual([-10]);
    sampler.press(0);
    expect(sources[0].stopped).toBe(true);
    expect(sampler.store.get().pads[0].playing).toBe(false);
    expect(ducks).toEqual([-10, 0]);
    expect(sampler.store.get().status).toMatch(/stopped/);
  });

  it('the end of the clip clears the pad and restores the music', async () => {
    const { sampler, sources, ducks } = setup();
    await sampler.assign(2, 'Line', clip('a'));
    sampler.press(2);
    sources[0].end();
    expect(sampler.store.get().pads[2].playing).toBe(false);
    expect(ducks).toEqual([-10, 0]);
  });

  it('overlapping pads keep the music ducked until the last one ends', async () => {
    const { sampler, sources, ducks } = setup();
    await sampler.assign(0, 'One', clip('a'));
    await sampler.assign(1, 'Two', clip('b'));
    sampler.press(0);
    sampler.press(1);
    sources[0].end();
    expect(ducks).toEqual([-10]);
    sources[1].end();
    expect(ducks).toEqual([-10, 0]);
  });

  it('an empty pad says so instead of doing nothing', () => {
    const { sampler, sources } = setup();
    sampler.press(4);
    expect(sources).toHaveLength(0);
    expect(sampler.store.get().status).toBe('Pad 5 is empty: drop a clip on it');
  });

  it('refuses undecodable and over-long clips with the reason', async () => {
    const { sampler } = setup(null, { long: 90 });
    expect(await sampler.assign(0, 'Bad', clip('broken'))).toBe(false);
    expect(sampler.store.get().status).toMatch(/cannot decode/);
    expect(await sampler.assign(0, 'Long', clip('long'))).toBe(false);
    expect(sampler.store.get().status).toMatch(/too long/);
    expect(sampler.store.get().pads[0].title).toBeNull();
  });

  it('preview goes to the headphones, does not duck, and needs a headphone route', async () => {
    const { sampler, ducks, setPreview } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    setPreview(false);
    sampler.preview(0);
    expect(sampler.store.get().status).toMatch(/headphone cue mode/);
    setPreview(true);
    sampler.preview(0);
    expect(sampler.store.get().pads[0].previewing).toBe(true);
    expect(ducks).toEqual([]);
  });

  it('talk-over off never ducks', async () => {
    const { sampler, ducks } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    while (sampler.store.get().duckDb !== 0) sampler.cycleDuck();
    ducks.length = 0;
    sampler.press(0);
    expect(ducks).toEqual([]);
  });

  it('stop all stops every pad and says how many', async () => {
    const { sampler, sources } = setup();
    await sampler.assign(0, 'One', clip('a'));
    await sampler.assign(1, 'Two', clip('b'));
    sampler.press(0);
    sampler.press(1);
    sampler.stopAll();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(sampler.store.get().status).toBe('Stopped 2 dialogues');
    sampler.stopAll();
    expect(sampler.store.get().status).toBe('No dialogue is playing');
  });

  it('saves assignments and restores them', async () => {
    const first = setup();
    await first.sampler.assign(3, 'Punch', clip('a'));
    const pads = first.saves[first.saves.length - 1];
    expect(pads[3]?.title).toBe('Punch');
    const second = setup({ pads });
    await second.sampler.restore();
    expect(second.sampler.store.get().pads[3].title).toBe('Punch');
    expect(second.sampler.store.get().status).toBe('1 dialogue pad restored');
  });

  it('clearing a pad empties and saves it', async () => {
    const { sampler, saves } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    await sampler.clear(0);
    expect(sampler.store.get().pads[0].title).toBeNull();
    expect(saves[saves.length - 1][0]).toBeNull();
  });

  it('changing TALK while ducked applies at once, and never leaves the music ducked afterwards', async () => {
    const { sampler, sources, ducks, talk } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    sampler.press(0);
    expect(ducks).toEqual([-10]);
    while (sampler.store.get().duckDb !== 0) sampler.cycleDuck();
    expect(ducks[ducks.length - 1]).toBe(0);
    sources[0].end();
    sampler.cycleDuck();
    expect(talk.ducked).toBe(false);
    expect(ducks[ducks.length - 1]).toBe(0);
  });

  it('a press while previewing sends the clip live instead of stopping', async () => {
    const { sampler, ducks } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    sampler.preview(0);
    sampler.press(0);
    const pad = sampler.store.get().pads[0];
    expect(pad.playing && !pad.previewing).toBe(true);
    expect(ducks).toEqual([-10]);
  });

  it('LEVEL and TALK changes save settings only, never the clips', async () => {
    const { sampler, saves, settings } = setup();
    await sampler.assign(0, 'Punch', clip('a'));
    const clipSaves = saves.length;
    for (let i = 0; i < 20; i++) sampler.setLevel(i / 20);
    sampler.cycleDuck();
    await new Promise((r) => setTimeout(r, 500));
    expect(saves.length).toBe(clipSaves);
    expect(settings).toHaveLength(1);
    expect(settings[0].level).toBeCloseTo(0.95);
  });

  it('a clip dropped while the restore is loading is kept, and saves wait for the restore', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const { sampler, saves } = setup({ pads: [{ title: 'Old', blob: clip('a') }, { title: 'Kept', blob: clip('b') }] }, {}, gate);
    const restoring = sampler.restore();
    const assigning = sampler.assign(0, 'New', clip('c'));
    open();
    await restoring;
    await assigning;
    expect(sampler.store.get().pads[0].title).toBe('New');
    expect(sampler.store.get().pads[1].title).toBe('Kept');
    const last = saves[saves.length - 1];
    expect(last.map((p) => p?.title ?? null).slice(0, 2)).toEqual(['New', 'Kept']);
  });

  it('clearing a pad that is still loading says the load was cancelled', async () => {
    const { sampler } = setup();
    const loading = sampler.assign(0, 'Slow', clip('a'));
    await sampler.clear(0);
    await loading;
    expect(sampler.store.get().status).toBe('Pad 1: loading cancelled');
    expect(sampler.store.get().pads[0].title).toBeNull();
  });
});
