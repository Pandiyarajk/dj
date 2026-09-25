/**
 * Tests for the background analyser's status line.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-26-2026
 */
import { describe, expect, it } from 'vitest';
import { summarise } from '../src/library/background-analyser';

describe('background analysis summary', () => {
  it('says how many were analysed', () => {
    expect(summarise(19, [])).toBe('19 analysed');
  });

  it('names the tracks that could not be read, and why', () => {
    expect(summarise(18, [{ title: 'Broken', reason: 'Unable to decode audio data' }])).toBe('18 analysed, 1 could not be read: "Broken" (Unable to decode audio data)');
  });

  it('names at most two, then counts the rest', () => {
    const failures = ['a', 'b', 'c', 'd'].map((title) => ({ title, reason: 'x' }));
    expect(summarise(1, failures)).toBe('1 analysed, 4 could not be read: "a" (x), "b" (x) and 2 more');
  });
});
