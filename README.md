# pyssg

Source for [rlrs.github.io](https://rlrs.github.io), built with `pyssg.py`, a small single-file static site generator.

```bash
uv sync
uv run python pyssg.py serve   # http://localhost:8000, rebuilds on change
uv run python pyssg.py build   # writes the site to dist/ (gitignored)
```

Pushing to `main` deploys: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the site
and publishes `dist/` to GitHub Pages. Every build empties `dist/` first.

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
  nav_title: Short          # optional, shorter nav label on phones (pages)
  image: /static/img/x.png  # optional, link-preview image instead of the generated card
  slug: custom-slug         # optional, defaults to the file name
  ---
  ```

- **Math:** `$inline$` and `$$display$$` (KaTeX). Prices like `$5 and $10` stay plain text; write `\$` to force a literal dollar sign.
- **Code:** fenced blocks with a language are highlighted by Pygments.
- `static/` is copied to `dist/static/` as-is.
- **Theme:** Jinja2 templates in `theme/`; styles in `theme/site.css` (Tailwind v4, compiled by the pinned
  standalone CLI, downloaded on first build). Each page also gets a generated 1200×630 link-preview card
  under `/og/`, drawn with the bundled Inter font.
