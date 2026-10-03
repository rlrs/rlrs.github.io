"""
pyssg — A minimal yet capable Python static‑site generator for blogs & pages.

Main features
-------------
* **Blog posts & standalone pages** handled with Markdown + YAML front‑matter.
* **Theme‑first design** – layouts live in a `theme/` folder; swap or tweak at will.
* **KaTeX math** – `$…$` / `$$…$$` parsed at build time, typeset in the browser.
* **Per‑page BibTeX citations** using the simple `[@key]` syntax.
* **Syntax highlighting** via Pygments (CSS emitted once per build).
* **Tailwind CSS** compiled from `theme/site.css` by the standalone CLI (no Node needed).
* **Social cards** – a 1200×630 Open Graph image per page, drawn with Pillow.
* **RSS feed, tag listings, static asset copy, dev server** – the niceties you expect.

Minimal, well‑known deps only: `markdown‑it‑py`, `mdit-py-plugins`, `PyYAML`, `Pygments`, `Jinja2`,
`bibtexparser`, `watchdog`.

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
import textwrap
from typing import Any, Dict, List

import bibtexparser  # type: ignore
import jinja2  # type: ignore
import yaml  # type: ignore
from markdown_it import MarkdownIt  # type: ignore
from mdit_py_plugins.anchors import anchors_plugin  # type: ignore
from mdit_py_plugins.dollarmath import dollarmath_plugin  # type: ignore
import pytailwindcss  # type: ignore
from PIL import Image, ImageDraw, ImageFont  # type: ignore
from pygments import highlight  # type: ignore
from pygments.formatters import HtmlFormatter  # type: ignore
from pygments.lexers import TextLexer, get_lexer_by_name  # type: ignore
from watchdog.observers import Observer  # type: ignore
from watchdog.events import FileSystemEventHandler  # type: ignore

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
# Emits <span class="math inline"> / <div class="math block"> with escaped TeX, which
# theme/base.html typesets with KaTeX. allow_space/allow_digits off so prose like
# "$5 and $10" stays plain text.
dollarmath_plugin(_MD, allow_space=False, allow_digits=False)
# ids on h2/h3 at build time, so #section links work and the post TOC can use them
anchors_plugin(_MD, min_level=2, max_level=3)

_TAILWIND_VERSION = "v4.3.3"  # pinned so local and CI builds match

_CITE_PAT = re.compile(r"\[@([^\]]+)\]")


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
        prose = re.sub(r'<pre.*?</pre>|<(span|div) class="math.*?</\1>', " ", self.html, flags=re.S)
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

    # ---------------------------------------------------------------- config
    def _load_config(self):
        cfg = self.root / "config.yml"
        return yaml.safe_load(cfg.read_text("utf8")) if cfg.exists() else {}

    # ---------------------------------------------------------------- build
    def build(self):
        started = time.time()
        self._discover()
        self._copy_static()
        self._emit_pygments_css()
        self._build_css()
        self._render_og_images()
        self._render_pages()
        self._render_indexes()
        self._render_redirects()
        self._render_tags()
        self._render_feed()
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
            html_body = self._md_to_html(body)
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

    @staticmethod
    def _split_front(text: str):
        if text.startswith("---"):
            _, fm, rest = text.split("---", 2)
            return yaml.safe_load(fm) or {}, rest.lstrip("\n")
        return {}, text

    def _md_to_html(self, md_text: str):
        # wrap tables so wide ones scroll sideways on phones instead of being cut off
        out = _MD.render(md_text)
        return out.replace("<table>", "<div class='overflow-x-auto'><table>").replace("</table>", "</table></div>")

    # ----------------------------------------------------------- citations
    def _parse_author_name(self, raw: str) -> str:
        """
        Return one author in the form “Family, I.” (APA-like).

        Handles both “Family, Given” and “Given Family” BibTeX styles,
        removes braces, and converts all given names to initials.
        """
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
        serif, regular = fonts / "SourceSerif4-Semibold.ttf", fonts / "Inter-Regular.ttf"
        w, h = self._OG_SIZE
        pad = 80
        # colours mirror the light theme tokens in theme/site.css
        ink, muted, accent = "#1d1c1a", "#75716a", "#0f766e"
        img = Image.new("RGB", (w, h), "#fbfaf7")      # --paper
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, w, 10], fill=accent)
        small = ImageFont.truetype(str(regular), 30)
        if kicker:
            d.text((pad, pad), kicker, font=small, fill=muted)
        # largest title size (76 → 48px) that wraps into at most 4 lines
        for size in range(76, 47, -4):
            font = ImageFont.truetype(str(serif), size)
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
            ctx = {"site": self.config, "page": pg, "today": today, "pages": self.pages}
            tpl = t_post if pg.is_post else t_page
            out = tpl.render(**ctx)
            dest = self.dist / pg.url.lstrip("/")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(out, "utf8")

    def _render_indexes(self):
        posts = sorted([p for p in self.pages if p.is_post], key=lambda x: x.date, reverse=True)
        tmpl = self.env.get_template("index.html")
        ctx = {"site": self.config, "posts": posts, "pages": self.pages, "today": dt.date.today()}
        # home page: intro (config `intro`, Markdown) + posts; /blog/: just the archive
        intro = _MD.render(self.config.get("intro", ""))
        (self.dist / "index.html").write_text(tmpl.render(home=True, intro=intro, **ctx), "utf8")
        blog_dir = self.dist / "blog"
        blog_dir.mkdir(exist_ok=True)
        (blog_dir / "index.html").write_text(tmpl.render(home=False, **ctx), "utf8")

    def _render_redirects(self):
        """`redirect_from: [/old.html]` in front matter leaves a stub that forwards to the new URL."""
        for pg in self.pages:
            for old in pg.meta.get("redirect_from", []):
                target = html.escape(pg.url)
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
        from xml.sax.saxutils import escape
        posts = sorted([p for p in self.pages if p.is_post], key=lambda x: x.date, reverse=True)[:20]
        items = [textwrap.dedent(f"""
          <item>
            <title>{escape(p.meta.get('title',''))}</title>
            <link>{self.config.get('base_url','')}{p.url}</link>
            <guid>{self.config.get('base_url','')}{p.url}</guid>
            <pubDate>{email.utils.format_datetime(dt.datetime.combine(p.date, dt.time(), dt.timezone.utc))}</pubDate>
            <description><![CDATA[{p.excerpt}]]></description>
          </item>""") for p in posts]
        rss = textwrap.dedent(f"""<?xml version='1.0' encoding='UTF-8'?>
            <rss version='2.0'><channel>
              <title>{escape(self.config.get('site_name','My Blog'))}</title>
              <link>{self.config.get('base_url','')}</link>
              <description>{escape(self.config.get('description',''))}</description>
              {''.join(items)}
            </channel></rss>""")
        (self.dist / "feed.xml").write_text(rss, "utf8")

    # ------------------------------------------------------ asset helpers
    def _copy_static(self):
        static = self.root / "static"
        if static.exists():
            # plain copy (not copy2) so files get a fresh mtime – see _prune_dist
            shutil.copytree(static, self.dist / "static", dirs_exist_ok=True, copy_function=shutil.copy)

    def _emit_pygments_css(self):
        css = "\n".join(HtmlFormatter(style=style).get_style_defs(f"{prefix}pre.highlight")
                        for prefix, style in _PYGMENTS_STYLES.items())
        (self.dist / "pygments.css").write_text(css, "utf8")

    def _build_css(self):
        src = self.root / "theme" / "site.css"
        if not src.exists():
            return
        out = self.dist / "site.css"
        # Downloads the pinned standalone Tailwind binary on first use.
        log = pytailwindcss.run(
            ["-i", str(src), "-o", str(out), "--minify"],
            cwd=self.root, auto_install=True, version=_TAILWIND_VERSION,
        )
        if not out.exists():
            raise RuntimeError(f"Tailwind produced no {out}:\n{log}")
        out.touch()  # Tailwind skips unchanged output; keep it from looking stale to _prune_dist

# ----------------------------------------------------------------------------
# Live‑reload dev server using watchdog
# ----------------------------------------------------------------------------

def _serve(site: Site, port: int):
    def run_server():
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site.dist))
        socketserver.TCPServer.allow_reuse_address = True  # restart without waiting for the old socket
        with socketserver.TCPServer(("", port), handler) as httpd:
            print(f"Serving on http://localhost:{port} – press Ctrl+C to stop")
            httpd.serve_forever()
    threading.Thread(target=run_server, daemon=True).start()

    class RebuildHandler(FileSystemEventHandler):
        def __init__(self):
            super().__init__()
            self._last = 0.0  # debounce
        def on_any_event(self, event):
            if event.is_directory:
                return
            # ignore changes inside the output folder
            if pathlib.Path(event.src_path).is_relative_to(site.dist):
                return
            # ignore dotfiles
            if any(part.startswith(".") for part in pathlib.Path(event.src_path).parts):
                return
            # debounce rapid duplicate events from editors (200 ms)
            now = time.time()
            if now - self._last < 0.2:
                return
            self._last = now
            logging.info("[watch] change detected: %s", event.src_path)
            if pathlib.Path(event.src_path).resolve() == pathlib.Path(__file__).resolve():
                # the generator itself changed: restart so the new code is used
                logging.info("[watch] pyssg.py changed, restarting")
                os.execv(sys.executable, [sys.executable, str(pathlib.Path(__file__).resolve()), *sys.argv[1:]])
            site.build()
    observer = Observer()
    watch_dirs = [site.root/"content", site.root/"theme", site.root/"static", site.root]
    for p in watch_dirs:
        observer.schedule(RebuildHandler(), str(p), recursive=True)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        observer.join()

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
