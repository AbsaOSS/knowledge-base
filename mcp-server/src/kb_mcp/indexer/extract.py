"""Untrusted page HTML → bounded, markdown-like plain text with section offsets.

Build time only: the server never parses HTML. Pages are parsed by Lexbor, an HTML5-conformant
parser, so markup is read the way a browser reads it.
"""

import re
import unicodedata
from dataclasses import dataclass, field

from selectolax.lexbor import LexborHTMLParser, LexborNode

from kb_mcp.domain import Section

MAX_TEXT_LENGTH = 500_000
MAX_TITLE_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 300
MIN_DESCRIPTION_LENGTH = 40

DROPPED = frozenset(
    [
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
        "nav",
        "aside",
        "form",
        "button",
        "input",
        "select",
        "textarea",
        "dialog",
        "link",
        "meta",
    ]
)
"""Never rendered, nor anything inside them."""

BLOCK_LEVEL = frozenset(
    [
        "address",
        "article",
        "aside",
        "blockquote",
        "dd",
        "details",
        "dialog",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hgroup",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "summary",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "ul",
    ]
)
"""Elements that end an inline run; everything else joins the run around it."""

HIDDEN_CLASSES = frozenset(["kb-shell", "kb-anchor", "headerlink", "md-sidebar", "sidebar", "toc"])
"""Chrome marked by class: the knowledge base's own masthead, and docs generators' anchors and sidebars."""

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")
"""C0 controls, DEL, zero-width characters and bidi overrides/isolates."""
_SAFE_ANCHOR = re.compile(r"^[A-Za-z][\w:.-]{0,127}$")
_CODE_LANGUAGE = re.compile(r"(?:^|\s)language-([a-z0-9+#-]{1,20})(?:\s|$)", re.IGNORECASE)
_HEADING = re.compile(r"^h([1-6])$")
_TEXT = "-text"


@dataclass(frozen=True, slots=True)
class ExtractedDocument:
    title: str
    description: str
    text: str
    sections: tuple[Section, ...]
    truncated: bool


def clean(value: str) -> str:
    value = _CONTROL.sub("", unicodedata.normalize("NFC", value))
    value = re.sub(r"[\t \f\v]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def one_line(value: str) -> str:
    return re.sub(r"\n+", " ", clean(value))


def _classes(node: LexborNode) -> set[str]:
    return set((node.attributes.get("class") or "").split())


def _content_root(tree: LexborHTMLParser) -> LexborNode:
    """The page's main content: <main>, role=main, <article>, else <body> (which Lexbor always creates)."""
    for selector in ("main", '[role="main"]', "article", "body"):
        if (node := tree.css_first(selector)) is not None:
            return node
    raise ValueError("Lexbor produced a document without a body")


@dataclass
class _Extractor:
    root: LexborNode
    output: str = ""
    paragraphs: list[str] = field(default_factory=list)
    headings: list[tuple[str, str | None, int, int]] = field(default_factory=list)

    def hidden(self, node: LexborNode) -> bool:
        tag = node.tag
        return (
            tag in DROPPED
            or (tag in ("header", "footer") and node.mem_id != self.root.mem_id)
            or "hidden" in node.attributes
            or node.attributes.get("aria-hidden") == "true"
            or bool(_classes(node) & HIDDEN_CLASSES)
        )

    def render(self, node: LexborNode, depth: int = 0) -> None:
        if self.hidden(node):
            return
        tag = node.tag or ""
        if heading := _HEADING.match(tag):
            self.render_heading(node, int(heading[1]))
        elif tag == "pre":
            self.render_code(node)
        elif tag == "table":
            self.render_table(node)
        elif tag in ("ul", "ol"):
            self.render_list(node, depth)
        elif tag != "hr":
            self.render_children(node, depth)

    def inline(self, node: LexborNode) -> str:
        if node.tag == _TEXT:
            return node.text_content or ""
        if (node.tag or "-").startswith("-") or self.hidden(node):  # comments and other non-elements
            return ""
        if node.tag == "br":
            return "\n"
        if node.tag == "img":
            alt = node.attributes.get("alt")
            return f"[{alt}]" if alt else ""
        value = "".join(self.inline(child) for child in node.iter(include_text=True))
        if node.tag == "code":
            return f"`{value}`"
        # A block nested where only inline text is wanted (a <p> in a list item or a cell) still separates words.
        return f" {value} " if node.tag in BLOCK_LEVEL else value

    def render_children(self, node: LexborNode, depth: int) -> None:
        """Join each run of adjacent inline nodes into one paragraph."""
        run: list[str] = []
        for child in node.iter(include_text=True):
            if child.tag in BLOCK_LEVEL:
                self.flush(run)
                run = []
                self.render(child, depth)
            else:
                run.append(self.inline(child))
        self.flush(run)

    def flush(self, run: list[str]) -> None:
        if value := clean("".join(run)):
            self.paragraphs.append(value)
            self.append_block(value)

    def append_block(self, value: str) -> None:
        if self.output:
            self.output += "\n\n"
        self.output += value

    def render_heading(self, node: LexborNode, level: int) -> None:
        heading = one_line(self.inline(node))
        if not heading:
            return
        if self.output:
            self.output += "\n\n"
        anchor = node.attributes.get("id") or ""
        self.headings.append((heading, anchor if _SAFE_ANCHOR.match(anchor) else None, level, len(self.output)))
        self.output += f"{'#' * level} {heading}"

    def render_code(self, node: LexborNode) -> None:
        """Code keeps its whitespace: highlighter token spans join as they are and indentation survives."""
        classes = " ".join(
            filter(None, [node.attributes.get("class"), *(c.attributes.get("class") for c in node.css("code"))])
        )
        language = "mermaid" if "mermaid" in classes else (m[1] if (m := _CODE_LANGUAGE.search(classes)) else "")
        code = _CONTROL.sub("", unicodedata.normalize("NFC", node.text(deep=True)).replace("\r\n", "\n"))
        code = code.lstrip("\n").rstrip()
        if code:
            self.append_block(f"```{language}\n{code}\n```")

    def render_table(self, node: LexborNode) -> None:
        lines = []
        for row in node.css("tr"):
            if self.hidden(row):
                continue
            cells = [one_line(self.inline(cell)) for cell in row.iter() if cell.tag in ("td", "th")]
            lines.append(f"| {' | '.join(cells)} |")
        if lines:
            self.append_block("\n".join(lines))

    def render_list(self, node: LexborNode, depth: int) -> None:
        ordered = node.tag == "ol"
        number = 0
        for item in node.iter():
            if item.tag != "li" or self.hidden(item):
                continue
            number += 1
            nested = [child for child in item.iter() if child.tag in ("ul", "ol", "pre", "table")]
            nested_ids = {child.mem_id for child in nested}
            label = one_line(
                "".join(self.inline(child) for child in item.iter(include_text=True) if child.mem_id not in nested_ids)
            )
            if label:
                if self.output:
                    self.output += "\n\n" if number == 1 and depth == 0 else "\n"
                marker = f"{number}. " if ordered else "- "
                self.output += f"{'  ' * depth}{marker}{label}"
            for child in nested:
                self.render(child, depth + 1)


def extract_document(html: str, *, page_title: str | None = None, fallback_title: str = "") -> ExtractedDocument:
    """Turn untrusted page HTML into bounded markdown-like text.

    The title is the manifest's page title, else the content's first <h1> (without its anchor link),
    else <title>, else the fallback. The description is the first paragraph long enough to describe the page.
    """
    tree = LexborHTMLParser(html)
    root = _content_root(tree)
    extractor = _Extractor(root)
    extractor.render(root)
    truncated = len(extractor.output) > MAX_TEXT_LENGTH
    text = extractor.output[:MAX_TEXT_LENGTH]

    # Each section runs to the next heading, or to the end of the (possibly truncated) text.
    starts = [start for *_, start in extractor.headings] + [len(text)]
    sections = tuple(
        Section(heading, anchor, level, start, min(len(text), starts[i + 1]))
        for i, (heading, anchor, level, start) in enumerate(extractor.headings)
        if start < len(text)
    )

    h1 = next((heading for heading, _, level, _ in extractor.headings if level == 1), "")
    title_node = tree.css_first("title")
    title = clean(page_title or h1 or (title_node.text(deep=True) if title_node else "") or fallback_title)
    title = title[:MAX_TITLE_LENGTH]
    description = next((p for p in extractor.paragraphs if len(p) >= MIN_DESCRIPTION_LENGTH), "")
    return ExtractedDocument(
        title=title,
        description=one_line(description)[:MAX_DESCRIPTION_LENGTH],
        text=text,
        sections=tuple(section for section in sections if section.start < section.end),
        truncated=truncated,
    )
