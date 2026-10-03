# pyssg

Source for [rlrs.dk](https://rlrs.dk), built with `pyssg.py`, a small single-file static site generator.

```bash
uv sync
uv run python pyssg.py serve   # http://localhost:8000, rebuilds on change
uv run python pyssg.py build   # writes the site to docs/
```

GitHub Pages serves `docs/` from `main`, so commit the rebuilt `docs/` along with your changes.
Every build empties `docs/` first (except `CNAME` and `.nojekyll`).

## Writing

- **Posts** go in `content/posts/*.md` → `/blog/<slug>.html`. **Pages** go in `content/pages/*.md` → `/<slug>.html` and get a link in the nav.
- Front matter:

  ```yaml
  ---
  title: "Post title"
  date: 2025-04-29          # YYYY-MM-DD; defaults to the file's mtime
  summary: "One sentence."  # used on the index, in RSS and meta tags; otherwise the first 35 words
  tags: ["llms"]            # optional, creates /blog/tags/<tag>.html
  bib: refs.bib             # optional, BibTeX file next to the post, enabling [@key] citations
  wide: true                # optional, wider layout (pages)
  slug: custom-slug         # optional, defaults to the file name
  ---
  ```

- **Math:** `$inline$` and `$$display$$` (KaTeX). Prices like `$5 and $10` stay plain text; write `\$` to force a literal dollar sign.
- **Code:** fenced blocks with a language are highlighted by Pygments.
- `static/` is copied to `docs/static/` as-is. Templates live in `theme/`.
