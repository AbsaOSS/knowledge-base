// Keyword search over the in-memory search index: stemmed term frequency, a title boost, and
// fallbacks for compound words ("eventbus" → "event" + "bus") and misspellings.
import type { SearchIndex } from '../../../search-index/schema.ts';
import { EmptyQueryError } from '../../domain.ts';
import type { Page, PageRequest, SearchHit, SearchQuery, StoredDocument } from '../../domain.ts';
import type { SearchBackend } from '../../ports.ts';
import { fingerprint, paginate } from './cursor.ts';
import { STOP_WORDS, compactForm, terms, tokenize, stem, withinDistance } from './text.ts';

/** A query term and how much a match on it counts: 1 exact, 0.5 fuzzy. */
type WeightedTerm = readonly [term: string, weight: number];

interface DocumentTerms {
  document: StoredDocument;
  /** Occurrences of each term across title, description, app name, tags and text. */
  frequency: Map<string, number>;
  titleTerms: Set<string>;
  sectionTerms: Set<string>[];
}

const TITLE_BOOST = 4;
const FUZZY_WEIGHT = 0.5;
const MAX_FUZZY_LENGTH = 32;
const MAX_FUZZY_MATCHES = 3;
const EXCERPT_LEAD = 120;
const EXCERPT_LENGTH = 400;

/** Edits tolerated for a misspelled word of this length. */
const fuzzyDistance = (length: number) => (length >= 8 ? 2 : length >= 5 ? 1 : 0);

const hasTag = (document: StoredDocument, tag: string) =>
  document.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase());

function countTerms(words: string[]): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return frequency;
}

/** ~400 characters of `content` around the first occurrence of any query term. */
function excerptFor(content: string, queryTerms: readonly WeightedTerm[]): string {
  const lower = content.toLowerCase();
  const first = Math.max(0, queryTerms.map(([term]) => lower.indexOf(term)).find((index) => index >= 0) ?? 0);
  const start = Math.max(0, first - EXCERPT_LEAD);
  let excerpt = content
    .slice(start, start + EXCERPT_LENGTH)
    .replace(/\s+/g, ' ')
    .trim();
  if (first > EXCERPT_LEAD) excerpt = `…${excerpt}`;
  if (content.length > first + EXCERPT_LENGTH - EXCERPT_LEAD) excerpt += '…';
  return excerpt;
}

export class LexicalSearch implements SearchBackend {
  private readonly contentHash: string;
  private readonly documents: DocumentTerms[];
  private readonly vocabulary = new Set<string>();
  private readonly vocabularyByLength = new Map<number, string[]>();

  constructor(searchIndex: SearchIndex) {
    this.contentHash = searchIndex.contentHash;
    const appNames = new Map(searchIndex.apps.map((app) => [app.slug, app.name]));
    this.documents = searchIndex.documents.map((document) => {
      const fields = [
        document.title,
        document.description,
        appNames.get(document.app) ?? '',
        document.tags.join(' '),
        document.text,
      ];
      const words = terms(fields.join(' '));
      for (const word of words) this.vocabulary.add(word);
      return {
        document,
        frequency: countTerms(words),
        titleTerms: new Set(terms(document.title)),
        sectionTerms: document.sections.map((section) => new Set(terms(section.heading))),
      };
    });
    for (const term of this.vocabulary) {
      const bucket = this.vocabularyByLength.get(term.length);
      if (bucket) bucket.push(term);
      else this.vocabularyByLength.set(term.length, [term]);
    }
  }

  async search(query: SearchQuery, page: PageRequest): Promise<Page<SearchHit>> {
    if (!tokenize(query.text).length) throw new EmptyQueryError();
    // Words the index does not know expand to nothing, which matches nothing: an empty page.
    const queryTerms = this.expand(query.text);
    const ranked = this.documents
      .filter(
        ({ document }) => (!query.app || document.app === query.app) && (!query.tag || hasTag(document, query.tag)),
      )
      .map((indexed) => this.score(indexed, queryTerms))
      .filter((hit): hit is SearchHit => hit !== null)
      .sort((a, b) => b.score - a.score || a.document.uri.localeCompare(b.document.uri));
    const print = fingerprint(`${this.contentHash}|${query.text}|${query.app ?? ''}|${query.tag ?? ''}`);
    return paginate(ranked, page, print);
  }

  /**
   * Query words → index terms. Stop words go unless nothing else is left. A word the index
   * lacks is split into two known halves if it can be, else matched fuzzily — except the
   * compact form of the whole query, which only exists to catch "EventBus" as one word.
   */
  private expand(text: string): WeightedTerm[] {
    const tokens = tokenize(text);
    const stems = tokens.map(stem);
    const meaningful = stems.filter((word) => !STOP_WORDS.has(word));
    const words = meaningful.length ? meaningful : stems;
    const compact = tokens.length > 1 && tokens[0] === compactForm(text) ? stems[0] : null;

    const expanded: WeightedTerm[] = [];
    for (const word of words) {
      if (this.vocabulary.has(word)) {
        expanded.push([word, 1]);
        continue;
      }
      const halves = this.split(word);
      if (halves) {
        expanded.push(...halves.map((half): WeightedTerm => [half, 1]));
      } else if (word !== compact && word.length <= MAX_FUZZY_LENGTH) {
        expanded.push(...this.fuzzy(word).map((term): WeightedTerm => [term, FUZZY_WEIGHT]));
      }
    }
    return expanded;
  }

  /** The first split of `word` into two known terms of at least two letters each. */
  private split(word: string): [string, string] | null {
    for (let i = 2; i < word.length - 1; i += 1) {
      const head = word.slice(0, i);
      const tail = word.slice(i);
      if (this.vocabulary.has(head) && this.vocabulary.has(tail)) return [head, tail];
    }
    return null;
  }

  private fuzzy(word: string): string[] {
    const max = fuzzyDistance(word.length);
    const matches: string[] = [];
    for (let length = word.length - max; length <= word.length + max; length += 1) {
      for (const term of this.vocabularyByLength.get(length) ?? []) {
        if (withinDistance(word, term, max)) matches.push(term);
      }
    }
    return matches.sort().slice(0, MAX_FUZZY_MATCHES);
  }

  private score(indexed: DocumentTerms, queryTerms: readonly WeightedTerm[]): SearchHit | null {
    const { document, frequency, titleTerms, sectionTerms } = indexed;
    let score = 0;
    let hits = 0;
    for (const [term, weight] of queryTerms) {
      const count = frequency.get(term) ?? 0;
      if (!count) continue;
      hits += 1;
      score += weight * (count + (titleTerms.has(term) ? TITLE_BOOST : 0));
    }
    if (!score) return null;

    // The first section whose heading names a query term, else the first section.
    const matching = sectionTerms.findIndex((heading) => queryTerms.some(([term]) => heading.has(term)));
    const section = document.sections[matching >= 0 ? matching : 0];
    const content = section ? document.text.slice(section.start, section.end) : document.text;
    return {
      document,
      ...(section ? { section: { heading: section.heading, anchor: section.anchor } } : {}),
      excerpt: excerptFor(content, queryTerms),
      score: Number((score * (1 + (0.5 * hits) / queryTerms.length)).toFixed(4)),
    };
  }
}
