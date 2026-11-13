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

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z\d])(?=[A-Z])")
_WORD = re.compile(r"[^\W_]+")
_MIN_FUZZY_LENGTH = 5
_MAX_FUZZY_LENGTH = 32
_FUZZY_MATCHES = 3
_FUZZY_CUTOFF = 0.8
_MIN_SPLIT_PART = 2


def words(text: str) -> list[str]:
    """Lower-cased words, camelCase split ("EventBus" → "event", "bus"); single letters dropped, numbers kept."""
    split = _CAMEL_BOUNDARY.sub(" ", unicodedata.normalize("NFKC", text))
    return [word for word in (match.lower() for match in _WORD.findall(split)) if len(word) > 1 or word.isdigit()]


def compact(text: str) -> str:
    """The text with everything but letters and digits removed: "Event Bus" → "eventbus"."""
    return "".join(_WORD.findall(unicodedata.normalize("NFKC", text))).lower()


def expand(text: str, is_known: Callable[[str], bool], vocabulary_near: Callable[[str], list[str]]) -> list[str]:
    """The words to search for.

    Stop words go unless nothing else is left. A word the index does not know is split into two
    known words if it can be ("eventbus" → "event", "bus"), else replaced by the closest known
    spellings. A multi-word query also tries its compact form, which catches "Event Bus" for a
    document that writes "EventBus". Unknown words with no replacement are dropped, so a query
    of only unknown words matches nothing.
    """
    tokens = words(text)
    meaningful = [word for word in tokens if word not in STOP_WORDS] or tokens
    terms: list[str] = []
    joined = compact(text)
    if len(tokens) > 1 and is_known(joined):
        terms.append(joined)
    for word in meaningful:
        if is_known(word):
            terms.append(word)
        elif halves := _split(word, is_known):
            terms.extend(halves)
        elif _MIN_FUZZY_LENGTH <= len(word) <= _MAX_FUZZY_LENGTH:
            terms.extend(difflib.get_close_matches(word, vocabulary_near(word), _FUZZY_MATCHES, _FUZZY_CUTOFF))
    return list(dict.fromkeys(terms))


def _split(word: str, is_known: Callable[[str], bool]) -> tuple[str, str] | None:
    for i in range(_MIN_SPLIT_PART, len(word) - _MIN_SPLIT_PART + 1):
        head, tail = word[:i], word[i:]
        if is_known(head) and is_known(tail):
            return head, tail
    return None
