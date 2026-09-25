/**
 * Tag helpers: file-name tags and key-tag normalisation.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { describe, expect, it } from 'vitest';
import { keyTagToCamelot, tagsFromFileName } from '../src/library/metadata';

describe('keyTagToCamelot', () => {
  it('accepts Camelot codes', () => {
    expect(keyTagToCamelot('8A')).toBe('8A');
    expect(keyTagToCamelot(' 12b ')).toBe('12B');
    expect(keyTagToCamelot('13A')).toBeNull();
  });

  it('converts note names in the common spellings', () => {
    expect(keyTagToCamelot('Am')).toBe('8A');
    expect(keyTagToCamelot('A minor')).toBe('8A');
    expect(keyTagToCamelot('C')).toBe('8B');
    expect(keyTagToCamelot('Cmaj')).toBe('8B');
    expect(keyTagToCamelot('F#m')).toBe('11A');
    expect(keyTagToCamelot('Gbm')).toBe('11A');
    expect(keyTagToCamelot('Eb')).toBe('5B');
    expect(keyTagToCamelot('Bbm')).toBe('3A');
  });

  it('rejects anything else', () => {
    expect(keyTagToCamelot('')).toBeNull();
    expect(keyTagToCamelot(undefined)).toBeNull();
    expect(keyTagToCamelot('H minor')).toBeNull();
    expect(keyTagToCamelot('o')).toBeNull();
  });
});

describe('tagsFromFileName', () => {
  it('splits "Artist - Title" and drops the extension', () => {
    expect(tagsFromFileName('Some Artist - Great_Track.mp3')).toMatchObject({ artist: 'Some Artist', title: 'Great Track', key: null });
    expect(tagsFromFileName('untitled.wav')).toMatchObject({ artist: '', title: 'untitled' });
  });
});
