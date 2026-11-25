import {
  getAllBooks,
  getBook,
  saveBook,
  updateBookMeta,
  deleteBook,
  getVocab,
  saveVocabWord,
  removeVocabWord
} from "../services/storage.js";
import { lookupDefinition, escHtml } from "../services/dictionary.js";
import { createThemeManager } from "../ui/theme.js";
import { FluidSpring, VelocityTracker, projectMomentum, rubberband, attachDrawerSwipe } from "../ui/motion.js";

const loadEpubReader = () => import("../readers/epub-reader.js");
const loadPdfReader = () => import("../readers/pdf-reader.js");
const loadTextReader = () => import("../readers/text-reader.js");

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
  fontSize: 18,
  lineHeight: 1.76,
  readingFormat: "editorial",
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

function closeAllCoverMenus() {
  document.querySelectorAll(".cover-menu").forEach((m) => m.classList.remove("open"));
  document.querySelectorAll(".cover-more-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

async function updatePrefs(patch, notifyController = true) {
  Object.assign(state.prefs, patch);
  savePrefs(state.prefs);
  syncControlsFromPrefs();
  if (notifyController) {
    await state.controller?.updateSettings?.(state.prefs);
  }
}

let toastTimer = null;
function showToast(msg) {
  const el = $("statusToast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const themeManager = createThemeManager({ state, savePrefs, $ });

let tocDrawerSwipe = null;

function setTocOpen(open) {
  state.tocOpen = Boolean(open);
  const drawer = $("tocDrawer");
  const btn = $("btnToc");
  if (drawer) {
    drawer.classList.toggle("is-closed", !state.tocOpen);
    drawer.setAttribute("aria-hidden", String(!state.tocOpen));
    drawer.inert = !state.tocOpen;
    if (window.innerWidth <= 900 && tocDrawerSwipe) {
      tocDrawerSwipe.syncOpen(state.tocOpen);
    }
  }
  if (btn) {
    btn.classList.toggle("active", state.tocOpen);
    btn.setAttribute("aria-pressed", String(state.tocOpen));
  }
  if (state.tocOpen) {
    $("tocList")?.querySelector(".toc-btn.active")?.scrollIntoView({ block: "nearest" });
  }
}

function setMarginOpen(open) {
  const rail = $("marginaliaRail");
  const btn = $("btnMargin");
  if (rail) {
    rail.classList.toggle("is-closed", !open);
    rail.setAttribute("aria-hidden", String(!open));
    rail.inert = !open;
  }
  if (btn) {
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-pressed", String(open));
  }
}

function syncControlsFromPrefs() {
  themeManager.applyTheme(state.prefs.theme);

  $("readingFormatSelect").value = state.prefs.readingFormat || "editorial";
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

  document.querySelectorAll("[data-spread]").forEach((btn) => {
    const active = (btn.dataset.spread === "true") === state.prefs.spread;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  document.querySelectorAll("[data-flow]").forEach((btn) => {
    const active = btn.dataset.flow === state.prefs.flowMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });

  setMarginOpen(state.prefs.margin);

  $("dictPin").classList.toggle("hidden", !state.prefs.dictVisible);
  $("toggleDictSectionBtn").textContent = state.prefs.dictVisible ? "Hide" : "Show";
  $("toggleDictSectionBtn").setAttribute("aria-expanded", String(state.prefs.dictVisible));

  themeManager.applyTypographyTokens();
}

function setView(view) {
  state.view = view;
  const inFolio = view === "folio";
  $("catalogView").classList.toggle("hidden", inFolio);
  $("folioView").classList.toggle("hidden", !inFolio);

  ["backLibraryBtn", "btnToc", "btnMargin", "btnFocus", "appearanceLayoutSection"].forEach((id) => {
    $(id).classList.toggle("hidden", !inFolio);
  });
  $("activeBookBadge").classList.toggle("hidden", !inFolio || !state.activeBook);

  if (!inFolio) {
    openBookToken++;
    flushProgressSave();
    setFocusMode(false);
    closeFloatPop();
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
    empty.innerHTML = `<div style="font-size:var(--text-ui-lg);font-weight:600;color:var(--text-main);margin-bottom:6px;">No books found</div>
      <div style="font-size:var(--text-ui-sm);margin-bottom:14px;">${q || state.formatFilter !== "all" ? "Try another filter or import an .epub, .pdf, .txt, or .md file." : "Import your first .epub, .pdf, .txt, or .md file to start reading."}</div>`;
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

  const moreSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
  const trashSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  const markSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

  filtered.forEach((b) => {
    const card = document.createElement("div");
    card.className = "cover-item";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Open ${b.title} by ${b.author || "Unknown"} (${b.format})`);

    const coverContent = b.coverDataUrl
      ? `<img src="${b.coverDataUrl}" alt="" class="cover-img" />`
      : `<div style="margin-top:24px;font-family:'Newsreader',Georgia,serif;font-size:var(--text-ui-lg);font-weight:700;line-height:1.25;color:${b.coverTitleColor || "#ffffff"};">${escHtml(b.title.split(":")[0])}</div>
         <div style="font-size:var(--text-ui-sm);opacity:0.85;margin-bottom:8px;">${escHtml(b.author || "")}</div>`;

    const fallbackBg = b.coverStyle || (b.format === "PDF"
      ? "background: linear-gradient(155deg, #8b2635 0%, #2a1216 100%); color: #fff;"
      : b.format === "TXT" || b.format === "MD"
        ? "background: linear-gradient(155deg, #334155 0%, #0f172a 100%); color: #fff;"
        : "background: linear-gradient(155deg, #1d6b4b 0%, #102a1f 100%); color: #fff;");

    const progressSuffix = b.finished ? " · Finished" : b.progress > 0 ? ` · ${b.progress}%` : "";

    card.innerHTML = `
      <div class="cover-frame${b.coverDataUrl ? " has-cover" : ""}" style="${b.coverDataUrl ? "" : fallbackBg}">
        <button type="button" class="cover-more-btn" data-act="menu" aria-label="Book options" aria-expanded="false">${moreSvg}</button>
        <div class="cover-menu" role="menu">
          <button type="button" class="cover-menu-item" role="menuitem" data-act="toggle-read">${markSvg}<span>${b.finished ? "Mark as unread" : "Mark as finished"}</span></button>
          <button type="button" class="cover-menu-item danger" role="menuitem" data-act="delete">${trashSvg}<span>Remove from library</span></button>
        </div>
        ${coverContent}
        ${b.progress > 0 && !b.finished ? `<div class="cover-prog-track"><div class="cover-prog-fill" style="width:${b.progress}%"></div></div>` : ""}
      </div>
      <div class="cover-title">${escHtml(b.title)}</div>
      <div class="cover-author">${escHtml(b.author || "Unknown author")} · ${escHtml(b.format)}${progressSuffix}</div>
    `;

    card.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (btn) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "menu") {
          const menu = card.querySelector(".cover-menu");
          const wasOpen = menu.classList.contains("open");
          closeAllCoverMenus();
          if (!wasOpen) {
            menu.classList.add("open");
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
      if (e.target.closest("button")) return;
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
      <span>Drop or import<br/>EPUB / PDF / TXT / MD</span>
    `;
    slot.onclick = () => $("upFile").click();
    grid.appendChild(slot);
  }
}

let openBookToken = 0;
let progressSaveTimer = null;
let pendingProgress = null;

function flushProgressSave() {
  clearTimeout(progressSaveTimer);
  progressSaveTimer = null;
  if (!pendingProgress) return;
  const { id, patch } = pendingProgress;
  pendingProgress = null;
  updateBookMeta(id, patch).catch(() => {});
}

function scheduleProgressSave(id, patch) {
  pendingProgress = { id, patch };
  clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(flushProgressSave, 450);
}

async function openBook(bookId) {
  const token = ++openBookToken;
  flushProgressSave();

  const book = await getBook(bookId);
  if (token !== openBookToken) return;
  if (!book) {
    showToast("Book could not be loaded.");
    return;
  }

  state.controller?.destroy();
  state.controller = null;
  state.activeBook = book;
  state.activeTocTarget = null;

  await updateBookMeta(book.id, { lastOpenedAt: Date.now() });
  if (token !== openBookToken) return;
  state.books = await getAllBooks();
  if (token !== openBookToken) return;

  $("activeBookFmt").textContent = book.format;
  $("activeBookTitle").textContent = book.title;
  $("activeBookTitle").title = book.title;
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
    onRelocated: ({ location, progress, label, tocTarget }) => {
      if (token !== openBookToken) return;
      $("locStatus").textContent = label;
      $("footerProgressFill").style.width = `${progress}%`;
      if (tocTarget !== undefined) setActiveToc(tocTarget);
      if (state.activeBook?.id === book.id) {
        state.activeBook.lastLocation = location;
        state.activeBook.progress = progress;
        scheduleProgressSave(book.id, { lastLocation: location, progress });
      }
    },
    onTocReady: (items) => {
      if (token === openBookToken) renderToc(items);
    },
    onWordLookup: (word, clientX, clientY) => handleWordLookup(word, clientX, clientY),
    onZoomChanged: (zoom) => {
      if (token === openBookToken) $("zoomVal").textContent = `${Math.round(zoom * 100)}%`;
    }
  };

  let controller = null;
  try {
    if (book.format === "EPUB") {
      const { EpubController } = await loadEpubReader();
      controller = new EpubController(commonOpts);
    } else if (book.format === "PDF") {
      const { PdfController } = await loadPdfReader();
      controller = new PdfController(commonOpts);
    } else {
      const { TextController } = await loadTextReader();
      controller = new TextController({ ...commonOpts, format: book.format });
    }
    if (token !== openBookToken) return;
    state.controller = controller;
    await controller.mount();
    if (token !== openBookToken) {
      controller.destroy();
      if (state.controller === controller) state.controller = null;
    }
  } catch (err) {
    if (token !== openBookToken) {
      controller?.destroy();
      return;
    }
    stage.innerHTML = `<div class="empty-state"><strong>Failed to open ${escHtml(book.title)}</strong><div style="margin-top:6px;">${escHtml(err?.message || "Invalid or corrupted file")}</div></div>`;
  }
}

function setActiveToc(target) {
  state.activeTocTarget = target ?? null;
  const list = $("tocList");
  if (!list) return;
  let activeBtn = null;
  list.querySelectorAll(".toc-btn").forEach((btn) => {
    const isMatch = target != null && btn.dataset.target === String(target);
    btn.classList.toggle("active", isMatch);
    btn.setAttribute("aria-current", isMatch ? "true" : "false");
    if (isMatch) activeBtn = btn;
  });
  if (activeBtn && state.tocOpen) {
    activeBtn.scrollIntoView({ block: "nearest" });
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
    btn.dataset.target = String(item.target);
    btn.textContent = item.label;
    btn.onclick = () => {
      setActiveToc(item.target);
      state.controller?.goTo(item.target);
      if (window.innerWidth <= 900) {
        setTocOpen(false);
      }
    };
    list.appendChild(btn);
  });
  setActiveToc(state.activeTocTarget);
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
let lookupToken = 0;

function closeFloatPop() {
  const pop = $("floatPop");
  if (!pop.classList.contains("open")) return;
  pop.classList.remove("open");
  navigator.vibrate?.(8);
  window.getSelection()?.removeAllRanges();
  document.querySelectorAll(".epub-mount iframe").forEach((f) => {
    try { f.contentWindow?.getSelection()?.removeAllRanges(); } catch {}
  });
}

async function handleWordLookup(word, clientX, clientY) {
  const token = ++lookupToken;
  lastLookupAt = Date.now();
  const railVisible = !state.focusMode && state.prefs.margin && state.prefs.dictVisible && window.innerWidth > 900;
  const targetEl = railVisible ? $("dictPin") : $("floatPop");

  targetEl.innerHTML = `Looking up <strong>${escHtml(word)}</strong>...`;
  if (!railVisible) {
    const pop = $("floatPop");
    const left = Math.min(Math.max(12, clientX + 10), window.innerWidth - 372);
    const top = Math.min(Math.max(12, clientY + 10), window.innerHeight - 260);
    const originX = Math.max(0, Math.min(360, clientX - left));
    const originY = Math.max(0, Math.min(240, clientY - top));
    pop.style.transformOrigin = `${originX}px ${originY}px`;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.add("open");
  }

  const res = await lookupDefinition(word);
  if (token !== lookupToken) return;
  if (!railVisible && !$("floatPop").classList.contains("open")) return;

  state.lastLookup = res;
  targetEl.innerHTML = buildDictMarkup(res);
  wireDictActions(targetEl, res);
  if (railVisible) {
    $("clearDictBtn").classList.remove("hidden");
  }
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.(epub|pdf|txt|md)$/i.test(f.name));
  if (files.length === 0) {
    showToast("Please select .epub, .pdf, .txt, or .md files.");
    return;
  }

  for (const file of files) {
    const lower = file.name.toLowerCase();
    const ext = lower.endsWith(".pdf") ? "PDF" : lower.endsWith(".md") ? "MD" : lower.endsWith(".txt") ? "TXT" : "EPUB";
    const fallbackTitle = file.name.replace(/\.(epub|pdf|txt|md)$/i, "");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const meta = ext === "EPUB"
        ? await (await loadEpubReader()).extractEpubMetadata(arrayBuffer, fallbackTitle)
        : ext === "PDF"
          ? await (await loadPdfReader()).extractPdfMetadata(arrayBuffer, fallbackTitle)
          : await (await loadTextReader()).extractTextMetadata(arrayBuffer, fallbackTitle, ext);

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

  document.querySelectorAll("[data-spread]").forEach((btn) => {
    btn.onclick = () => updatePrefs({ spread: btn.dataset.spread === "true" });
  });

  document.querySelectorAll("[data-flow]").forEach((btn) => {
    btn.onclick = () => updatePrefs({ flowMode: btn.dataset.flow });
  });

  $("btnToc").onclick = () => setTocOpen(!state.tocOpen);
  $("closeTocBtn").onclick = () => setTocOpen(false);

  $("btnMargin").onclick = () => updatePrefs({ margin: !state.prefs.margin }, false);

  $("btnFocus").onclick = () => setFocusMode(!state.focusMode);
  $("focusExitBtn").onclick = () => setFocusMode(false);
  $("focusPrevBtn").onclick = () => state.controller?.prev();
  $("focusNextBtn").onclick = () => state.controller?.next();

  $("hideMarginBtn").onclick = () => updatePrefs({ margin: false }, false);

  $("toggleDictSectionBtn").onclick = () => updatePrefs({ dictVisible: !state.prefs.dictVisible }, false);

  $("clearDictBtn").onclick = () => {
    $("dictPin").innerHTML = `<div class="muted-note">Double-click or select any word (or Alt + Click) to inspect its definition, phonetics, and audio without obscuring prose.</div>`;
    $("clearDictBtn").classList.add("hidden");
  };

  themeManager.initControls();

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

  $("zoomOutBtn").onclick = () => {
    const baseZoom = state.controller?.getEffectiveZoom?.() ?? state.prefs.pdfZoom;
    return updatePrefs({ pdfFit: false, pdfZoom: Math.max(0.55, Number((baseZoom - 0.15).toFixed(2))) });
  };
  $("zoomInBtn").onclick = () => {
    const baseZoom = state.controller?.getEffectiveZoom?.() ?? state.prefs.pdfZoom;
    return updatePrefs({ pdfFit: false, pdfZoom: Math.min(2.2, Number((baseZoom + 0.15).toFixed(2))) });
  };
  $("zoomFitBtn").onclick = () => updatePrefs({ pdfFit: true });

  $("bookmarkBtn").onclick = async () => {
    if (!state.activeBook || !state.controller) return;
    const bm = state.controller.getBookmarkPayload();
    if (!bm) return;
    const list = state.activeBook.bookmarks || [];
    list.unshift(bm);
    state.activeBook.bookmarks = list;
    await updateBookMeta(state.activeBook.id, { bookmarks: list });
    renderBookmarks();
    showToast(`Saved bookmark (${bm.label})`);
  };

  $("readingFormatSelect").onchange = (e) => updatePrefs({ readingFormat: e.target.value });
  $("fontFamilySelect").onchange = (e) => updatePrefs({ fontFamily: e.target.value });
  $("proseSize").oninput = (e) => updatePrefs({ fontSize: Number(e.target.value) });
  $("lineHeightRange").oninput = (e) => updatePrefs({ lineHeight: Number(e.target.value) });
  $("epubGuard").onchange = (e) => updatePrefs({ guard: e.target.checked });
  $("pdfAppearance").onchange = (e) => updatePrefs({ pdfMode: e.target.value });

  document.addEventListener("folio:stage-click", () => {
    if (Date.now() - lastLookupAt > 180) closeFloatPop();
  });
  document.addEventListener("click", (e) => {
    if (Date.now() - lastLookupAt > 180 && !$("floatPop").contains(e.target)) {
      closeFloatPop();
    }
    if (!e.target.closest(".cover-menu") && !e.target.closest(".cover-more-btn")) {
      closeAllCoverMenus();
    }
    if (!e.target.closest("#appearanceWrap")) {
      themeManager.closePopover();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.focusMode) setFocusMode(false);
      closeFloatPop();
      themeManager.closePopover();
      closeAllCoverMenus();
    }
    const tag = document.activeElement?.tagName;
    if (state.view === "folio" && !["INPUT", "SELECT", "TEXTAREA"].includes(tag)) {
      const isPaginated = state.prefs.flowMode !== "scroll";
      if (e.key === "ArrowRight" || (isPaginated && e.key === "PageDown")) {
        e.preventDefault();
        state.controller?.next();
      } else if (e.key === "ArrowLeft" || (isPaginated && e.key === "PageUp")) {
        e.preventDefault();
        state.controller?.prev();
      } else if (isPaginated && e.key === " " && !["BUTTON", "A"].includes(tag) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) state.controller?.prev();
        else state.controller?.next();
      } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFocusMode(!state.focusMode);
      }
    }
  });
}

function attachStageSwipe() {
  const stage = $("spreadStage");
  if (!stage) return;

  const tracker = new VelocityTracker();
  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let committed = false;
  let offsetX = 0;

  const spring = new FluidSpring({
    value: 0,
    damping: 0.9,
    response: 0.34,
    precision: 0.5,
    onUpdate: (val) => {
      offsetX = val;
      stage.style.transform = Math.abs(val) < 0.5 ? "" : `translate3d(${val}px, 0, 0)`;
    },
    onRest: () => {
      offsetX = 0;
      stage.style.transform = "";
    }
  });

  stage.addEventListener("pointerdown", (e) => {
    if (state.view !== "folio" || state.prefs.flowMode !== "paginated") return;
    // Only swipe-turn pages on touch/pen so desktop mouse text selection stays natural
    if (e.pointerType === "mouse") return;
    if (e.target.closest("button, a, input, select, textarea")) return;

    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    committed = false;
    dragging = true;
    tracker.reset();
    tracker.add(e.clientX, e.clientY);
    spring.stop();
  });

  stage.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      if (Math.hypot(dx, dy) < 12) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.1) {
        dragging = false;
        return;
      }
      committed = true;
      stage.setPointerCapture?.(e.pointerId);
    }

    tracker.add(e.clientX, e.clientY);
    const width = stage.clientWidth || 360;
    offsetX = rubberband(dx, width * 0.45, 0.55);
    stage.style.transform = `translate3d(${offsetX}px, 0, 0)`;
  });

  const finishSwipe = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    if (!committed) return;

    const { vx } = tracker.getVelocity();
    const projected = offsetX + projectMomentum(vx, 0.996);
    const threshold = Math.min(110, (stage.clientWidth || 360) * 0.24);

    if (projected < -threshold) {
      state.controller?.next();
    } else if (projected > threshold) {
      state.controller?.prev();
    }

    const hasMomentum = Math.abs(vx) > 300;
    spring.to(0, {
      velocity: vx * 0.35,
      damping: hasMomentum ? 0.85 : 1.0,
      response: 0.32
    });
  };

  stage.addEventListener("pointerup", finishSwipe);
  stage.addEventListener("pointercancel", finishSwipe);
}

async function init() {
  tocDrawerSwipe = attachDrawerSwipe({
    element: $("tocDrawer"),
    side: "left",
    enabled: () => window.innerWidth <= 900,
    isOpen: () => state.tocOpen,
    onOpenChange: (open) => setTocOpen(open)
  });
  window.addEventListener("pagehide", flushProgressSave);
  setTocOpen(false);
  syncControlsFromPrefs();
  wireEvents();
  attachStageSwipe();
  state.books = await getAllBooks();
  state.vocab = await getVocab();
  renderCatalog();
}

init();
