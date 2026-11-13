from kb_mcp.indexer.extract import MAX_TEXT_LENGTH, extract_document


def test_renders_headings_paragraphs_lists_tables_and_code_as_markdown() -> None:
    html = """<main>
      <h1 id="top">Guide <a class="kb-anchor" href="#top">#</a></h1>
      <p>Intro with <strong>bold</strong> and <code>inline()</code> text.</p>
      <h2 id="list">List</h2>
      <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
      <ol><li>first</li><li>second</li></ol>
      <table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>
      <pre><code class="language-py">def f():\n    return 1</code></pre>
      <pre class="mermaid">flowchart LR\n  a --> b</pre>
    </main>"""

    document = extract_document(html)

    assert document.text == (
        "# Guide\n\n"
        "Intro with bold and `inline()` text.\n\n"
        "## List\n\n"
        "- one\n- two\n  - nested\n\n"
        "1. first\n2. second\n\n"
        "| Key | Value |\n| a | 1 |\n\n"
        "```py\ndef f():\n    return 1\n```\n\n"
        "```mermaid\nflowchart LR\n  a --> b\n```"
    )


def test_sections_are_code_point_offsets_running_to_the_next_heading() -> None:
    document = extract_document("<main><h1 id='a'>Ünïcode 🚀</h1><p>Body.</p><h2 id='b'>Next</h2><p>More.</p></main>")

    first, second = document.sections
    assert (first.heading, first.anchor, first.level) == ("Ünïcode 🚀", "a", 1)
    assert document.text[first.start : first.end] == "# Ünïcode 🚀\n\nBody.\n\n"
    assert document.text[second.start : second.end] == "## Next\n\nMore."


def test_unsafe_anchor_ids_are_not_offered_as_fragments() -> None:
    document = extract_document('<main><h2 id="x&quot;onload">Heading</h2></main>')

    assert document.sections[0].anchor is None


def test_drops_scripts_navigation_hidden_content_and_the_knowledge_base_masthead() -> None:
    html = """<body>
      <div class="kb-shell"><a>Knowledge base</a></div>
      <nav>Menu</nav><script>alert(1)</script><style>p{}</style>
      <header>Site header</header>
      <p hidden>hidden</p><p aria-hidden="true">aria</p><div class="toc">toc</div>
      <p>Visible text.</p>
      <footer>Footer</footer>
    </body>"""

    assert extract_document(html).text == "Visible text."


def test_strips_control_zero_width_and_bidi_override_characters() -> None:
    document = extract_document("<main><p>a\u202eb\u200bc\x07d</p></main>")

    assert document.text == "abcd"


def test_title_prefers_the_manifest_then_the_first_h1_then_the_title_element() -> None:
    html = (
        "<html><head><title>Title element</title></head>"
        "<body><main><h1>Heading <a class='headerlink'>¶</a></h1></main></body></html>"
    )

    assert extract_document(html, page_title="From manifest").title == "From manifest"
    assert extract_document(html).title == "Heading"
    assert extract_document("<title>Title element</title><p>x</p>").title == "Title element"
    assert extract_document("<p>x</p>", fallback_title="App").title == "App"


def test_description_is_the_first_paragraph_long_enough_to_describe_the_page() -> None:
    html = "<main><p>Short.</p><p>This paragraph is comfortably long enough to describe the page.</p></main>"

    assert extract_document(html).description == "This paragraph is comfortably long enough to describe the page."


def test_text_is_truncated_at_the_limit_and_says_so() -> None:
    document = extract_document(f"<main><h1>Big</h1><p>{'word ' * (MAX_TEXT_LENGTH // 4)}</p></main>")

    assert len(document.text) == MAX_TEXT_LENGTH
    assert document.truncated
    assert document.sections[0].end == MAX_TEXT_LENGTH


def test_malformed_html_is_read_the_way_a_browser_reads_it() -> None:
    document = extract_document("<main><p>one<p>two<li>three</main>")

    assert document.text == "one\n\ntwo\n\nthree"


def test_a_page_without_text_extracts_nothing() -> None:
    document = extract_document("<main><img src='x.png'><script>x()</script></main>")

    assert (document.text, document.sections) == ("", ())
