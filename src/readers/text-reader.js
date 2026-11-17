import { escHtml, bindWordLookupEvents } from "../services/dictionary.js";

function renderInlineMd(text) {
  return escHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function parseDocumentBlocks(rawText, isMarkdown) {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const toc = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (isMarkdown && trimmed.startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(`<pre><code>${escHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (isMarkdown) {
      const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const label = hMatch[2].trim();
        const id = `sec-${toc.length + 1}`;
        toc.push({ label, target: id });
        blocks.push(`<h${level} id="${id}">${renderInlineMd(label)}</h${level}>`);
        i++;
        continue;
      }

      if (trimmed.startsWith(">")) {
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        blocks.push(`<blockquote>${renderInlineMd(quoteLines.join(" "))}</blockquote>`);
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          items.push(`<li>${renderInlineMd(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`);
          i++;
        }
        blocks.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim()) {
      const cur = lines[i].trim();
      if (isMarkdown && (/^(#{1,3})\s+/.test(cur) || cur.startsWith("```") || cur.startsWith(">") || /^[-*]\s+/.test(cur))) {
        break;
      }
      paraLines.push(cur);
      i++;
    }
    const content = isMarkdown ? renderInlineMd(paraLines.join(" ")) : escHtml(paraLines.join(" "));
    blocks.push(`<p>${content}</p>`);
  }

  return { html: blocks.join("\n"), toc };
}

export async function extractTextMetadata(arrayBuffer, fallbackTitle, format) {
  const text = new TextDecoder("utf-8").decode(arrayBuffer);
  let title = fallbackTitle;
  if (format === "MD") {
    const firstHeading = text.match(/^#\s+(.+)$/m);
    if (firstHeading) title = firstHeading[1].trim();
  }
  return {
    title,
    author: format === "MD" ? "Markdown" : "Plain Text",
    coverDataUrl: null
  };
}

export class TextController {
  constructor(opts) {
    this.mountEl = opts.container;
    this.data = opts.data;
    this.format = opts.format || "TXT";
    this.lastLocation = Number(opts.lastLocation) || 0;
    this.settings = { ...opts.settings };
    this.onRelocated = opts.onRelocated;
    this.onTocReady = opts.onTocReady;
    this.onWordLookup = opts.onWordLookup;
    this.totalWords = 0;
    this.scrollerEl = null;
    this.articleEl = null;
    this._scrollRaf = 0;
  }

  async mount() {
    const raw = new TextDecoder("utf-8").decode(this.data);
    const { html, toc } = parseDocumentBlocks(raw, this.format === "MD");
    this.totalWords = raw.trim() ? raw.trim().split(/\s+/).length : 0;

    this.mountEl.innerHTML = "";
    const scroller = document.createElement("div");
    scroller.className = "text-reader-scroll";
    scroller.style.cssText = "width:100%;height:100%;overflow-y:auto;padding:24px 20px 56px;box-sizing:border-box;";

    const article = document.createElement("article");
    article.className = "text-reader-page";
    article.innerHTML = html || "<p>Empty document.</p>";

    scroller.appendChild(article);
    this.mountEl.appendChild(scroller);
    this.scrollerEl = scroller;
    this.articleEl = article;

    this.refreshThemeAndTypography();
    this.tocItems = toc;
    this.onTocReady?.(toc);

    if (this.lastLocation > 0 && this.lastLocation <= 1) {
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      if (maxScroll > 0) scroller.scrollTop = Math.round(maxScroll * this.lastLocation);
    }

    scroller.addEventListener("scroll", () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        this._emitProgress();
      });
    }, { passive: true });

    bindWordLookupEvents(article, window, (word, x, y) => this.onWordLookup?.(word, x, y));

    article.addEventListener("click", (e) => {
      if ((this.settings.readingFormat || "editorial") !== "focus") return;
      const p = e.target?.closest?.("p");
      if (!p) return;
      article.querySelectorAll("p.folio-focus-active").forEach((el) => el.classList.remove("folio-focus-active"));
      p.classList.add("folio-focus-active");
    });

    this._emitProgress();
  }

  _emitProgress() {
    if (!this.scrollerEl) return;
    const maxScroll = Math.max(1, this.scrollerEl.scrollHeight - this.scrollerEl.clientHeight);
    const ratio = this.scrollerEl.scrollHeight <= this.scrollerEl.clientHeight
      ? 1
      : Math.min(1, Math.max(0, this.scrollerEl.scrollTop / maxScroll));
    const progress = Math.round(ratio * 100);
    const wordsLeft = Math.round(this.totalWords * (1 - ratio));
    const minsLeft = Math.max(1, Math.round(wordsLeft / 230));
    const eta = progress >= 99 ? "Finished" : `~${minsLeft} min left`;
    let tocTarget = null;
    if (this.tocItems?.length && this.articleEl) {
      const topY = this.scrollerEl.scrollTop + 48;
      for (const item of this.tocItems) {
        const el = this.articleEl.querySelector(`#${CSS.escape(item.target)}`);
        if (el && el.offsetTop <= topY) tocTarget = item.target;
      }
    }
    this.onRelocated?.({
      location: ratio,
      progress,
      label: `${progress}% · ${eta}`,
      tocTarget
    });
  }

  refreshThemeAndTypography() {
    if (!this.articleEl) return;
    const fmt = this.settings.readingFormat || "editorial";
    const font = this.settings.fontFamily || '"Newsreader", Georgia, serif';
    const size = `${this.settings.fontSize || 18}px`;
    const lh = String(this.settings.lineHeight || 1.76);

    this.articleEl.dataset.format = fmt;
    this.articleEl.style.cssText = `
      max-width: 64ch;
      margin: 0 auto;
      padding: 36px 42px 60px;
      background: var(--bg-page);
      color: var(--text-main);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: var(--shadow);
      font-family: ${font};
      font-size: ${size};
      line-height: ${lh};
      hyphens: none;
    `;

    let styleEl = document.getElementById("text-reader-dynamic-css");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "text-reader-dynamic-css";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      .text-reader-page h1, .text-reader-page h2, .text-reader-page h3 {
        line-height: 1.24;
        margin: 1.2em 0 0.55em;
      }
      .text-reader-page blockquote {
        margin: 1.1em 0;
        padding: 0.2em 0 0.2em 1.1em;
        border-left: 3px solid var(--accent);
        color: var(--text-muted);
        font-style: italic;
      }
      .text-reader-page pre {
        padding: 0.9em 1.1em;
        border-radius: 8px;
        background: color-mix(in srgb, var(--text-main) 6%, transparent);
        overflow-x: auto;
        font-size: 0.85em;
      }
      .text-reader-page[data-format="editorial"] p { margin: 0 0 1.05em; }
      .text-reader-page[data-format="book"] p { margin: 0 0 0.28em; text-indent: 1.55em; }
      .text-reader-page[data-format="book"] h1 + p,
      .text-reader-page[data-format="book"] h2 + p,
      .text-reader-page[data-format="book"] h3 + p,
      .text-reader-page[data-format="book"] p:first-child { text-indent: 0; }
      .text-reader-page[data-format="focus"] p {
        margin: 0 0 1.1em;
        padding: 8px 12px;
        border-radius: 8px;
        border-left: 2px solid transparent;
        opacity: 0.54;
        cursor: pointer;
        transition: opacity 180ms cubic-bezier(0.23,1,0.32,1), background-color 180ms cubic-bezier(0.23,1,0.32,1);
      }
      .text-reader-page[data-format="focus"] p.folio-focus-active {
        opacity: 1;
        background-color: color-mix(in srgb, var(--accent) 7%, transparent);
        border-left-color: var(--accent);
      }
    `;

    if (fmt === "focus" && !this.articleEl.querySelector("p.folio-focus-active")) {
      const firstP = [...this.articleEl.querySelectorAll("p")].find((el) => el.textContent.trim().length > 20);
      firstP?.classList.add("folio-focus-active");
    }
  }

  async updateSettings(nextSettings) {
    this.settings = { ...this.settings, ...nextSettings };
    this.refreshThemeAndTypography();
  }

  prev() {
    this.scrollerEl?.scrollBy({ top: -Math.round(this.scrollerEl.clientHeight * 0.85), behavior: "smooth" });
  }

  next() {
    this.scrollerEl?.scrollBy({ top: Math.round(this.scrollerEl.clientHeight * 0.85), behavior: "smooth" });
  }

  goTo(target) {
    if (typeof target === "number" && this.scrollerEl) {
      const maxScroll = Math.max(1, this.scrollerEl.scrollHeight - this.scrollerEl.clientHeight);
      this.scrollerEl.scrollTo({ top: Math.round(maxScroll * target), behavior: "smooth" });
      return;
    }
    const el = typeof target === "string" ? this.articleEl?.querySelector(`#${CSS.escape(target)}`) : null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  getBookmarkPayload() {
    if (!this.scrollerEl) return null;
    const maxScroll = Math.max(1, this.scrollerEl.scrollHeight - this.scrollerEl.clientHeight);
    const ratio = Math.min(1, Math.max(0, this.scrollerEl.scrollTop / maxScroll));
    return {
      id: "bm-" + Date.now(),
      location: ratio,
      label: `${Math.round(ratio * 100)}% mark`,
      createdAt: Date.now()
    };
  }

  destroy() {
    if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
    this.mountEl.innerHTML = "";
  }
}
