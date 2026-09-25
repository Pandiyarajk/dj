/**
 * History CSV export and library match helpers.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { historyToCsv, type HistoryItem } from '../src/library/history';
import { bpmDelta, matchesQuery, suggestionScore } from '../src/library/match';

const item = (at: number, title: string, bpm: number | null): HistoryItem => ({ at, deck: 'A', title, artist: 'Artist, The', bpm, key: '8A', entryId: null });

describe('historyToCsv', () => {
  it('writes a header and rows oldest first, quoting commas and quotes', () => {
    const csv = historyToCsv([item(2000, 'Second "Mix"', 128), item(1000, 'First', null)]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('time,deck,artist,title,bpm,key');
    expect(lines[1]).toContain('First');
    expect(lines[1]).toContain('"Artist, The"');
    expect(lines[2]).toContain('"Second ""Mix"""');
    expect(lines[2]).toContain('128.00');
  });
});

describe('bpmDelta', () => {
  it('is the tempo change needed, allowing half and double time', () => {
    expect(bpmDelta(126, 124)).toBeCloseTo(-1.5873, 3);
    expect(bpmDelta(87, 174)).toBeCloseTo(0, 9);
    // 174 against 86: matched to double time (172), so 1.15% slower.
    expect(bpmDelta(174, 86)).toBeCloseTo(-1.1494, 3);
    expect(bpmDelta(null, 124)).toBeNull();
  });
});

describe('matchesQuery', () => {
  const entry = { title: 'Night Drive', artist: 'Somebody', album: 'Late Hours', bpm: 124.2, key: '8A' };

  it('matches title, artist and album text', () => {
    expect(matchesQuery(entry, 'night')).toBe(true);
    expect(matchesQuery(entry, 'late')).toBe(true);
    expect(matchesQuery(entry, 'nothing')).toBe(false);
  });

  it('treats a number as a BPM and a Camelot code as a key', () => {
    expect(matchesQuery(entry, '124')).toBe(true);
    expect(matchesQuery(entry, '125')).toBe(true);
    expect(matchesQuery(entry, '130')).toBe(false);
    expect(matchesQuery(entry, '8a')).toBe(true);
    expect(matchesQuery(entry, '9A')).toBe(false);
  });
});

describe('suggestionScore', () => {
  const ref = { bpm: 124, key: '8A' };
  it('ranks a close tempo in a compatible key first, a clash next, played last', () => {
    const near = suggestionScore({ bpm: 125, key: '9A' }, ref, false)!;
    const clash = suggestionScore({ bpm: 125, key: '3B' }, ref, false)!;
    const farther = suggestionScore({ bpm: 128, key: '8A' }, ref, false)!;
    const played = suggestionScore({ bpm: 124, key: '8A' }, ref, true)!;
    expect(near).toBeLessThan(farther);
    expect(farther).toBeLessThan(clash);
    expect(clash).toBeLessThan(played);
    expect(suggestionScore({ bpm: null, key: '8A' }, ref, false)).toBeNull();
  });
});
