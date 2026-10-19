"""
pyssg — A minimal yet capable Python static‑site generator for blogs & pages.

Main features
-------------
* **Blog posts & standalone pages** handled with Markdown + YAML front‑matter.
* **Theme‑first design** – layouts live in a `theme/` folder; swap or tweak at will.
* **Math** – `$…$` / `$$…$$` turned into MathML at build time; browsers render it natively.
* **Per‑page BibTeX citations** using the simple `[@key]` syntax, and `[^note]` footnotes.
* **Post series** (`series:` front matter), a "Cite this post" BibTeX entry, a Markdown copy of each
  post and an `llms.txt` index.
* **Syntax highlighting** via Pygments (CSS emitted once per build).
* **Plain CSS** – `theme/site.css` plus the Pygments colours, written to one `site.css`.
* **Social cards** – a 1200×630 Open Graph image per page, drawn with Pillow.
* **RSS feed, tag listings, static asset copy, dev server** – the niceties you expect.

Minimal, well‑known deps only: `markdown‑it‑py`, `mdit-py-plugins`, `latex2mathml`, `PyYAML`,
`Pygments`, `Jinja2`, `bibtexparser`, `Pillow`. The built site loads nothing from other hosts.

Run `uv sync` (see pyproject.toml)

Directory layout (opinionated but trivial to change):
```
myblog/
├─ content/
│  ├─ posts/  ← blog articles in .md
│  └─ pages/  ← static pages in .md
├─ static/    ← images, css, etc (copied as‑is)
├─ theme/     ← Jinja2 HTML templates (auto‑scaffolded on first run)
├─ config.yml ← site configuration
└─ pyssg.py   ← this file
```

Usage:
    python pyssg.py build           # build to ./dist
    python pyssg.py serve -p 9000   # build, serve http://localhost:9000 & rebuild on change
"""

import argparse
import datetime as dt
import email.utils
import functools
import html
import http.server
import logging
import os
import pathlib
import re
import shutil
import time
import threading
import socketserver
import sys
from typing import Any, Dict, List

import bibtexparser  # type: ignore
import jinja2  # type: ignore
from latex2mathml.converter import convert as latex_to_mathml  # type: ignore
import markupsafe  # type: ignore
import yaml  # type: ignore
from markdown_it import MarkdownIt  # type: ignore
from mdit_py_plugins.anchors import anchors_plugin  # type: ignore
from mdit_py_plugins.dollarmath import dollarmath_plugin  # type: ignore
from mdit_py_plugins.footnote import footnote_plugin  # type: ignore
from PIL import Image, ImageDraw, ImageFont  # type: ignore
from pygments import highlight  # type: ignore
from pygments.formatters import HtmlFormatter  # type: ignore
from pygments.lexers import TextLexer, get_lexer_by_name  # type: ignore

# ----------------------------------------------------------------------------
# Markdown helpers
# ----------------------------------------------------------------------------

_PYGMENTS_STYLES = {"": "lovelace", ".dark ": "github-dark"}  # selector prefix → style (light, dark)

def _highlight(code: str, lang: str, *_):
    try:
        lexer = get_lexer_by_name(lang)
    except Exception:
        lexer = TextLexer()
    body = highlight(code, lexer, HtmlFormatter(nowrap=True))
    cls = f' class="language-{html.escape(lang)}"' if lang else ""
    return f'<pre class="highlight"><code{cls}>{body}</code></pre>\n'

_MD = MarkdownIt("commonmark", {"html": True}).enable("table")
_MD.options["highlight"] = _highlight
# $…$ / $$…$$ → MathML. allow_space/allow_digits off so prose like "$5 and $10" stays plain text.
dollarmath_plugin(_MD, allow_space=False, allow_digits=False)

def _math_rule(display: str):
    def render(self, tokens, idx, options, env):
        tex = tokens[idx].content.strip()
        try:
            return latex_to_mathml(tex, display=display)
        except Exception:
            logging.warning("Could not convert math to MathML: %s", tex)
            return f"<code>{html.escape(tex)}</code>"
    return render

for _rule, _display in [("math_inline", "inline"), ("math_inline_double", "block"), ("math_block", "block")]:
    _MD.add_render_rule(_rule, _math_rule(_display))
# ids on h2/h3 at build time, so #section links work and the post TOC can use them
anchors_plugin(_MD, min_level=2, max_level=3)
footnote_plugin(_MD)

_FOOTNOTE_ITEM = re.compile(r'<li id="fn(\d+)" class="footnote-item">(.*?)</li>', re.S)
_FOOTNOTE_REF = re.compile(r'<sup class="footnote-ref"><a href="#fn(\d+)" id="(fnref[^"]*)">\[[^\]]+\]</a></sup>')
_FOOTNOTE_BACKREF = re.compile(r'\s*<a href="#fnref[^"]*" class="footnote-backref">.*?</a>')

def _footnote_previews(html_text: str) -> str:
    """Footnote markers become small numbers that preview the note on hover, like citations do."""
    notes = {}
    for num, body in _FOOTNOTE_ITEM.findall(html_text):
        plain = html.unescape(re.sub(r"<[^>]+>", "", _FOOTNOTE_BACKREF.sub("", body)))
        notes[num] = html.escape(" ".join(plain.split()), quote=True)
    return _FOOTNOTE_REF.sub(
        lambda m: f'<a class="cite fn" data-ref="{notes.get(m.group(1), "")}" href="#fn{m.group(1)}" id="{m.group(2)}">{m.group(1)}</a>',
        html_text)

_CITE_PAT = re.compile(r"\[@([^\]]+)\]")

_SVG_IMG = re.compile(r'<p><img src="([^":]+\.svg)" alt="([^"]*)" ?/?></p>')

def _inline_figures(html_text: str, folder: pathlib.Path) -> str:
    """`![caption](file.svg)` alone on a line, with the SVG next to the Markdown, becomes an inline
    <figure>, so the drawing can use the theme's colors (an <img> can't see the page's CSS)."""
    def sub(m: re.Match):
        svg = folder / html.unescape(m.group(1))
        if not svg.exists():
            return m.group(0)
        caption = f"<figcaption>{m.group(2)}</figcaption>" if m.group(2) else ""
        return f"<figure class='fig'><div class='fig-scroll'>{svg.read_text('utf8').strip()}</div>{caption}</figure>"
    return _SVG_IMG.sub(sub, html_text)


# ----------------------------------------------------------------------------
class Page:
    """Represents a single Markdown source (blog post or standalone)."""

    def __init__(self, src: pathlib.Path, meta: Dict[str, Any], body_md: str, html: str, is_post: bool):
        self.src = src
        self.meta = meta
        self.body_md = body_md
        self.html = html
        self.is_post = is_post
        self.slug = meta.get("slug") or src.stem
        self.date = self._parse_date(meta.get("date"), src)
        # A page with `parent: <post slug>` is a companion to that post (e.g. an
        # interactive table): it lives under the post's URL and stays out of the nav.
        self.parent_slug = meta.get("parent")
        if is_post:
            self.url = f"/blog/{self.slug}.html"
        elif self.parent_slug:
            self.url = f"/blog/{self.parent_slug}/{self.slug}.html"
        else:
            self.url = f"/{self.slug}.html"
        self.in_nav = not is_post and not self.parent_slug and meta.get("nav", True)
        self.excerpt = meta.get("summary") or self._make_excerpt()
        self.reading_minutes = max(1, round(len(body_md.split()) / 230))
        self.parent: "Page | None" = None      # linked up by Site._link_pages
        self.attachments: List["Page"] = []
        self.og_image = ""  # set by Site._render_og_images
        self.md_url = self.url.removesuffix(".html") + ".md"  # posts: Markdown source, for "Copy as Markdown"
        self.series: List["Page"] = []  # all posts sharing this post's `series:`, in order

    @staticmethod
    def _parse_date(raw: Any, src: pathlib.Path) -> dt.date:
        """Front-matter date as a `date`; falls back to the file's mtime."""
        if isinstance(raw, dt.datetime):
            return raw.date()
        if isinstance(raw, dt.date):
            return raw
        if raw is None:
            return dt.date.fromtimestamp(src.stat().st_mtime)
        # YAML only parses ASCII "2025-04-29" as a date; editors and LLMs like to
        # paste look-alike hyphens (e.g. U+2011), which would leave it a string.
        text = re.sub(r"[\u2010-\u2015\u2212]", "-", str(raw)).strip()
        try:
            return dt.date.fromisoformat(text[:10])
        except ValueError:
            raise ValueError(f"{src}: date {raw!r} is not YYYY-MM-DD") from None

    def _make_excerpt(self, words: int = 35):
        prose = re.sub(r'<pre.*?</pre>|<math.*?</math>|<a class="cite.*?</a>|<section class="footnotes">.*?</section>', " ", self.html, flags=re.S)
        plain = html.unescape(re.sub(r"<[^>]+>", " ", prose)).split()
        return " ".join(plain[:words]) + " …" if plain else ""


# ----------------------------------------------------------------------------
class Site:
    """Whole-site build orchestrator."""

    def __init__(self, root: pathlib.Path):
        self.root = root
        self.config = self._load_config()
        self.dist = root / "dist"
        self.dist.mkdir(exist_ok=True)
        self.pages: List[Page] = []
        self.env = jinja2.Environment(loader=jinja2.FileSystemLoader(str(root / "theme")), autoescape=True)
        # expose dt for templates
        self.env.globals["dt"] = dt
        # one-line Markdown from config.yml (tagline)
        self.env.filters["md_inline"] = lambda text: markupsafe.Markup(_MD.renderInline(text or ""))
        # titles: the last two words never split, so a wrapped title can't leave e.g. "1)" alone on a line
        self.env.filters["no_orphan"] = lambda text: markupsafe.Markup("&nbsp;").join(
            markupsafe.escape(part) for part in str(text or "").rsplit(" ", 1))

    # ---------------------------------------------------------------- config
    def _load_config(self):
        cfg = self.root / "config.yml"
        return yaml.safe_load(cfg.read_text("utf8")) if cfg.exists() else {}

    # ---------------------------------------------------------------- build
    def build(self):
        started = time.time()
        self.config = self._load_config()  # re-read so `serve` picks up config.yml edits
        self._discover()
        self._copy_static()
        self._build_css()
        self._render_og_images()
        self._render_pages()
        self._render_indexes()
        self._render_redirects()
        self._render_tags()
        self._render_feed()
        self._render_llms_txt()
        self._prune_dist(started)
        logging.info("Build finished → %s", self.dist)

    # ----------------------------------------------------------- discovery
    def _prune_dist(self, started: float):
        # Every build rewrites all its outputs, so anything older than this build is
        # left over from a deleted page or asset. Pruning afterwards (rather than
        # emptying dist/ first) means `serve` never serves a half-empty site.
        for f in sorted(self.dist.rglob("*"), reverse=True):
            if f.is_file() and f.stat().st_mtime < started:
                f.unlink()
            elif f.is_dir() and not any(f.iterdir()):
                f.rmdir()

    def _discover(self):
        self.pages = []
        content = self.root / "content"
        for md in content.rglob("*.md"):
            is_post = md.parts[-2] == "posts"
            meta, body = self._split_front(md.read_text("utf8"))
            html_body = _inline_figures(self._md_to_html(body), md.parent)
            if meta.get("bib"):
                html_body = self._apply_citations(html_body, md.parent / meta["bib"])
            self.pages.append(Page(md, meta, body, html_body, is_post))
        self._link_pages()

    def _link_pages(self):
        posts = {p.slug: p for p in self.pages if p.is_post}
        for pg in self.pages:
            if not pg.parent_slug:
                continue
            if pg.parent_slug not in posts:
                raise ValueError(f"{pg.src}: parent {pg.parent_slug!r} is not a post slug")
            pg.parent = posts[pg.parent_slug]
            pg.parent.attachments.append(pg)
        # `series: <name>` groups posts; ordered by `part:` if given, otherwise by date
        series: Dict[str, List[Page]] = {}
        for pg in posts.values():
            if pg.meta.get("series"):
                series.setdefault(pg.meta["series"], []).append(pg)
        for parts in series.values():
            parts.sort(key=lambda p: (p.meta.get("part", 0), p.date))
            for pg in parts:
                pg.series = parts

    @staticmethod
    def _split_front(text: str):
        if text.startswith("---"):
            _, fm, rest = text.split("---", 2)
            return yaml.safe_load(fm) or {}, rest.lstrip("\n")
        return {}, text

    def _md_to_html(self, md_text: str):
        # wrap tables so wide ones scroll sideways on phones instead of being cut off
        out = _footnote_previews(_MD.render(md_text))
        return out.replace("<table>", "<div class='table-scroll'><table>").replace("</table>", "</table></div>")

    # ----------------------------------------------------------- citations
    def _parse_author_name(self, raw: str) -> str:
        """
        Return one author in the form “Family, I.” (APA-like).

        Handles both “Family, Given” and “Given Family” BibTeX styles,
        removes braces, and converts all given names to initials.
        A braced name such as `{Prime Intellect}` is an organisation and stays as written.
        """
        raw = raw.strip()
        if raw.startswith("{") and raw.endswith("}"):
            return raw.strip("{}")
        if raw == "others":
            return "et al."
        raw = raw.replace("{", "").replace("}", "").strip()
        if "," in raw:                                   # “Family, Given …”
            fam, given = (s.strip() for s in raw.split(",", 1))
        else:                                            # “Given … Family”
            parts = raw.split()
            fam, given = parts[-1], " ".join(parts[:-1])
        initials = " ".join(f"{w[0]}." for w in given.split() if w)
        return f"{fam}, {initials}" if initials else fam

    def _parse_authors(self, field: str) -> List[str]:
        """Split the BibTeX 'author' field and format each name."""
        if not field:
            return ["Anon."]
        names = [self._parse_author_name(n) for n in field.replace("\n", " ").split(" and ")]
        return [n for n in names if n]                   # drop empties

    def _format_reference(self, entry: Dict[str, str]) -> str:
        """Very small APA-like formatter."""
        authors = self._parse_authors(entry.get("author", "Anon."))
        if authors[-1] == "et al.":
            authors_str = ", ".join(authors[:-1]) + " et al."
        else:
            authors_str = ", ".join(authors[:-1]) + f", & {authors[-1]}" if len(authors) > 1 else authors[0]
        year = entry.get("year", "n.d.")
        title_raw = entry.get("title", "[Untitled]") + "."
        url = entry.get("url") or (f"https://doi.org/{entry['doi']}" if "doi" in entry else "")
        title = f'<a href="{html.escape(url)}">{html.escape(title_raw)}</a>' if url else html.escape(title_raw)
        container = entry.get("journal") or entry.get("booktitle") or entry.get("publisher", "")
        pieces = [authors_str, f"({year}).", title]
        if container:
            pieces.append(container)
        return " ".join(pieces)

    def _apply_citations(self, html_text: str, bib_path: pathlib.Path):
        if not bib_path.exists():
            return html_text

        db = bibtexparser.loads(bib_path.read_text("utf8"))
        key_num: Dict[str, int] = {}
        refs: List[str] = []
        tooltips: Dict[str, str] = {}

        # ---- first pass: assign numbers & build ref / tooltip strings
        for key in _CITE_PAT.findall(html_text):
            if key in key_num:
                continue
            key_num[key] = len(refs) + 1
            entry = db.entries_dict.get(key, {})
            # full reference (all authors)
            refs.append(f'<li id="ref-{key}">{self._format_reference(entry)}</li>')
            # tooltip (max 2 authors)
            authors = self._parse_authors(entry.get("author", "Anon."))
            if len(authors) > 2:
                short_auth = ", ".join(authors[:2]) + " et al."
            else:
                short_auth = ", ".join(authors)
            tooltip = f"{short_auth} ({entry.get('year', 'n.d.')}) {entry.get('title', key)}."
            tooltips[key] = html.escape(tooltip, quote=True)

        # ---- replace in-text cites with hyperlinks
        def _sub(match: re.Match):
            cite_key = match.group(1)
            num = key_num[cite_key]
            tip = tooltips[cite_key]
            return f'<a class="cite" data-ref="{tip}" href="#ref-{cite_key}">[{num}]</a>'

        html_text = _CITE_PAT.sub(_sub, html_text)

        # ---- append reference section
        if refs:
            html_text += (
                "<h2 id='references'>References</h2>"
                "<ol class='references'>" + "".join(refs) + "</ol>"
            )
        return html_text


    # ------------------------------------------------------- social cards
    _OG_SIZE = (1200, 630)

    def _render_og_images(self):
        """Draw an Open Graph card per page (unless front matter sets `image:`) and one for the index."""
        site_name = self.config.get("site_name", "")
        domain = re.sub(r"^https?://", "", self.config.get("base_url", ""))
        for pg in self.pages:
            if pg.meta.get("image"):
                pg.og_image = pg.meta["image"]
                continue
            pg.og_image = "/og" + pg.url.removesuffix(".html") + ".png"
            footer = f"{domain}  ·  {pg.date:%-d %B %Y}" if pg.is_post else domain
            self._draw_og_card(pg.meta.get("title", pg.slug), site_name, footer, self.dist / pg.og_image.lstrip("/"))
        self._draw_og_card(site_name, "", self.config.get("description") or domain, self.dist / "og" / "index.png")

    def _draw_og_card(self, title: str, kicker: str, footer: str, dest: pathlib.Path):
        fonts = self.root / "theme" / "fonts"
        font_at = lambda size, bold=False: ImageFont.truetype(str(fonts / f"site-serif-{'bold' if bold else 'regular'}.ttf"), size)

        w, h = self._OG_SIZE
        pad = 80
        # colours mirror the light theme tokens in theme/site.css
        ink, muted = "#111111", "#666666"
        img = Image.new("RGB", (w, h), "#ffffff")      # --paper
        d = ImageDraw.Draw(img)
        small = font_at(30)
        if kicker:
            d.text((pad, pad), kicker, font=small, fill=muted)
        # largest title size (76 → 48px) that wraps into at most 4 lines
        for size in range(76, 47, -4):
            font = font_at(size, bold=True)
            lines = self._wrap(title, font, w - 2 * pad)
            if len(lines) <= 4:
                break
        line_h = round(size * 1.15)
        top = (h - line_h * len(lines)) // 2
        for i, line in enumerate(lines):
            d.text((pad, top + i * line_h), line, font=font, fill=ink)
        d.text((pad, h - pad - 30), footer, font=small, fill=muted)
        dest.parent.mkdir(parents=True, exist_ok=True)
        img.save(dest, optimize=True)

    @staticmethod
    def _wrap(text: str, font: Any, width: int) -> List[str]:
        lines: List[str] = []
        for word in text.split():
            if lines and font.getlength(f"{lines[-1]} {word}") <= width:
                lines[-1] += f" {word}"
            else:
                lines.append(word)
        return lines

    # ---------------------------------------------------------- rendering
    def _render_pages(self):
        t_post = self.env.get_template("post.html")
        t_page = self.env.get_template("page.html")
        today = dt.date.today()
        for pg in self.pages:
            ctx = {"site": self.config, "page": pg, "today": today, "pages": self.pages,
                   "bibtex": self._bibtex(pg) if pg.is_post else ""}
            tpl = t_post if pg.is_post else t_page
            out = tpl.render(**ctx)
            dest = self.dist / pg.url.lstrip("/")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(out, "utf8")
            if pg.is_post:
                (self.dist / pg.md_url.lstrip("/")).write_text(self._markdown_copy(pg), "utf8")

    def _bibtex(self, pg: Page) -> str:
        """A @misc entry for "Cite this post"."""
        author = self.config.get("author", "")
        *given, family = author.split() or ["Anon"]
        title = pg.meta.get("title", pg.slug)
        stop = {"a", "an", "the", "of", "on", "in", "and", "for", "to", "with", "through"}
        first = next((w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in stop), pg.slug)
        tex_title = re.sub(r"([&%#_$])", r"\\\1", title)
        fields = [
            f"  author = {{{family}, {' '.join(given)}}}" if given else f"  author = {{{family}}}",
            f"  title = {{{{{tex_title}}}}}",
            f"  year = {{{pg.date.year}}}",
            f"  month = {pg.date:%b}".lower(),
            f"  url = {{{self.config.get('base_url', '')}{pg.url}}}",
            "  note = {Blog post}",
        ]
        return f"@misc{{{family.lower()}{pg.date.year}{first},\n" + ",\n".join(fields) + "\n}"

    def _markdown_copy(self, pg: Page) -> str:
        """The post's Markdown as published: title and URL on top, site-relative links made absolute."""
        base = self.config.get("base_url", "")
        body = re.sub(r"(\]\(|href=[\"'])/", rf"\g<1>{base}/", pg.body_md.strip())
        return f"# {pg.meta.get('title', pg.slug)}\n\n{base}{pg.url}\n\n{body}\n"

    def _render_indexes(self):
        posts = sorted([p for p in self.pages if p.is_post], key=lambda x: x.date, reverse=True)
        tmpl = self.env.get_template("index.html")
        ctx = {"site": self.config, "posts": posts, "pages": self.pages, "today": dt.date.today()}
        # the home page lists every post; the old /blog/ archive forwards there
        (self.dist / "index.html").write_text(tmpl.render(**ctx), "utf8")
        self._write_redirect("/blog/index.html", "/")

    def _render_redirects(self):
        """`redirect_from: [/old.html]` in front matter leaves a stub that forwards to the new URL."""
        for pg in self.pages:
            for old in pg.meta.get("redirect_from", []):
                self._write_redirect(old, pg.url)

    def _write_redirect(self, old: str, new: str):
        target = html.escape(new)
        stub = (
            "<!DOCTYPE html><meta charset='utf-8'>"
            f"<title>Moved</title><link rel='canonical' href='{html.escape(self.config.get('base_url', ''))}{target}'>"
            f"<meta http-equiv='refresh' content='0; url={target}'>"
            f"<script>location.replace('{target}' + location.hash)</script>"
            f"<p>This page has moved to <a href='{target}'>{target}</a>.</p>"
        )
        dest = self.dist / old.lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(stub, "utf8")

    def _render_tags(self):
        by_tag: Dict[str, List[Page]] = {}
        for pg in self.pages:
            for tag in pg.meta.get("tags", []):
                by_tag.setdefault(tag, []).append(pg)
        tmpl = self.env.get_template("tag.html")
        tag_dir = self.dist / "blog" / "tags"
        for tag, pages in by_tag.items():
            out = tmpl.render(tag=tag, tag_pages=pages, pages=self.pages, site=self.config, today=dt.date.today())
            dest = tag_dir / f"{tag}.html"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(out, "utf8")

    # ------------------------------------------------------------ feed
    def _render_feed(self):
        from xml.sax.saxutils import escape, quoteattr
        base = self.config.get("base_url", "")
        posts = sorted([p for p in self.pages if p.is_post], key=lambda x: x.date, reverse=True)[:20]

        def rfc822(d: dt.date) -> str:
            return email.utils.format_datetime(dt.datetime.combine(d, dt.time(), dt.timezone.utc))

        def absolute(body: str, page_url: str) -> str:
            # feed readers have no base URL: make /site and #fragment links absolute
            body = re.sub(r"""(href|src)=(["'])/(?!/)""", rf"\1=\2{base}/", body)
            return re.sub(r"""href=(["'])#""", rf"href=\1{base}{page_url}#", body)

        items = "".join(f"""
    <item>
      <title>{escape(p.meta.get("title", p.slug))}</title>
      <link>{base}{p.url}</link>
      <guid isPermaLink="true">{base}{p.url}</guid>
      <pubDate>{rfc822(p.date)}</pubDate>
      <description>{escape(p.excerpt)}</description>
      <content:encoded>{escape(absolute(p.html, p.url))}</content:encoded>
    </item>""" for p in posts)
        updated = rfc822(max((p.date for p in posts), default=dt.date.today()))
        rss = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>{escape(self.config.get("site_name", "My Blog"))}</title>
    <link>{base}/</link>
    <description>{escape(self.config.get("description", ""))}</description>
    <language>{escape(self.config.get("language", "en"))}</language>
    <lastBuildDate>{updated}</lastBuildDate>
    <atom:link href={quoteattr(base + "/feed.xml")} rel="self" type="application/rss+xml"/>{items}
  </channel>
</rss>
"""
        (self.dist / "feed.xml").write_text(rss, "utf8")

    def _render_llms_txt(self):
        """/llms.txt (llmstxt.org): a plain index pointing at the Markdown copies of the posts."""
        base = self.config.get("base_url", "")
        unlink = lambda text: re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text or "")
        lines = [f"# {self.config.get('site_name', '')}", ""]
        if self.config.get("description"):
            lines += [f"> {self.config['description']}", ""]
        if self.config.get("tagline"):
            lines += [f"{self.config.get('author', '')}: {unlink(self.config['tagline'])}.", ""]
        posts = sorted((p for p in self.pages if p.is_post), key=lambda p: p.date, reverse=True)
        lines += ["## Posts", ""] + [f"- [{p.meta.get('title', p.slug)}]({base}{p.md_url}): {p.excerpt}" for p in posts]
        if self.config.get("projects"):
            lines += ["", "## Projects", ""]
            lines += [f"- [{pr['title']}]({pr['url']}): {pr.get('description', '')}".rstrip(": ") for pr in self.config["projects"]]
        if self.config.get("elsewhere"):
            lines += ["", "## Elsewhere", ""]
            lines += [f"- [{e['title']}]({e['url']}): {e.get('note', '')}".rstrip(": ") for e in self.config["elsewhere"]]
        (self.dist / "llms.txt").write_text("\n".join(lines) + "\n", "utf8")

    # ------------------------------------------------------ asset helpers
    def _copy_static(self):
        static = self.root / "static"
        if static.exists():
            # plain copy (not copy2) so files get a fresh mtime – see _prune_dist
            shutil.copytree(static, self.dist / "static", dirs_exist_ok=True, copy_function=shutil.copy)

    def _build_css(self):
        """theme/site.css + the Pygments token colours (light, and dark under .dark) → dist/site.css."""
        parts = [(self.root / "theme" / "site.css").read_text("utf8"), "/* ---- code highlighting (Pygments) ---- */"]
        for prefix, style in _PYGMENTS_STYLES.items():
            sel = f"{prefix}pre.highlight"
            # keep only the token rules; Pygments also emits global pre/line-number rules we don't use
            defs = HtmlFormatter(style=style).get_style_defs(sel).splitlines()
            parts += [line for line in defs if line.startswith(sel + " .")]
        (self.dist / "site.css").write_text("\n".join(parts) + "\n", "utf8")

# ----------------------------------------------------------------------------
# Dev server: serves dist/ and rebuilds when a source file changes
# ----------------------------------------------------------------------------

def _source_mtimes(root: pathlib.Path) -> Dict[pathlib.Path, float]:
    files = [root / "config.yml", pathlib.Path(__file__).resolve()]
    for d in ("content", "theme", "static"):
        files += [f for f in (root / d).rglob("*") if f.is_file() and not f.name.startswith(".")]
    return {f: f.stat().st_mtime for f in files if f.exists()}

def _serve(site: Site, port: int):
    def run_server():
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site.dist))
        socketserver.TCPServer.allow_reuse_address = True  # restart without waiting for the old socket
        with socketserver.TCPServer(("", port), handler) as httpd:
            print(f"Serving on http://localhost:{port} – press Ctrl+C to stop")
            httpd.serve_forever()
    threading.Thread(target=run_server, daemon=True).start()

    seen = _source_mtimes(site.root)
    try:
        while True:
            time.sleep(0.5)
            now = _source_mtimes(site.root)
            if now == seen:
                continue
            changed = sorted(str(f.relative_to(site.root)) if f.is_relative_to(site.root) else str(f)
                             for f in now.keys() | seen.keys() if now.get(f) != seen.get(f))
            seen = now
            logging.info("[watch] changed: %s", ", ".join(changed))
            if now.get(pathlib.Path(__file__).resolve()) != _start_mtime:
                # the generator itself changed: restart so the new code is used
                logging.info("[watch] pyssg.py changed, restarting")
                os.execv(sys.executable, [sys.executable, str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])
            try:
                site.build()
            except Exception:
                logging.exception("Build failed")
    except KeyboardInterrupt:
        pass

_start_mtime = pathlib.Path(__file__).resolve().stat().st_mtime

# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def _cli():
    ap = argparse.ArgumentParser(prog="pyssg", description="Tiny SSG")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("build")
    ps = sub.add_parser("serve")
    ps.add_argument("-p", "--port", type=int, default=8000)
    args = ap.parse_args()
    site = Site(pathlib.Path.cwd())
    if args.cmd == "build":
        site.build()
    elif args.cmd == "serve":
        site.build()
        _serve(site, args.port)
    else:
        ap.print_help()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
    _cli()
