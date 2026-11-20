"""The SQLite search index file: written by the indexer, read by the SQLite adapters.

The one definition both sides share, so it imports nothing from either.
"""

SCHEMA_VERSION = 1

SEARCH_COLUMNS = ("title", "description", "app_name", "tags", "body")
"""Columns of the full-text table, in the order `bm25()` takes its weights."""

SEARCH_WEIGHTS = (10.0, 2.0, 2.0, 2.0, 1.0)

SCHEMA = f"""
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE apps (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL,             -- JSON array
    kind TEXT NOT NULL CHECK (kind IN ('artifact', 'iframe')),
    url TEXT,
    source_version TEXT
) STRICT;

CREATE TABLE documents (
    id INTEGER PRIMARY KEY,         -- the full-text rowid
    uri TEXT NOT NULL UNIQUE,
    app TEXT NOT NULL REFERENCES apps (slug),
    route TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL,             -- JSON array
    section TEXT,
    source_version TEXT,
    sha256 TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    text TEXT NOT NULL
) STRICT;

CREATE INDEX documents_canonical ON documents (app, route);

CREATE TABLE sections (
    document_id INTEGER NOT NULL REFERENCES documents (id),
    position INTEGER NOT NULL,
    heading TEXT NOT NULL,
    anchor TEXT,
    level INTEGER NOT NULL,
    start INTEGER NOT NULL,         -- code-point offsets into documents.text
    "end" INTEGER NOT NULL,
    PRIMARY KEY (document_id, position)
) STRICT;

-- Ranked search: Porter stems, so "rotate" finds "rotation".
CREATE VIRTUAL TABLE search USING fts5 (
    {", ".join(SEARCH_COLUMNS)},
    content = '',
    tokenize = 'porter unicode61 remove_diacritics 2'
);

-- The same text without stemming: the vocabulary that compound splitting and
-- misspelling correction choose real words from.
CREATE VIRTUAL TABLE words USING fts5 (
    body,
    content = '',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE vocabulary USING fts5vocab (words, 'row');
"""
