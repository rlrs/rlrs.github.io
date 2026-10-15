// Post pages: table of contents, links to sections, and copy buttons. No dependencies.

// Copy text (or a promise of text) to the clipboard. A ClipboardItem holding a promise
// keeps Safari's user-gesture check happy when the text has to be fetched first.
async function copy(text) {
  if (typeof text !== "string" && window.ClipboardItem) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  }
  return navigator.clipboard.writeText(await text);
}

// Show `message` in `el` for a moment, then put the old text back.
function flash(el, message) {
  const old = el.dataset.label ??= el.textContent;
  el.textContent = message;
  clearTimeout(el.flashTimer);
  el.flashTimer = setTimeout(() => { el.textContent = old; }, 1500);
}

const headings = [...document.querySelectorAll("article .prose h2, article .prose h3")];
const canCopy = !!navigator.clipboard;

/* ---- table of contents: sidebar on wide screens, collapsible box above the text otherwise ---- */
if (headings.length) {
  const toc = document.getElementById("toc");
  const top = document.querySelector(".toc-top");
  toc.hidden = top.hidden = false;
  const fill = (list) => headings.map((h) => {
    const a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent;
    if (h.tagName === "H3") a.className = "sub";
    list.appendChild(document.createElement("li")).appendChild(a);
    return a;
  });
  fill(top.querySelector("ol"));
  const links = fill(toc.querySelector("ol"));
  // highlight the section whose heading was passed most recently
  const update = () => {
    let cur = 0;
    headings.forEach((h, i) => { if (h.getBoundingClientRect().top < 120) cur = i; });
    links.forEach((a, i) => a.classList.toggle("active", i === cur));
  };
  update();
  addEventListener("scroll", update, { passive: true });
  // the jump to a #section can land after load without a scroll event
  addEventListener("load", () => setTimeout(update, 100));
  addEventListener("hashchange", update);
}

/* ---- "#" after each heading: jumps to the section and copies its link ---- */
for (const h of headings) {
  const a = document.createElement("a");
  a.className = "anchor";
  a.href = "#" + h.id;
  a.textContent = "#";
  a.setAttribute("aria-label", "Link to this section");
  a.addEventListener("click", () => {
    if (!canCopy) return;
    copy(location.origin + location.pathname + "#" + h.id).then(() => flash(a, "Link copied"), () => {});
  });
  h.append(" ", a);
}

if (canCopy) {
  /* ---- "Copy as Markdown": the post's source, published next to the page at build time ---- */
  const md = document.querySelector(".copy-md");
  const label = md.querySelector("span");
  md.hidden = false;
  md.addEventListener("click", () => {
    const text = fetch(md.dataset.src).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
    copy(text).then(() => flash(label, "Copied"), (err) => { console.error("Copy failed", err); flash(label, "Copy failed"); });
  });

  /* ---- copy button on code blocks (including the BibTeX entry) ---- */
  for (const pre of document.querySelectorAll("article pre")) {
    const wrap = document.createElement("div");
    wrap.className = "code";
    pre.replaceWith(wrap);
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      copy(pre.innerText.replace(/\n$/, "")).then(() => flash(btn, "Copied"), () => flash(btn, "Copy failed"));
    });
    wrap.append(pre, btn);
  }
}
