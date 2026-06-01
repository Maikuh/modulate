import { describe, it, expect } from 'vitest';
import { getVideoId } from '@/lib/youtube';

describe('getVideoId', () => {
  it('extracts the id from a watch URL', () => {
    expect(getVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('extracts the id from an m.youtube.com watch URL', () => {
    expect(getVideoId('https://m.youtube.com/watch?v=abc123')).toBe('abc123');
  });

  // getVideoId only recognises `?v=` watch URLs — Shorts and other paths have no
  // per-video setting to apply, so they resolve to null.
  it('returns null for shorts URLs', () => {
    expect(getVideoId('https://www.youtube.com/shorts/abc123')).toBeNull();
  });

  it('returns null for non-watch YouTube paths', () => {
    expect(getVideoId('https://www.youtube.com/feed/subscriptions')).toBeNull();
  });

  it('returns null for non-YouTube hosts', () => {
    expect(getVideoId('https://example.com/watch?v=abc')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(getVideoId('not a url')).toBeNull();
  });
});
