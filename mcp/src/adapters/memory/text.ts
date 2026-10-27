// Tokenising, stemming and fuzzy matching for the lexical index.

/** Words too common to rank on; dropped unless a query has nothing else. */
export const STOP_WORDS = new Set(
  'a an and are as at be by can create do does for from get how i if in into is it like make me my of on or please the this to use using want what whats when where which who why will with would you your'.split(
    ' ',
  ),
);

const splitCamelCase = (value: string) => value.replace(/([a-z\d])([A-Z])/g, '$1 $2');
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** The whole value with every non-letter/digit removed: "Event Bus" → "eventbus". */
export const compactForm = (value: string): string => value.normalize('NFKC').toLowerCase().replace(NON_WORD, '');

/**
 * Lower-cased words, camelCase split ("EventBus" → "event", "bus"). Single letters are
 * dropped, numbers kept. A multi-word value also yields its compact form first, so
 * "EventBus" matches a document that writes "eventbus".
 */
export function tokenize(value: string): string[] {
  const original = value.normalize('NFKC');
  const tokens = splitCamelCase(original)
    .replace(NON_WORD, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 1 || /^\d+$/.test(word));
  const compact = compactForm(original);
  return compact && !tokens.includes(compact) ? [compact, ...tokens] : tokens;
}

const DERIVATIONAL = ['ations', 'ation', 'ions', 'ion', 'ings', 'ing', 'ers', 'er'];
const INFLECTIONAL = ['ed', 'es', 's', 'e'];
const MIN_STEM = 4;

/** A deliberately small suffix stripper; good enough to match "rotate"/"rotation"/"rotating". */
export function stem(word: string): string {
  for (const suffix of DERIVATIONAL) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) return word.slice(0, -suffix.length);
  }
  if ((word.endsWith('ied') || word.endsWith('ies')) && word.length > 6) return word.slice(0, -3) + 'y';
  for (const suffix of INFLECTIONAL) {
    if (suffix === 's' && word.endsWith('ss')) continue;
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) return word.slice(0, -suffix.length);
  }
  return word;
}

export const terms = (value: string): string[] => tokenize(value).map(stem);

/** Levenshtein distance ≤ max, abandoned as soon as it must exceed `max` (callers only ask about small bounds). */
export function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + cost);
      row[j] = value;
      diagonal = above;
      if (value < best) best = value;
    }
    if (best > max) return false;
  }
  return (row[b.length] ?? Infinity) <= max;
}
