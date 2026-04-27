/**
 * RSVP utilities — Optimal Recognition Point (ORP) calculation.
 *
 * The ORP is the point ~30% into a word where the eye naturally focuses
 * for fastest recognition. We highlight this letter and optionally align
 * it to a fixed horizontal position so the eye never moves.
 */

/** Returns the 0-based character index of the ORP letter in `word`. */
export function getOrpIndex(word: string): number {
  if (word.length <= 1) return 0
  // Work on letters only to find the ORP position
  const letters = word.replace(/[^a-zA-ZÀ-ž]/g, '')
  if (letters.length === 0) return 0
  const orpLetter = Math.floor(letters.length * 0.3)
  // Map back to index in original word
  let lettersSeen = 0
  for (let i = 0; i < word.length; i++) {
    if (/[a-zA-ZÀ-ž]/.test(word[i])) {
      if (lettersSeen === orpLetter) return i
      lettersSeen++
    }
  }
  return 0
}

/**
 * Splits a word into three parts for display:
 *   [before_orp, orp_letter, after_orp]
 *
 * Example: "speed" → ["sp", "e", "ed"]
 */
export function splitAtOrp(word: string): [string, string, string] {
  if (!word) return ['', '', '']
  const idx = getOrpIndex(word)
  return [
    word.slice(0, idx),
    word[idx] ?? '',
    word.slice(idx + 1),
  ]
}

/**
 * Tokenises a block of plain text into an array of words,
 * collapsing whitespace and filtering empties.
 */
export function tokenise(text: string): string[] {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)
}

/**
 * Returns the delay in ms for the given WPM, with a small pause multiplier
 * applied at sentence boundaries (ends with . ! ?) so reading feels natural.
 */
export function wordDelay(word: string, wpm: number, isParagraphEnd = false): number {
  const base = 60_000 / wpm
  if (isParagraphEnd) return base * 3.5
  const lastChar = word[word.length - 1] ?? ''
  if (['.', '!', '?'].includes(lastChar)) return base * 1.8
  if ([',', ';', ':'].includes(lastChar)) return base * 1.3
  return base
}
