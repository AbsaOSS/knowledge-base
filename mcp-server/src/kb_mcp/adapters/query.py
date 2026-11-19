"""Query words → full-text terms: stop words, compound words and misspellings.

FTS5 does the stemming and the ranking; this only decides which words to ask it for.
"""

import difflib
import re
import unicodedata
from collections.abc import Callable

STOP_WORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "can",
        "create",
        "do",
        "does",
        "for",
        "from",
        "get",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "like",
        "make",
        "me",
        "my",
        "of",
        "on",
        "or",
        "please",
        "the",
        "this",
        "to",
        "use",
        "using",
        "want",
        "what",
        "whats",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "you",
        "your",
    ]
)

# Only after two characters: "gRPC", "iOS" and "mTLS" are one word, as the tokenizer indexed them.
_CAMEL_BOUNDARY = re.compile(r"(?<=[^\W_][a-z\d])(?=[A-Z])")
_WORD = re.compile(r"[^\W_]+")
_MIN_FUZZY_LENGTH = 5
_MAX_FUZZY_LENGTH = 32
_FUZZY_MATCHES = 3
_FUZZY_CUTOFF = 0.8
_MIN_SPLIT_PART = 2
MAX_WORDS = 12
"""Distinct words a query is searched for. Normalisation can turn one character into a word, so the
query's length in characters does not bound this."""
MAX_FUZZY_WORDS = 3
"""Unknown words matched against the vocabulary, at several milliseconds of CPU each."""


def fold(text: str) -> str:
    """The text as the index's tokenizer sees it: compatibility forms unified, diacritics removed."""
    decomposed = unicodedata.normalize("NFKD", text)
    return unicodedata.normalize("NFC", "".join(char for char in decomposed if not unicodedata.combining(char)))


class _FoldLowerTable(dict[int, str]):
    """A `str.translate` table, filled on first use of each character."""

    def __missing__(self, code: int) -> str:
        folded = fold(chr(code)).lower()
        self[code] = value = folded if len(folded) == 1 else chr(code)
        return value


_FOLD_LOWER = _FoldLowerTable()


def fold_lower(text: str) -> str:
    """The text lower-cased and folded one character at a time, so an index into it is an index into `text`."""
    return text.translate(_FOLD_LOWER)


def words(text: str) -> list[str]:
    """Lower-cased words, camelCase split ("EventBus" → "event", "bus"); single letters dropped, numbers kept."""
    split = _CAMEL_BOUNDARY.sub(" ", fold(text))
    return [word for word in (match.lower() for match in _WORD.findall(split)) if len(word) > 1 or word.isdigit()]


def compact(text: str) -> str:
    """The text with everything but letters and digits removed: "Event Bus" → "eventbus"."""
    return "".join(_WORD.findall(fold(text))).lower()


def expand(text: str, is_known: Callable[[str], bool], vocabulary_near: Callable[[str], list[str]]) -> list[str]:
    """The words to search for.

    Stop words go unless nothing else is left. A word the index does not know is split into two
    known words if it can be ("eventbus" → "event", "bus"), else matched to the closest known
    spellings. The word itself is always searched too, as FTS5 stems it. A multi-word query also
    tries its compact form, which catches "Event Bus" for a document that writes "EventBus". Only the
    first MAX_WORDS distinct words count, and only the first MAX_FUZZY_WORDS unknown ones are matched
    against the vocabulary.
    """
    tokens = words(text)
    distinct = list(dict.fromkeys(tokens))
    meaningful = ([word for word in distinct if word not in STOP_WORDS] or distinct)[:MAX_WORDS]
    terms: list[str] = []
    joined = compact(text)
    if len(tokens) > 1 and is_known(joined):
        terms.append(joined)
    terms.extend(
        compound
        for raw in text.split()
        if len(words(raw)) > 1 and (compound := compact(raw)) != joined and is_known(compound)
    )
    fuzzy_budget = MAX_FUZZY_WORDS
    for word in meaningful:
        if is_known(word):
            terms.append(word)
            continue
        terms.append(word)  # FTS5 stems it, so "run" still finds an indexed "running"
        if halves := _split(word, is_known):
            terms.extend(halves)
        elif fuzzy_budget and _MIN_FUZZY_LENGTH <= len(word) <= _MAX_FUZZY_LENGTH:
            fuzzy_budget -= 1
            terms.extend(difflib.get_close_matches(word, vocabulary_near(word), _FUZZY_MATCHES, _FUZZY_CUTOFF))
    return list(dict.fromkeys(terms))


def _split(word: str, is_known: Callable[[str], bool]) -> tuple[str, str] | None:
    for i in range(_MIN_SPLIT_PART, len(word) - _MIN_SPLIT_PART + 1):
        head, tail = word[:i], word[i:]
        if is_known(head) and is_known(tail):
            return head, tail
    return None
