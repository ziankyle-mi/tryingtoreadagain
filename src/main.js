import {
  seedStarterBooksIfEmpty,
  getAllBooks,
  getBook,
  saveBook,
  updateBookMeta,
  deleteBook,
  getVocab,
  saveVocabWord,
  removeVocabWord
} from "./storage.js";
import { lookupDefinition } from "./dictionary.js";
import { extractEpubMetadata, EpubController } from "./epub-reader.js";
import { extractPdfMetadata, PdfController } from "./pdf-reader.js";

const PREFS_KEY = "editorial_folio_prefs_v1";

const DEFAULT_PREFS = {
  theme: "ivory",
  spread: true,
  flowMode: "paginated",
  margin: true,
  dictVisible: true,
  guard: true,
  pdfMode: "",
  fontFamily: '"Newsreader", Georgia, serif',
  fontSize: 17,
  lineHeight: 1.72,
  pdfZoom: 1.15,
  pdfFit: true,
  fontMigratedNewsreader: true
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_PREFS, ...parsed };
    if (!parsed.fontMigratedNewsreader) {
      merged.fontFamily = DEFAULT_PREFS.fontFamily;
      merged.fontMigratedNewsreader = true;
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

const state = {
  view: "catalog",
  prefs: loadPrefs(),
  books: [],
  vocab: [],
  activeBook: null,
  controller: null,
  tocOpen: false,
  query: "",
  formatFilter: "all",
  lastLookup: null
};

const $ = (id) => document.getElementById(id);

function escHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function showToast(msg) {
  const el = $("statusToast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const THEME_MODES = {
  ivory: { label: "Ivory", mode: "light" },
  antique: { label: "Antique", mode: "light" },
  sage: { label: "Sage", mode: "light" },
  ink: { label: "Ink", mode: "dark" },
  night: { label: "Night", mode: "dark" }
};

let lastDayTheme = "ivory";
let lastNightTheme = "ink";

const SUN_ICON = `<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="6.34" y1="17.66" x2="4.93" y2="19.07"/><line x1="19.07" y1="4.93" x2="17.66" y2="6.34"/>`;
const MOON_ICON = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;

function applyTheme(theme) {
  const validTheme = THEME_MODES[theme] ? theme : "ivory";
  const isDark = THEME_MODES[validTheme].mode === "dark";
  if (isDark) lastNightTheme = validTheme;
  else lastDayTheme = validTheme;

  state.prefs.theme = validTheme;
  document.documentElement.setAttribute("data-theme", validTheme);

  const labelEl = $("dayNightLabel");
  const iconEl = $("dayNightIcon");
  const toggleBtn = $("dayNightToggle");
  if (labelEl) labelEl.textContent = isDark ? "Night" : "Day";
  if (iconEl) iconEl.innerHTML = isDark ? MOON_ICON : SUN_ICON;
  if (toggleBtn) toggleBtn.setAttribute("aria-pressed", String(isDark));

  const stockRail = $("stockRail");
  if (stockRail) {
    const stocks = isDark ? ["ink", "night"] : ["ivory", "antique", "sage"];
    stockRail.innerHTML = "";
    stocks.forEach((key) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const active = validTheme === key;
      btn.className = "stock-btn" + (active ? " active" : "");
      btn.textContent = THEME_MODES[key].label;
      btn.setAttribute("aria-pressed", String(active));
      btn.onclick = () => applyTheme(key);
      stockRail.appendChild(btn);
    });
  }

  savePrefs(state.prefs);
  state.controller?.refreshThemeAndTypography?.();
}

function syncControlsFromPrefs() {
  applyTheme(state.prefs.theme);

  $("fontFamilySelect").value = state.prefs.fontFamily;
  $("proseSize").value = String(state.prefs.fontSize);
  $("proseSizeVal").textContent = `${state.prefs.fontSize}px`;
  $("lineHeightRange").value = String(state.prefs.lineHeight);
  $("lineHeightVal").textContent = String(state.prefs.lineHeight);
  $("epubGuard").checked = state.prefs.guard;
  $("pdfAppearance").value = state.prefs.pdfMode;
  const displayZoom = state.controller?.getEffectiveZoom?.() ?? state.prefs.pdfZoom;
  $("zoomVal").textContent = `${Math.round(displayZoom * 100)}%`;
  $("zoomFitBtn").classList.toggle("active", state.prefs.pdfFit !== false);
  $("zoomFitBtn").setAttribute("aria-pressed", String(state.prefs.pdfFit !== false));

  $("btnSpread").classList.toggle("active", state.prefs.spread);
  $("btnSpread").setAttribute("aria-pressed", String(state.prefs.spread));
  $("btnSpread").textContent = state.prefs.spread ? "2-Page Spread" : "Single Page";

  const isPaginated = state.prefs.flowMode === "paginated";
  $("btnFlow").classList.toggle("active", isPaginated);
  $("btnFlow").setAttribute("aria-pressed", String(isPaginated));
  $("btnFlow").textContent = isPaginated ? "Paginated" : "Scroll";

  $("btnMargin").classList.toggle("active", state.prefs.margin);
  $("btnMargin").setAttribute("aria-pressed", String(state.prefs.margin));
  $("marginaliaRail").classList.toggle("hidden", !state.prefs.margin);

  $("dictPin").classList.toggle("hidden", !state.prefs.dictVisible);
  $("toggleDictSectionBtn").textContent = state.prefs.dictVisible ? "Hide" : "Show";
  $("toggleDictSectionBtn").setAttribute("aria-expanded", String(state.prefs.dictVisible));

  document.documentElement.style.setProperty("--font-prose", state.prefs.fontFamily);
  document.documentElement.style.setProperty("--size-prose", `${state.prefs.fontSize}px`);
  document.documentElement.style.setProperty("--lh-prose", String(state.prefs.lineHeight));
}

function setView(view) {
  state.view = view;
  const inFolio = view === "folio";
  $("catalogView").classList.toggle("hidden", inFolio);
  $("folioView").classList.toggle("hidden", !inFolio);

  ["backLibraryBtn", "btnSpread", "btnFlow", "btnToc", "btnMargin", "btnFocus"].forEach((id) => {
    $(id).classList.toggle("hidden", !inFolio);
  });
  $("activeBookBadge").classList.toggle("hidden", !inFolio || !state.activeBook);

  if (!inFolio) {
    setFocusMode(false);
    $("floatPop").classList.remove("open");
    renderCatalog();
  } else if (!state.activeBook && state.books.length > 0) {
    openBook(state.books[0].id);
  }
}

function setFocusMode(enabled) {
  state.focusMode = Boolean(enabled);
  document.body.classList.toggle("focus-mode", state.focusMode);
  const btn = $("btnFocus");
  if (btn) {
    btn.classList.toggle("active", state.focusMode);
    btn.setAttribute("aria-pressed", String(state.focusMode));
  }
}

function renderCatalog() {
  const grid = $("catalogGrid");
  grid.innerHTML = "";
  const q = state.query.trim().toLowerCase();
  const filtered = state.books.filter((b) => {
    const matchesFmt = state.formatFilter === "all" || b.format === state.formatFilter;
    const matchesQuery = !q || b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q);
    return matchesFmt && matchesQuery;
  });

  $("libraryCount").textContent = `${state.books.length} ${state.books.length === 1 ? "book" : "books"} in your library · Click any cover to open`;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<div style="font-size:15px;font-weight:600;color:var(--text-main);margin-bottom:6px;">No books found</div>
      <div style="font-size:13px;margin-bottom:14px;">${q || state.formatFilter !== "all" ? "Try another filter or import an .epub / .pdf file." : "Import your first .epub or .pdf book to start reading."}</div>`;
    if (q || state.formatFilter !== "all") {
      const clr = document.createElement("button");
      clr.className = "btn";
      clr.textContent = "Reset filters";
      clr.onclick = () => {
        state.query = "";
        state.formatFilter = "all";
        $("searchInput").value = "";
        document.querySelectorAll(".fmt-filter").forEach((b) => {
          const isAll = b.dataset.fmt === "all";
          b.classList.toggle("active", isAll);
          b.setAttribute("aria-pressed", String(isAll));
        });
        renderCatalog();
      };
      empty.appendChild(clr);
    }
    grid.appendChild(empty);
    return;
  }

  const checkSvg = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2.5 6.5 5 9 9.5 3.5"/></svg>`;
  const moreSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
  const trashSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  const markSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

  const closeAllCoverMenus = () => {
    grid.querySelectorAll(".cover-menu").forEach((m) => m.classList.add("hidden"));
    grid.querySelectorAll(".cover-more-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };

  filtered.forEach((b) => {
    const card = document.createElement("div");
    card.className = "cover-item";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open ${b.title} by ${b.author || "Unknown"} (${b.format})`);

    const coverContent = b.coverDataUrl
      ? `<img src="${b.coverDataUrl}" alt="" class="cover-img" />`
      : `<div style="margin-top:24px;font-family:'Newsreader',Georgia,serif;font-size:15px;font-weight:700;line-height:1.25;color:${b.coverTitleColor || "#ffffff"};">${escHtml(b.title.split(":")[0])}</div>
         <div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.8;margin-bottom:8px;">${escHtml(b.author || "")}</div>`;

    const fallbackBg = b.coverStyle || (b.format === "PDF"
      ? "background: linear-gradient(155deg, #8b2635 0%, #2a1216 100%); color: #fff;"
      : "background: linear-gradient(155deg, #1d6b4b 0%, #102a1f 100%); color: #fff;");

    card.innerHTML = `
      <div class="cover-frame${b.coverDataUrl ? " has-cover" : ""}" style="${b.coverDataUrl ? "" : fallbackBg}">
        <button type="button" class="cover-more-btn" data-act="menu" aria-label="Book options" aria-expanded="false">${moreSvg}</button>
        <div class="cover-menu hidden" role="menu">
          <button type="button" class="cover-menu-item" role="menuitem" data-act="toggle-read">${markSvg}<span>${b.finished ? "Mark as unread" : "Mark as finished"}</span></button>
          <button type="button" class="cover-menu-item danger" role="menuitem" data-act="delete">${trashSvg}<span>Remove from library</span></button>
        </div>
        <span class="cover-fmt">${escHtml(b.format)}</span>
        ${coverContent}
        ${b.finished ? `<span class="cover-badge-read" title="Completed">${checkSvg}</span>` : ""}
        ${b.progress > 0 && !b.finished ? `<div class="cover-prog-track"><div class="cover-prog-fill" style="width:${b.progress}%"></div></div>` : ""}
      </div>
      <div class="cover-title">${escHtml(b.title)}</div>
      <div class="cover-author">${escHtml(b.author || "Unknown Author")}</div>
    `;

    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "menu") {
          const menu = card.querySelector(".cover-menu");
          const wasHidden = menu.classList.contains("hidden");
          closeAllCoverMenus();
          if (wasHidden) {
            menu.classList.remove("hidden");
            btn.setAttribute("aria-expanded", "true");
          }
          return;
        }
        if (act === "toggle-read") {
          const nextFinished = !b.finished;
          await updateBookMeta(b.id, { finished: nextFinished, progress: nextFinished ? 100 : b.progress });
          state.books = await getAllBooks();
          renderCatalog();
        } else if (act === "delete") {
          if (state.activeBook?.id === b.id) {
            state.controller?.destroy();
            state.controller = null;
            state.activeBook = null;
          }
          await deleteBook(b.id);
          state.books = await getAllBooks();
          renderCatalog();
          showToast(`Removed "${b.title}"`);
        }
        return;
      }
      openBook(b.id);
    });

    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openBook(b.id);
      }
    });

    grid.appendChild(card);
  });

  if (!q && state.formatFilter === "all") {
    const slot = document.createElement("button");
    slot.type = "button";
    slot.className = "add-book-slot";
    slot.innerHTML = `
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      <span>Drop or import<br/>EPUB / PDF</span>
    `;
    slot.onclick = () => $("upFile").click();
    grid.appendChild(slot);
  }
}

async function openBook(bookId) {
  const book = await getBook(bookId);
  if (!book) {
    showToast("Book could not be loaded.");
    return;
  }

  state.controller?.destroy();
  state.controller = null;
  state.activeBook = book;

  await updateBookMeta(book.id, { lastOpenedAt: Date.now() });
  state.books = await getAllBooks();

  $("activeBookFmt").textContent = book.format;
  $("activeBookTitle").textContent = book.title;
  $("activeBookBadge").title = book.author ? `${book.title} — ${book.author}` : book.title;
  $("pdfZoomGroup").classList.toggle("hidden", book.format !== "PDF");
  $("locStatus").textContent = `Loading ${book.title}...`;
  $("footerProgressFill").style.width = `${book.progress || 0}%`;

  setView("folio");
  renderBookmarks();
  renderVocab();

  const stage = $("spreadStage");
  const commonOpts = {
    container: stage,
    data: book.data,
    lastLocation: book.lastLocation,
    settings: state.prefs,
    onRelocated: async ({ location, progress, label }) => {
      $("locStatus").textContent = label;
      $("footerProgressFill").style.width = `${progress}%`;
      if (state.activeBook) {
        state.activeBook.lastLocation = location;
        state.activeBook.progress = progress;
        await updateBookMeta(state.activeBook.id, { lastLocation: location, progress });
      }
    },
    onTocReady: (items) => renderToc(items),
    onWordLookup: (word, clientX, clientY) => handleWordLookup(word, clientX, clientY),
    onZoomChanged: (zoom) => {
      $("zoomVal").textContent = `${Math.round(zoom * 100)}%`;
    }
  };

  try {
    state.controller = book.format === "EPUB" ? new EpubController(commonOpts) : new PdfController(commonOpts);
    await state.controller.mount();
  } catch (err) {
    stage.innerHTML = `<div class="empty-state"><strong>Failed to open ${escHtml(book.title)}</strong><div style="margin-top:6px;">${escHtml(err?.message || "Invalid or corrupted file")}</div></div>`;
  }
}

function renderToc(items) {
  const list = $("tocList");
  list.innerHTML = "";
  if (!items || items.length === 0) {
    list.innerHTML = `<div class="muted-note">No chapters found in this document.</div>`;
    return;
  }
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = "toc-btn";
    btn.textContent = item.label;
    btn.onclick = () => {
      state.controller?.goTo(item.target);
      if (window.innerWidth <= 900) {
        state.tocOpen = false;
        $("tocDrawer").classList.add("hidden");
        $("btnToc").classList.remove("active");
        $("btnToc").setAttribute("aria-pressed", "false");
      }
    };
    list.appendChild(btn);
  });
}

const REMOVE_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function renderBookmarks() {
  const el = $("bookmarkList");
  el.innerHTML = "";
  const list = state.activeBook?.bookmarks || [];
  if (list.length === 0) {
    el.innerHTML = `<div class="muted-note">No bookmarks saved for this book yet.</div>`;
    return;
  }

  list.forEach((bm) => {
    const row = document.createElement("div");
    row.className = "saved-row";
    row.innerHTML = `<button type="button" class="saved-link" title="Jump to bookmark">${escHtml(bm.label)}</button>
      <button type="button" class="icon-ghost-btn" aria-label="Delete bookmark" title="Remove">${REMOVE_ICON}</button>`;
    row.querySelector(".saved-link").onclick = () => state.controller?.goTo(bm.location);
    row.querySelector(".icon-ghost-btn").onclick = async () => {
      state.activeBook.bookmarks = state.activeBook.bookmarks.filter((x) => x.id !== bm.id);
      await updateBookMeta(state.activeBook.id, { bookmarks: state.activeBook.bookmarks });
      renderBookmarks();
    };
    el.appendChild(row);
  });
}

function renderVocab() {
  const el = $("vocabList");
  el.innerHTML = "";
  if (state.vocab.length === 0) {
    el.innerHTML = `<div class="muted-note">Click "Save" on a lookup to build your lexicon.</div>`;
    return;
  }

  state.vocab.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "saved-row";
    row.innerHTML = `<button type="button" class="saved-link"><strong>${escHtml(entry.word)}</strong> <span style="color:var(--text-muted)">${escHtml(entry.pos || "")}</span></button>
      <button type="button" class="icon-ghost-btn" aria-label="Remove saved word" title="Remove">${REMOVE_ICON}</button>`;
    row.querySelector(".saved-link").onclick = () => handleWordLookup(entry.word, 280, 140);
    row.querySelector(".icon-ghost-btn").onclick = async () => {
      await removeVocabWord(entry.word);
      state.vocab = await getVocab();
      renderVocab();
    };
    el.appendChild(row);
  });
}

function buildDictMarkup(res) {
  if (!res.found) {
    return `
      <div class="dict-head">
        <span class="dict-word">${escHtml(res.word)}</span>
      </div>
      <div class="muted-note" style="color:var(--accent);">No definition found (${escHtml(res.source)}).</div>
    `;
  }

  const meaningsHtml = res.meanings
    .map(
      (m) => `
      <div style="margin-top:8px;">
        <span class="badge">${escHtml(m.partOfSpeech)}</span>
        ${m.definitions
          .map(
            (d) => `
          <div style="margin-top:4px;">${escHtml(d.definition)}</div>
          ${d.example ? `<div class="dict-example">"${escHtml(d.example)}"</div>` : ""}
        `
          )
          .join("")}
      </div>
    `
    )
    .join("");

  const audioSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  const copySvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const saveSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;

  return `
    <div class="dict-head">
      <div>
        <span class="dict-word">${escHtml(res.word)}</span>
        <span class="dict-phon">${escHtml(res.phonetic || "")}</span>
      </div>
      ${res.audio ? `<button type="button" class="btn-ghost" data-dict-act="audio">${audioSvg}<span>Listen</span></button>` : ""}
    </div>
    <div style="max-height:220px;overflow-y:auto;">${meaningsHtml}</div>
    <div class="dict-footer">
      <span>${escHtml(res.source)}</span>
      <div style="display:flex;gap:5px;">
        <button type="button" class="btn-ghost" data-dict-act="copy">${copySvg}<span>Copy</span></button>
        <button type="button" class="btn btn-sm btn-accent" data-dict-act="save">${saveSvg}<span>Save</span></button>
      </div>
    </div>
  `;
}

function wireDictActions(container, res) {
  container.querySelectorAll("[data-dict-act]").forEach((btn) => {
    btn.onclick = async () => {
      const act = btn.dataset.dictAct;
      if (act === "audio" && res.audio) {
        new Audio(res.audio).play().catch(() => showToast("Audio playback blocked."));
      } else if (act === "copy" && navigator.clipboard) {
        await navigator.clipboard.writeText(res.word);
        showToast(`Copied "${res.word}"`);
      } else if (act === "save") {
        const firstMeaning = res.meanings?.[0];
        await saveVocabWord({
          word: res.word,
          phonetic: res.phonetic || "",
          pos: firstMeaning?.partOfSpeech || "",
          def: firstMeaning?.definitions?.[0]?.definition || "",
          savedAt: Date.now()
        });
        state.vocab = await getVocab();
        renderVocab();
        showToast(`Saved "${res.word}" to Vocabulary`);
      }
    };
  });
}

let lastLookupAt = 0;

async function handleWordLookup(word, clientX, clientY) {
  lastLookupAt = Date.now();
  const railVisible = !state.focusMode && state.prefs.margin && state.prefs.dictVisible && window.innerWidth > 900;
  const targetEl = railVisible ? $("dictPin") : $("floatPop");

  targetEl.innerHTML = `Looking up <strong>${escHtml(word)}</strong>...`;
  if (!railVisible) {
    const pop = $("floatPop");
    const left = Math.min(Math.max(12, clientX + 10), window.innerWidth - 372);
    const top = Math.min(Math.max(12, clientY + 10), window.innerHeight - 260);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.add("open");
  }

  const res = await lookupDefinition(word);
  state.lastLookup = res;
  targetEl.innerHTML = buildDictMarkup(res);
  wireDictActions(targetEl, res);
  if (railVisible) {
    $("clearDictBtn").classList.remove("hidden");
  }
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.(epub|pdf)$/i.test(f.name));
  if (files.length === 0) {
    showToast("Please select .epub or .pdf files.");
    return;
  }

  for (const file of files) {
    const ext = file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "EPUB";
    const fallbackTitle = file.name.replace(/\.(epub|pdf)$/i, "");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const meta = ext === "EPUB"
        ? await extractEpubMetadata(arrayBuffer, fallbackTitle)
        : await extractPdfMetadata(arrayBuffer, fallbackTitle);

      const now = Date.now();
      await saveBook({
        id: `book-${now}-${Math.random().toString(36).slice(2, 7)}`,
        title: meta.title,
        author: meta.author,
        format: ext,
        data: arrayBuffer,
        coverDataUrl: meta.coverDataUrl,
        progress: 0,
        finished: false,
        lastLocation: ext === "PDF" ? 1 : null,
        bookmarks: [],
        addedAt: now,
        lastOpenedAt: now
      });
      showToast(`Imported "${meta.title}" (${ext})`);
    } catch (err) {
      showToast(`Failed to import ${file.name}: ${err?.message || "parse error"}`);
    }
  }

  state.books = await getAllBooks();
  renderCatalog();
}

function wireEvents() {
  $("brandHomeBtn").onclick = () => setView("catalog");
  $("backLibraryBtn").onclick = () => setView("catalog");

  $("btnSpread").onclick = async () => {
    state.prefs.spread = !state.prefs.spread;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    await state.controller?.updateSettings?.(state.prefs);
  };

  $("btnFlow").onclick = async () => {
    state.prefs.flowMode = state.prefs.flowMode === "paginated" ? "scroll" : "paginated";
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    await state.controller?.updateSettings?.(state.prefs);
  };

  $("btnToc").onclick = () => {
    state.tocOpen = !state.tocOpen;
    $("tocDrawer").classList.toggle("hidden", !state.tocOpen);
    $("btnToc").classList.toggle("active", state.tocOpen);
    $("btnToc").setAttribute("aria-pressed", String(state.tocOpen));
  };
  $("closeTocBtn").onclick = () => {
    state.tocOpen = false;
    $("tocDrawer").classList.add("hidden");
    $("btnToc").classList.remove("active");
    $("btnToc").setAttribute("aria-pressed", "false");
  };

  $("btnMargin").onclick = () => {
    state.prefs.margin = !state.prefs.margin;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
  };

  $("btnFocus").onclick = () => setFocusMode(!state.focusMode);
  $("focusExitBtn").onclick = () => setFocusMode(false);
  $("focusPrevBtn").onclick = () => state.controller?.prev();
  $("focusNextBtn").onclick = () => state.controller?.next();

  $("hideMarginBtn").onclick = () => {
    state.prefs.margin = false;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
  };

  $("toggleDictSectionBtn").onclick = () => {
    state.prefs.dictVisible = !state.prefs.dictVisible;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
  };

  $("clearDictBtn").onclick = () => {
    $("dictPin").innerHTML = `<div class="muted-note">Double-click or select any word (or Alt + Click) to inspect its definition, phonetics, and audio without obscuring prose.</div>`;
    $("clearDictBtn").classList.add("hidden");
  };

  $("dayNightToggle").onclick = () => {
    const isDark = THEME_MODES[state.prefs.theme]?.mode === "dark";
    applyTheme(isDark ? lastDayTheme : lastNightTheme);
  };

  document.querySelectorAll(".fmt-filter").forEach((btn) => {
    btn.onclick = () => {
      state.formatFilter = btn.dataset.fmt;
      document.querySelectorAll(".fmt-filter").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      });
      renderCatalog();
    };
  });

  $("searchInput").oninput = (e) => {
    state.query = e.target.value;
    renderCatalog();
  };

  $("upBtn").onclick = () => $("upFile").click();
  $("upFile").onchange = async (e) => {
    await importFiles(e.target.files);
    e.target.value = "";
  };

  const catalogView = $("catalogView");
  const dropOverlay = $("dropOverlay");
  let dragDepth = 0;
  catalogView.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.remove("hidden");
  });
  catalogView.addEventListener("dragover", (e) => e.preventDefault());
  catalogView.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add("hidden");
  });
  catalogView.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    if (e.dataTransfer?.files?.length) {
      await importFiles(e.dataTransfer.files);
    }
  });

  $("prevBtn").onclick = () => state.controller?.prev();
  $("nextBtn").onclick = () => state.controller?.next();

  $("zoomOutBtn").onclick = async () => {
    const baseZoom = state.controller?.getEffectiveZoom?.() ?? state.prefs.pdfZoom;
    state.prefs.pdfFit = false;
    state.prefs.pdfZoom = Math.max(0.55, Number((baseZoom - 0.15).toFixed(2)));
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    await state.controller?.updateSettings?.(state.prefs);
  };
  $("zoomInBtn").onclick = async () => {
    const baseZoom = state.controller?.getEffectiveZoom?.() ?? state.prefs.pdfZoom;
    state.prefs.pdfFit = false;
    state.prefs.pdfZoom = Math.min(2.2, Number((baseZoom + 0.15).toFixed(2)));
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    await state.controller?.updateSettings?.(state.prefs);
  };
  $("zoomFitBtn").onclick = async () => {
    state.prefs.pdfFit = true;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    await state.controller?.updateSettings?.(state.prefs);
  };

  $("bookmarkBtn").onclick = async () => {
    if (!state.activeBook || !state.controller) return;
    const bm = state.controller.getBookmarkPayload();
    const list = state.activeBook.bookmarks || [];
    list.unshift(bm);
    state.activeBook.bookmarks = list;
    await updateBookMeta(state.activeBook.id, { bookmarks: list });
    renderBookmarks();
    showToast(`Saved bookmark (${bm.label})`);
  };

  $("fontFamilySelect").onchange = (e) => {
    state.prefs.fontFamily = e.target.value;
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    state.controller?.refreshThemeAndTypography?.();
  };
  $("proseSize").oninput = (e) => {
    state.prefs.fontSize = Number(e.target.value);
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    state.controller?.refreshThemeAndTypography?.();
  };
  $("lineHeightRange").oninput = (e) => {
    state.prefs.lineHeight = Number(e.target.value);
    savePrefs(state.prefs);
    syncControlsFromPrefs();
    state.controller?.refreshThemeAndTypography?.();
  };
  $("epubGuard").onchange = (e) => {
    state.prefs.guard = e.target.checked;
    savePrefs(state.prefs);
    state.controller?.updateSettings?.(state.prefs);
  };
  $("pdfAppearance").onchange = (e) => {
    state.prefs.pdfMode = e.target.value;
    savePrefs(state.prefs);
    state.controller?.updateSettings?.(state.prefs);
  };

  document.addEventListener("click", (e) => {
    if (Date.now() - lastLookupAt > 180 && !$("floatPop").contains(e.target)) {
      $("floatPop").classList.remove("open");
    }
    if (!e.target.closest(".cover-menu") && !e.target.closest(".cover-more-btn")) {
      document.querySelectorAll(".cover-menu").forEach((m) => m.classList.add("hidden"));
      document.querySelectorAll(".cover-more-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.focusMode) setFocusMode(false);
      $("floatPop").classList.remove("open");
      document.querySelectorAll(".cover-menu").forEach((m) => m.classList.add("hidden"));
      document.querySelectorAll(".cover-more-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    }
    if (state.view === "folio" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      if (e.key === "ArrowRight") state.controller?.next();
      if (e.key === "ArrowLeft") state.controller?.prev();
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFocusMode(!state.focusMode);
      }
    }
  });
}

async function init() {
  syncControlsFromPrefs();
  wireEvents();
  state.books = await seedStarterBooksIfEmpty();
  state.vocab = await getVocab();
  renderCatalog();
}

init();
