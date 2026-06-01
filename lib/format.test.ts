import { describe, it, expect } from 'vitest';
import { formatSemitones } from '@/lib/format';

describe('formatSemitones', () => {
  it('renders zero without a sign', () => {
    expect(formatSemitones(0)).toBe('0');
  });

  it('prefixes positive values with +', () => {
    expect(formatSemitones(3)).toBe('+3');
  });

  it('keeps the native minus for negatives', () => {
    expect(formatSemitones(-2)).toBe('-2');
  });
});
