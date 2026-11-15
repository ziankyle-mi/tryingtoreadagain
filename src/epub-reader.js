import ePub from "epubjs";
import JSZip from "jszip";
import { extractWordAtPoint, extractSelectedWord } from "./dictionary.js";

window.JSZip = JSZip;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function extractEpubMetadata(arrayBuffer, fallbackTitle) {
  const book = ePub(arrayBuffer.slice(0));
  try {
    await book.ready;
    const meta = (await book.loaded.metadata) || {};
    let coverDataUrl = null;
    try {
      const coverUrl = await book.coverUrl();
      if (coverUrl) {
        const res = await fetch(coverUrl);
        if (res.ok) {
          const blob = await res.blob();
          coverDataUrl = await blobToDataUrl(blob);
        }
        URL.revokeObjectURL(coverUrl);
      }
    } catch {
      coverDataUrl = null;
    }

    return {
      title: (meta.title || "").trim() || fallbackTitle,
      author: (meta.creator || "").trim() || "Unknown Author",
      coverDataUrl
    };
  } finally {
    book.destroy();
  }
}

export class EpubController {
  constructor({ container, data, lastLocation, settings, onRelocated, onTocReady, onWordLookup }) {
    this.container = container;
    this.data = data;
    this.lastLocation = lastLocation;
    this.settings = { ...settings };
    this.onRelocated = onRelocated;
    this.onTocReady = onTocReady;
    this.onWordLookup = onWordLookup;
    this.book = null;
    this.rendition = null;
    this.locationsReady = false;
    this.currentCfi = lastLocation || null;
    this.wrapEl = null;
    this.mountEl = null;
    this.gutterEl = null;
    this.resizeObserver = null;
    this._resizeTimer = null;
    this._lastSize = { w: 0, h: 0 };
  }

  async mount() {
    this.container.innerHTML = "";
    this.wrapEl = document.createElement("div");
    this.mountEl = document.createElement("div");
    this.mountEl.className = "epub-mount";
    this.gutterEl = document.createElement("div");
    this.gutterEl.className = "epub-center-gutter";
    this.wrapEl.appendChild(this.mountEl);
    this.wrapEl.appendChild(this.gutterEl);
    this.container.appendChild(this.wrapEl);
    this._updateStageClasses();

    this.book = ePub(this.data.slice(0));
    await this.book.ready;

    const nav = await this.book.loaded.navigation;
    if (this.onTocReady) {
      const flatToc = [];
      const walk = (items, depth = 0) => {
        for (const item of items || []) {
          flatToc.push({ label: `${"  ".repeat(depth)}${item.label.trim()}`, target: item.href });
          if (item.subitems?.length) walk(item.subitems, depth + 1);
        }
      };
      walk(nav?.toc || []);
      this.onTocReady(flatToc);
    }

    await this._initRendition(this.currentCfi);
    this._attachResizeObserver();

    this.book.locations
      .generate(1024)
      .then(() => {
        this.locationsReady = true;
      })
      .catch(() => {
        this.locationsReady = false;
      });
  }

  _attachResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (!this.mountEl || typeof ResizeObserver === "undefined") return;

    const rect = this.mountEl.getBoundingClientRect();
    this._lastSize = { w: Math.round(rect.width), h: Math.round(rect.height) };

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w < 120 || h < 120) return;
      if (Math.abs(w - this._lastSize.w) < 4 && Math.abs(h - this._lastSize.h) < 4) return;

      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._lastSize = { w, h };
        try {
          this.rendition?.resize(w, h, this.currentCfi || undefined);
        } catch {
          // Ignore transient resize errors during teardown
        }
      }, 110);
    });
    this.resizeObserver.observe(this.mountEl);
  }

  _updateStageClasses() {
    if (!this.wrapEl) return;
    const isScroll = this.settings.flowMode === "scroll";
    this.wrapEl.className = "epub-stage-wrap" + (!this.settings.spread ? " single" : "") + (isScroll ? " scroll-mode" : "");
    if (this.gutterEl) {
      this.gutterEl.classList.toggle("hidden", !this.settings.spread || isScroll);
    }
  }

  async _initRendition(startCfi) {
    if (this.rendition) {
      this.rendition.destroy();
      this.mountEl.innerHTML = "";
    }

    const isScroll = this.settings.flowMode === "scroll";
    this.rendition = this.book.renderTo(this.mountEl, {
      width: "100%",
      height: "100%",
      spread: this.settings.spread && !isScroll ? "always" : "none",
      minSpreadWidth: 640,
      gap: 72,
      flow: isScroll ? "scrolled-doc" : "paginated",
      allowScriptedContent: false
    });

    this.rendition.hooks.content.register((contents) => {
      this._applyThemeToDoc(contents.document);

      const emitFromIframePoint = (word, clientX, clientY) => {
        if (!word) return;
        const frameEl = contents.document.defaultView?.frameElement;
        const rect = frameEl ? frameEl.getBoundingClientRect() : { left: 0, top: 0 };
        this.onWordLookup?.(word, rect.left + clientX, rect.top + clientY);
      };

      contents.document.addEventListener("dblclick", (e) => {
        const word = extractSelectedWord(contents.window) || extractWordAtPoint(contents.document, contents.window, e.clientX, e.clientY);
        emitFromIframePoint(word, e.clientX, e.clientY);
      });

      contents.document.addEventListener("mouseup", (e) => {
        if (e.button !== 0 || e.detail >= 2) return;
        const word = extractSelectedWord(contents.window);
        if (word) emitFromIframePoint(word, e.clientX, e.clientY);
      });

      contents.document.addEventListener("click", (e) => {
        if (!e.altKey) return;
        e.preventDefault();
        const word = extractWordAtPoint(contents.document, contents.window, e.clientX, e.clientY);
        emitFromIframePoint(word, e.clientX, e.clientY);
      });

      contents.document.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") this.next();
        if (e.key === "ArrowLeft") this.prev();
        if (e.key === "Escape" || e.key.toLowerCase() === "f") {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: e.key }));
        }
      });
    });

    this.rendition.on("relocated", (location) => {
      const cfi = location?.start?.cfi || null;
      this.currentCfi = cfi;
      let percent = 0;
      if (this.locationsReady && cfi) {
        percent = Math.round((this.book.locations.percentageFromCfi(cfi) || 0) * 100);
      } else if (location?.start?.percentage != null) {
        percent = Math.round(location.start.percentage * 100);
      }
      const pageLabel = location?.start?.displayed?.page && location?.start?.displayed?.total
        ? `Section page ${location.start.displayed.page}/${location.start.displayed.total} · ${percent}%`
        : `${percent}% read`;
      this.onRelocated?.({ location: cfi, progress: percent, label: pageLabel });
    });

    await this.rendition.display(startCfi || undefined);
    this.refreshThemeAndTypography();
  }

  _applyThemeToDoc(doc) {
    if (!doc || !doc.head) return;
    const cs = getComputedStyle(document.documentElement);
    const bgPage = cs.getPropertyValue("--bg-page").trim() || "#fffdf8";
    const textMain = cs.getPropertyValue("--text-main").trim() || "#1f1b16";
    const textMuted = cs.getPropertyValue("--text-muted").trim() || "#6e6559";
    const accent = cs.getPropertyValue("--accent").trim() || "#8b2635";
    const border = cs.getPropertyValue("--border").trim() || "#d7cfc2";
    const font = this.settings.fontFamily || '"Newsreader", Georgia, serif';
    const size = `${this.settings.fontSize || 17}px`;
    const lh = String(this.settings.lineHeight || 1.72);
    const isDark = ["ink", "night"].includes(document.documentElement.dataset.theme);
    const isScroll = this.settings.flowMode === "scroll";
    const codeBg = isDark ? "rgba(255, 255, 255, 0.055)" : "rgba(31, 27, 22, 0.045)";
    const markBg = isDark ? "rgba(224, 122, 134, 0.25)" : "rgba(139, 38, 53, 0.14)";

    if ((font.includes("Newsreader") || font.includes("Inter")) && !doc.getElementById("folio-google-fonts")) {
      const fontLink = doc.createElement("link");
      fontLink.id = "folio-google-fonts";
      fontLink.rel = "stylesheet";
      fontLink.href =
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..700&display=swap";
      doc.head.appendChild(fontLink);
    }

    let styleEl = doc.getElementById("folio-epub-guard");
    if (!styleEl) {
      styleEl = doc.createElement("style");
      styleEl.id = "folio-epub-guard";
      doc.head.appendChild(styleEl);
    }

    const scrollMeasureCss = isScroll
      ? `
      html {
        overflow-x: hidden !important;
      }
      body {
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: 66ch !important;
        margin: 0 auto !important;
        padding: 28px 36px 52px !important;
        overflow-x: hidden !important;
      }
      `
      : "";

    const guardCss = this.settings.guard
      ? `
      body {
        background: ${bgPage} !important;
        color: ${textMain} !important;
      }
      body *:not(pre):not(code):not(kbd):not(samp):not(mark):not(th):not(img):not(svg):not(video):not(canvas) {
        color: ${textMain} !important;
        background-color: transparent !important;
        border-color: ${border} !important;
      }
      pre, code, kbd, samp, th {
        background-color: ${codeBg} !important;
        color: ${textMain} !important;
        border-color: ${border} !important;
      }
      pre code {
        background-color: transparent !important;
      }
      mark {
        background-color: ${markBg} !important;
        color: ${textMain} !important;
      }
      a, a * {
        color: ${accent} !important;
      }
      blockquote, blockquote *, figcaption {
        color: ${textMuted} !important;
      }
      `
      : "";

    const imgDimCss = isDark
      ? `img, svg { filter: brightness(0.88) contrast(1.04); }`
      : "";

    styleEl.textContent = `
      html, body {
        background: ${bgPage};
        color: ${textMain};
        font-family: ${font};
        font-size: ${size};
        line-height: ${lh};
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        overflow-wrap: break-word;
      }
      *::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      *::-webkit-scrollbar-button {
        display: none;
        width: 0;
        height: 0;
      }
      *::-webkit-scrollbar-track,
      *::-webkit-scrollbar-corner {
        background: transparent;
      }
      *::-webkit-scrollbar-thumb {
        background-color: color-mix(in srgb, ${textMuted} 26%, transparent);
        border-radius: 999px;
        border: 1px solid transparent;
        background-clip: padding-box;
      }
      *::-webkit-scrollbar-thumb:hover {
        background-color: color-mix(in srgb, ${textMuted} 48%, transparent);
      }
      @supports not selector(::-webkit-scrollbar) {
        * {
          scrollbar-color: color-mix(in srgb, ${textMuted} 32%, transparent) transparent;
          scrollbar-width: thin;
        }
      }
      h1, h2, h3, h4, h5, h6 {
        font-family: ${font};
        color: ${textMain};
        font-weight: 700;
        line-height: 1.24;
        letter-spacing: -0.015em;
        break-after: avoid;
        page-break-after: avoid;
        -webkit-column-break-after: avoid;
      }
      h1 { font-size: 1.72em; margin: 1.15em 0 0.65em; }
      h2 { font-size: 1.38em; margin: 1.1em 0 0.55em; }
      h3 { font-size: 1.15em; margin: 0.95em 0 0.45em; }
      h4, h5, h6 { font-size: 1.02em; margin: 0.85em 0 0.35em; }
      p {
        font-family: ${font};
        font-size: 1em;
        line-height: ${lh};
        margin: 0 0 0.72em;
        orphans: 2;
        widows: 2;
        hyphens: auto;
        -webkit-hyphens: auto;
      }
      ul, ol {
        margin: 0.6em 0 0.85em;
        padding-left: 1.55em;
      }
      li {
        font-family: ${font};
        line-height: ${lh};
        margin-bottom: 0.32em;
      }
      dd {
        margin: 0.2em 0 0.65em 1.4em;
      }
      a {
        color: ${accent};
        text-underline-offset: 2px;
      }
      blockquote {
        margin: 1em 0;
        padding: 0.2em 0 0.2em 1.1em;
        border-left: 1px solid ${border};
        font-style: italic;
        color: ${textMuted};
        line-height: ${lh};
        break-inside: avoid;
        page-break-inside: avoid;
      }
      figure {
        margin: 1.1em auto;
        text-align: center;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      figcaption {
        font-size: 0.86em;
        line-height: 1.45;
        color: ${textMuted};
        margin-top: 0.45em;
      }
      img, svg, video {
        max-width: 100% !important;
        max-height: 78vh !important;
        width: auto !important;
        height: auto !important;
        object-fit: contain;
      }
      figure img, div > img:only-child, p > img:only-child {
        display: block;
        margin: 0.85em auto;
        border-radius: 3px;
      }
      pre, code, kbd, samp {
        font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace !important;
      }
      code, kbd {
        font-size: 0.86em;
        padding: 0.12em 0.36em;
        border-radius: 4px;
        background: ${codeBg};
      }
      pre {
        font-size: 0.84em;
        line-height: 1.52;
        padding: 0.85em 1em;
        margin: 0.9em 0;
        border: 1px solid ${border};
        border-radius: 6px;
        background: ${codeBg};
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      pre code {
        padding: 0;
        background: transparent;
        border: none;
        font-size: inherit;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 1em 0;
        font-size: 0.9em;
        line-height: 1.45;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      th, td {
        border: 1px solid ${border};
        padding: 0.45em 0.65em;
        text-align: left;
        vertical-align: top;
      }
      th {
        font-weight: 600;
        background: ${codeBg};
      }
      hr {
        border: none;
        border-top: 1px solid ${border};
        margin: 1.4em auto;
        width: 42%;
      }
      ::selection {
        background: rgba(139, 38, 53, 0.22);
      }
      ${scrollMeasureCss}
      ${guardCss}
      ${imgDimCss}
    `;
  }

  refreshThemeAndTypography() {
    if (!this.rendition) return;
    for (const contents of this.rendition.getContents() || []) {
      this._applyThemeToDoc(contents.document);
    }
  }

  async updateSettings(nextSettings) {
    const prevFlow = this.settings.flowMode;
    const prevSpread = this.settings.spread;
    this.settings = { ...this.settings, ...nextSettings };
    this._updateStageClasses();

    if (prevFlow !== this.settings.flowMode) {
      await this._initRendition(this.currentCfi);
      this._attachResizeObserver();
      return;
    }
    if (prevSpread !== this.settings.spread && this.rendition) {
      this.rendition.spread(this.settings.spread && this.settings.flowMode !== "scroll" ? "always" : "none");
    }
    this.refreshThemeAndTypography();
  }

  prev() {
    return this.rendition?.prev();
  }

  next() {
    return this.rendition?.next();
  }

  goTo(target) {
    return this.rendition?.display(target);
  }

  getBookmarkPayload() {
    return {
      id: "bm-" + Date.now(),
      location: this.currentCfi,
      label: this.currentCfi ? "EPUB Bookmark" : "Start of Book",
      createdAt: Date.now()
    };
  }

  destroy() {
    clearTimeout(this._resizeTimer);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    try {
      this.rendition?.destroy();
    } catch {
      // Ignore cleanup errors
    }
    try {
      this.book?.destroy();
    } catch {
      // Ignore cleanup errors
    }
    this.rendition = null;
    this.book = null;
    this.container.innerHTML = "";
  }
}
