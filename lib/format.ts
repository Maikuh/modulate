/** Format a semitone count with an explicit sign (`+3`, `0`, `-2`). */
export function formatSemitones(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : ''}${n}`;
}
