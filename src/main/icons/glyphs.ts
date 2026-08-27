/**
 * Pixel glyphs used by the runtime icon renderer.
 *
 * A 3x5 digit font is enough to render "9+", "42", "120" on a 16 px badge, and
 * it keeps the whole badge pipeline dependency free and testable.
 */

export const DIGITS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['##.', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '+': ['...', '.#.', '###', '.#.', '...'],
});

/** A generic chat bubble with a tail: our placeholder mark, deliberately not
 *  the WhatsApp trademark (see docs/README note about brand assets). */
export const BUBBLE: readonly string[] = [
  '##############',
  '###############',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
  '################',
  '#####.........',
  '#####.........',
  '..###........',
  '...##.......',
  '............',
];

export function digitWidth(): number {
  return 3;
}

export function digitHeight(): number {
  return 5;
}
