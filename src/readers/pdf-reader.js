import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import { bindWordLookupEvents } from "../services/dictionary.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function extractPdfMetadata(arrayBuffer, fallbackTitle) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
  const pdf = await loadingTask.promise;
  try {
    const meta = await pdf.getMetadata().catch(() => ({}));
    const info = meta?.info || {};
    let coverDataUrl = null;
    try {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 0.48 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      coverDataUrl = canvas.toDataURL("image/jpeg", 0.82);
    } catch {
      coverDataUrl = null;
    }

    return {
      title: (info.Title || "").trim() || fallbackTitle,
      author: (info.Author || "").trim() || "PDF Document",
      coverDataUrl,
      numPages: pdf.numPages
    };
  } finally {
    await pdf.destroy();
  }
}

export class PdfController {
  constructor({ container, data, lastLocation, settings, onRelocated, onTocReady, onWordLookup, onZoomChanged }) {
    this.container = container;
    this.data = data;
    this.currentPage = Math.max(1, Number(lastLocation) || 1);
    this.settings = { ...settings };
    this.onRelocated = onRelocated;
    this.onTocReady = onTocReady;
    this.onWordLookup = onWordLookup;
    this.onZoomChanged = onZoomChanged;
    this.pdf = null;
    this.numPages = 1;
    this.zoom = Number(settings.pdfZoom) || 1.15;
    this.observer = null;
    this.scrollTrackObserver = null;
    this.resizeObserver = null;
    this._resizeTimer = null;
    this._renderToken = 0;
    this._lastContainerSize = { w: 0, h: 0 };
    this.stackEl = null;
  }

  async mount() {
    this.container.innerHTML = "";
    this.pdf = await pdfjsLib.getDocument({ data: this.data.slice(0) }).promise;
    this.numPages = this.pdf.numPages;
    if (this.currentPage > this.numPages) this.currentPage = 1;

    this._attachResizeObserver();
    await this._emitToc();
    await this.render();
  }

  getEffectiveZoom() {
    return this.zoom;
  }

  _attachResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (!this.container || typeof ResizeObserver === "undefined") return;
    const rect = this.container.getBoundingClientRect();
    this._lastContainerSize = { w: Math.round(rect.width), h: Math.round(rect.height) };

    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.settings.pdfFit === false) return;
      const entry = entries[0];
      if (!entry) return;
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w < 200) return;
      if (Math.abs(w - this._lastContainerSize.w) < 8 && Math.abs(h - this._lastContainerSize.h) < 8) return;
      this._lastContainerSize = { w, h };

      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this.settings.pdfFit !== false && this.pdf) {
          this.render();
        }
      }, 140);
    });
    this.resizeObserver.observe(this.container);
  }

  async _computeFitZoom() {
    if (!this.pdf || !this.container) return this.zoom;
    const page = await this.pdf.getPage(this.currentPage);
    const vp = page.getViewport({ scale: 1 });
    const rect = this.container.getBoundingClientRect();
    const rawW = rect.width > 200 ? rect.width : window.innerWidth * 0.58;
    const availW = Math.max(260, rawW - 56);
    const isSpread = this.settings.spread && this.settings.flowMode !== "scroll" && this.numPages > 1;
    const spreadGap = isSpread ? 20 : 0;
    const targetPageW = isSpread ? (availW - spreadGap) / 2 : Math.min(availW, 880);
    const scale = targetPageW / vp.width;
    return Math.max(0.55, Math.min(1.5, Number(scale.toFixed(2))));
  }

  async _emitToc() {
    if (!this.onTocReady) return;
    const entries = [];
    try {
      const outline = await this.pdf.getOutline();
      const resolveOutline = async (items, depth = 0) => {
        for (const item of items || []) {
          let pageNum = null;
          try {
            let dest = item.dest;
            if (typeof dest === "string") dest = await this.pdf.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) {
              const idx = await this.pdf.getPageIndex(dest[0]);
              pageNum = idx + 1;
            }
          } catch {
            pageNum = null;
          }
          if (pageNum) {
            entries.push({ label: `${"  ".repeat(depth)}${item.title}`, target: pageNum });
          }
          if (item.items?.length) await resolveOutline(item.items, depth + 1);
        }
      };
      await resolveOutline(outline);
    } catch {
      // Fallback to page list
    }

    if (entries.length === 0) {
      for (let p = 1; p <= this.numPages; p++) {
        entries.push({ label: `Page ${p}`, target: p });
      }
    }
    this.tocItems = entries;
    this.onTocReady(entries);
  }

  async render() {
    if (!this.pdf) return;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scrollTrackObserver) {
      this.scrollTrackObserver.disconnect();
      this.scrollTrackObserver = null;
    }

    const token = ++this._renderToken;
    if (this.settings.pdfFit !== false) {
      const fitZoom = await this._computeFitZoom();
      if (token !== this._renderToken || !this.pdf) return;
      this.zoom = fitZoom;
      this.onZoomChanged?.(this.zoom);
    } else {
      this.zoom = Number(this.settings.pdfZoom) || this.zoom;
    }

    this.container.innerHTML = "";
    this.stackEl = document.createElement("div");
    this.stackEl.className = "pdf-stack" + (this.settings.flowMode === "scroll" ? " scroll-mode" : "");
    this.container.appendChild(this.stackEl);

    if (this.settings.flowMode === "scroll") {
      await this._renderScrollMode(token);
    } else {
      await this._renderPaginatedMode(token);
    }
    if (token === this._renderToken) {
      this._emitLocation();
    }
  }

  async _renderPaginatedMode(token) {
    const pagesToShow = [this.currentPage];
    if (this.settings.spread && this.currentPage + 1 <= this.numPages) {
      pagesToShow.push(this.currentPage + 1);
    }

    for (const pNum of pagesToShow) {
      if (token !== this._renderToken) return;
      const card = this._createPageCard(pNum);
      this.stackEl.appendChild(card);
      await this._renderPageIntoCard(pNum, card, token);
    }
  }

  async _renderScrollMode(token) {
    const firstPage = await this.pdf.getPage(1);
    if (token !== this._renderToken) return;
    const baseVp = firstPage.getViewport({ scale: this.zoom });

    const rendered = new Set();
    const cards = [];
    for (let p = 1; p <= this.numPages; p++) {
      const card = this._createPageCard(p);
      card.style.width = `${Math.floor(baseVp.width)}px`;
      card.style.height = `${Math.floor(baseVp.height)}px`;
      this.stackEl.appendChild(card);
      cards.push(card);
    }

    if (this.currentPage > 1) {
      const activeCard = this.stackEl.querySelector(`.pdf-page-card[data-page="${this.currentPage}"]`);
      activeCard?.scrollIntoView({ behavior: "auto", block: "start" });
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        if (token !== this._renderToken) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const pNum = Number(entry.target.dataset.page);
          if (rendered.has(pNum)) continue;
          rendered.add(pNum);
          this._renderPageIntoCard(pNum, entry.target, token);
        }
      },
      { root: this.container, rootMargin: "320px 0px" }
    );

    const ratioMap = new Map();
    this.scrollTrackObserver = new IntersectionObserver(
      (entries) => {
        if (token !== this._renderToken) return;
        for (const entry of entries) {
          ratioMap.set(Number(entry.target.dataset.page), entry.intersectionRatio);
        }
        let bestPage = this.currentPage;
        let bestRatio = 0;
        for (const [pNum, ratio] of ratioMap.entries()) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = pNum;
          }
        }
        if (bestRatio > 0.15 && bestPage !== this.currentPage) {
          this.currentPage = bestPage;
          this._emitLocation();
        }
      },
      { root: this.container, threshold: [0, 0.25, 0.5, 0.75] }
    );

    for (const card of cards) {
      this.observer.observe(card);
      this.scrollTrackObserver.observe(card);
    }
  }

  _createPageCard(pageNum) {
    const card = document.createElement("div");
    card.dataset.page = String(pageNum);
    card.className = "pdf-page-card" + (this.settings.pdfMode ? ` ${this.settings.pdfMode}` : "");
    bindWordLookupEvents(card, window, (word, x, y) => this.onWordLookup?.(word, x, y));
    return card;
  }

  async _renderPageIntoCard(pageNum, card, token = this._renderToken) {
    if (!this.pdf || token !== this._renderToken) return;
    const page = await this.pdf.getPage(pageNum);
    if (!this.pdf || token !== this._renderToken) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: this.zoom });
    const renderViewport = page.getViewport({ scale: this.zoom * dpr });

    card.innerHTML = "";
    card.style.width = `${Math.floor(viewport.width)}px`;
    card.style.height = `${Math.floor(viewport.height)}px`;

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext("2d");
    card.appendChild(canvas);
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    if (!this.pdf || token !== this._renderToken) return;

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer pdf-text-layer";
    textLayerDiv.style.setProperty("--scale-factor", String(viewport.scale));
    card.appendChild(textLayerDiv);

    const textContent = await page.getTextContent();
    if (!this.pdf || token !== this._renderToken) return;
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs: []
    }).promise;

    const numBadge = document.createElement("div");
    numBadge.className = "pdf-page-num";
    numBadge.textContent = `${pageNum} / ${this.numPages}`;
    card.appendChild(numBadge);
  }

  _emitLocation() {
    const progress = Math.round((this.currentPage / this.numPages) * 100);
    const label = this.settings.spread && this.settings.flowMode !== "scroll" && this.currentPage + 1 <= this.numPages
      ? `Pages ${this.currentPage}–${this.currentPage + 1} of ${this.numPages} · ${progress}%`
      : `Page ${this.currentPage} of ${this.numPages} · ${progress}%`;
    let tocTarget = null;
    for (const item of this.tocItems || []) {
      if (Number(item.target) <= this.currentPage) tocTarget = item.target;
    }
    this.onRelocated?.({ location: this.currentPage, progress, label, tocTarget });
  }

  updateAppearance(pdfMode) {
    this.settings.pdfMode = pdfMode;
    this.container.querySelectorAll(".pdf-page-card").forEach((card) => {
      card.classList.remove("warm", "invert");
      if (pdfMode) card.classList.add(pdfMode);
    });
  }

  async updateSettings(nextSettings) {
    const needsRerender =
      nextSettings.flowMode !== this.settings.flowMode ||
      nextSettings.spread !== this.settings.spread ||
      nextSettings.pdfZoom !== this.settings.pdfZoom ||
      nextSettings.pdfFit !== this.settings.pdfFit;
    this.settings = { ...this.settings, ...nextSettings };
    if (this.settings.pdfFit === false && typeof nextSettings.pdfZoom === "number") {
      this.zoom = nextSettings.pdfZoom;
    }
    if (needsRerender) {
      await this.render();
    } else {
      this.updateAppearance(this.settings.pdfMode);
    }
  }

  async prev() {
    if (this.settings.flowMode === "scroll") {
      const target = Math.max(1, this.currentPage - 1);
      return this.goTo(target);
    }
    if (this.container && this.container.scrollTop > 12) {
      this.container.scrollBy({ top: -Math.round(this.container.clientHeight * 0.82), behavior: "smooth" });
      return;
    }
    const step = this.settings.spread ? 2 : 1;
    if (this.currentPage > 1) {
      this.currentPage = Math.max(1, this.currentPage - step);
      await this.render();
      if (this.container) this.container.scrollTop = 0;
    }
  }

  async next() {
    if (this.settings.flowMode === "scroll") {
      const target = Math.min(this.numPages, this.currentPage + 1);
      return this.goTo(target);
    }
    if (this.container && this.container.scrollTop + this.container.clientHeight < this.container.scrollHeight - 12) {
      this.container.scrollBy({ top: Math.round(this.container.clientHeight * 0.82), behavior: "smooth" });
      return;
    }
    const step = this.settings.spread ? 2 : 1;
    if (this.currentPage + step <= this.numPages) {
      this.currentPage += step;
      await this.render();
      if (this.container) this.container.scrollTop = 0;
    } else if (this.currentPage < this.numPages) {
      this.currentPage = this.numPages;
      await this.render();
      if (this.container) this.container.scrollTop = 0;
    }
  }

  async goTo(pageTarget) {
    const pageNum = Math.min(this.numPages, Math.max(1, Number(pageTarget) || 1));
    this.currentPage = pageNum;
    if (this.settings.flowMode === "scroll") {
      const card = this.container.querySelector(`.pdf-page-card[data-page="${pageNum}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "start" });
      this._emitLocation();
    } else {
      await this.render();
    }
  }

  getBookmarkPayload() {
    return {
      id: "bm-" + Date.now(),
      location: this.currentPage,
      label: `Page ${this.currentPage}`,
      createdAt: Date.now()
    };
  }

  destroy() {
    this._renderToken++;
    clearTimeout(this._resizeTimer);
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scrollTrackObserver) {
      this.scrollTrackObserver.disconnect();
      this.scrollTrackObserver = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.pdf) {
      this.pdf.destroy();
      this.pdf = null;
    }
    this.container.innerHTML = "";
  }
}
