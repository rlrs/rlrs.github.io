"""
pyssg — A minimal yet capable Python static‑site generator for blogs & pages.

Main features
-------------
* **Blog posts & standalone pages** handled with Markdown + YAML front‑matter.
* **Theme‑first design** – layouts live in a `theme/` folder; swap or tweak at will.
* **KaTeX math** left intact so the browser (via auto‑render) does the heavy lifting.
* **Per‑page BibTeX citations** using the simple `[@key]` syntax.
* **Syntax highlighting** via Pygments (CSS emitted once per build).
* **RSS feed, tag listings, static asset copy, dev server** – the niceties you expect.

Minimal, well‑known deps only: `markdown‑it‑py`, `PyYAML`, `Pygments`, `Jinja2`, `bibtexparser`.

Run `pip install markdown-it-py PyYAML Pygments Jinja2 bibtexparser`

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
    python pyssg.py serve -p 9000   # build & live‑serve http://localhost:9000
"""

import argparse
import datetime as dt
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
import textwrap
import uuid
from typing import Any, Dict, List

import bibtexparser  # type: ignore
import jinja2  # type: ignore
import yaml  # type: ignore
from markdown_it import MarkdownIt  # type: ignore
from pygments import highlight  # type: ignore
from pygments.formatters import HtmlFormatter  # type: ignore
from pygments.lexers import TextLexer, get_lexer_by_name  # type: ignore
from watchdog.observers import Observer  # type: ignore
from watchdog.events import FileSystemEventHandler  # type: ignore

# ----------------------------------------------------------------------------
# Markdown helpers
# ----------------------------------------------------------------------------

def _highlight(code: str, lang: str, *_):
    try:
        lexer = get_lexer_by_name(lang)
    except Exception:
        lexer = TextLexer()
    return highlight(code, lexer, HtmlFormatter(nowrap=True))

_MD = MarkdownIt("commonmark", {"linkify": True, "html": True}).enable("table")
_MD.options["highlight"] = _highlight

_MATH_PAT = re.compile(r"(?P<delim>\${1,2})(?P<math>.+?)\1", re.S)
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
        self.date = meta.get("date") or src.stat().st_mtime
        self.url = f"/blog/{self.slug}.html" if is_post else f"/{self.slug}.html"
        self.excerpt = meta.get("summary") or self._make_excerpt()

    def _make_excerpt(self, words: int = 35):
        plain = re.sub(r"[`*_>#+-]", "", self.body_md)
        return " ".join(plain.split()[:words]) + " …"


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
        self._discover()
        self._copy_static()
        self._emit_pygments_css()
        self._render_pages()
        self._render_indexes()
        self._render_tags()
        self._render_feed()
        logging.info("Build finished → %s", self.dist)

    # ----------------------------------------------------------- discovery
    def _discover(self):
        content = self.root / "content"
        for md in content.rglob("*.md"):
            is_post = md.parts[-2] == "posts"
            meta, body = self._split_front(md.read_text("utf8"))
            html_body = self._md_to_html(body)
            if meta.get("bib"):
                html_body = self._apply_citations(html_body, md.parent / meta["bib"])
            self.pages.append(Page(md, meta, body, html_body, is_post))

    @staticmethod
    def _split_front(text: str):
        if text.startswith("---"):
            _, fm, rest = text.split("---", 2)
            return yaml.safe_load(fm) or {}, rest.lstrip("\n")
        return {}, text

    def _md_to_html(self, md_text: str):
        placeholders: Dict[str, str] = {}

        def _stash(m):
            tok = f"@@MATH_{uuid.uuid4().hex}@@"
            placeholders[tok] = m.group(0)
            return tok

        tmp = _MATH_PAT.sub(_stash, md_text)
        html_out = _MD.render(tmp)
        for tok, raw in placeholders.items():
            html_out = html_out.replace(tok, raw)
        return html_out

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
        ctx = {"site": self.config, "posts": posts, "pages": self.pages, "today": dt.date.today()}
        html_index = self.env.get_template("index.html").render(**ctx)
        (self.dist / "index.html").write_text(html_index, "utf8")
        blog_dir = self.dist / "blog"
        blog_dir.mkdir(exist_ok=True)
        (blog_dir / "index.html").write_text(html_index, "utf8")

    def _render_tags(self):
        by_tag: Dict[str, List[Page]] = {}
        for pg in self.pages:
            for tag in pg.meta.get("tags", []):
                by_tag.setdefault(tag, []).append(pg)
        tmpl = self.env.get_template("tag.html")
        tag_dir = self.dist / "blog" / "tags"
        for tag, pages in by_tag.items():
            out = tmpl.render(tag=tag, pages=pages, site=self.config, pages_all=self.pages, today=dt.date.today())
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
            <pubDate>{p.date}</pubDate>
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
            shutil.copytree(static, self.dist / "static", dirs_exist_ok=True)

    def _emit_pygments_css(self):
        (self.dist / "pygments.css").write_text(HtmlFormatter().get_style_defs(".codehilite"), "utf8")

# ----------------------------------------------------------------------------
# Live‑reload dev server using watchdog
# ----------------------------------------------------------------------------

def _serve(site: Site, port: int):
    def run_server():
        os.chdir(site.dist)
        with socketserver.TCPServer(("", port), http.server.SimpleHTTPRequestHandler) as httpd:
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
