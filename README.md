# pyssg

Source for [rlrs.dk](https://rlrs.dk), built with `pyssg.py`, a small single-file static site generator.

```bash
uv sync
uv run python pyssg.py serve   # http://localhost:8000, rebuilds on change (restarts if pyssg.py changes)
uv run python pyssg.py build   # writes the site to dist/ (gitignored)
```

Pushing to `main` deploys: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the site
and publishes `dist/` to GitHub Pages. Files left over from deleted pages are removed after each build.

## Writing

- **Posts** go in `content/posts/*.md` → `/blog/<slug>.html`. **Pages** go in `content/pages/*.md` → `/<slug>.html` and get a link in the nav.
- **Companion pages** (an interactive table, a dataset page, …) are pages with `parent: <post slug>`: they live at
  `/blog/<post slug>/<slug>.html`, stay out of the nav, link back to the post, and the post shows a card linking to them.
- Front matter:

  ```yaml
  ---
  title: "Post title"
  date: 2025-04-29          # YYYY-MM-DD; defaults to the file's mtime
  summary: "One sentence."  # used on the index, in RSS and meta tags; otherwise the first 35 words
  tags: ["llms"]            # optional, creates /blog/tags/<tag>.html
  bib: refs.bib             # optional, BibTeX file next to the post, enabling [@key] citations
  series: Series name       # optional, groups posts: "Part n of m" and a list of all parts (posts)
  part: 1                   # optional, order within the series; otherwise by date (posts)
  wide: true                # optional, wider layout (pages)
  nav_title: Short          # optional, nav label instead of the title (pages)
  nav: false                # optional, keep a page out of the nav (pages)
  parent: post-slug         # optional, make this page a companion to that post (pages)
  redirect_from: [/old.html] # optional, leave redirect stubs at old URLs
  image: /static/img/x.png  # optional, link-preview image instead of the generated card
  slug: custom-slug         # optional, defaults to the file name
  ---
  ```

- **Math:** `$inline$` and `$$display$$` (converted to MathML at build time, so no math JavaScript). Prices like `$5 and $10` stay plain text; write `\$` to force a literal dollar sign.
- **Footnotes:** `text[^note]` with `[^note]: The note.` anywhere in the post; the marker previews the note on hover.
- **Code:** fenced blocks with a language are highlighted by Pygments, and get a copy button.
- **Extras on every post:** a `#` link on each `##`/`###` heading, "Copy as Markdown" (the build writes
  `/blog/<slug>.md` next to the page), and a "Cite this post" BibTeX entry. `/llms.txt` indexes all posts.
- `static/` is copied to `dist/static/` as-is.
- **Site settings** live in `config.yml`: `site_name`, `author`, `base_url`, `description`, the header's
  `tagline` (one-line Markdown) and `clock` (city + time zone), and the home page's `upcoming` (unpublished
  titles shown, unlinked, at the top of Writing), `projects` and `elsewhere` lists.
  `sky:` turns on the home page's dithered view of the sky over the Øresund and a lit 3D figure next to each
  post (`static/sky.js`; `slider: true` adds a time-of-day slider). Older dither experiments live in
  `experiments/` (not part of the site).
- **Theme:** Jinja2 templates in `theme/`; plain CSS in `theme/site.css`, written to `dist/site.css` together
  with the Pygments colours. Colours are CSS variables at the top of `site.css`, swapped for dark mode. The font
  is self-hosted Site Serif (a renamed Latin subset of Charis SIL, i.e. Charter) in `static/fonts/`, SIL OFL.
  The built site loads nothing from other hosts.
  Each page also gets a generated 1200×630 link-preview card under `/og/`, drawn with the font in `theme/fonts/`.
