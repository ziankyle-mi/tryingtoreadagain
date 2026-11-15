import JSZip from "jszip";

const DB_NAME = "editorial_folio_db";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("vocab")) {
        db.createObjectStore("vocab", { keyPath: "word" });
      }
      if (!db.objectStoreNames.contains("dict_cache")) {
        db.createObjectStore("dict_cache", { keyPath: "word" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function runTx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = fn(store);
        if (req && typeof req === "object" && "onsuccess" in req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }
      })
  );
}

export async function getAllBooks() {
  const list = await runTx("books", "readonly", (s) => s.getAll());
  return (list || []).sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
}

export function getBook(id) {
  return runTx("books", "readonly", (s) => s.get(id));
}

export function saveBook(bookObj) {
  return runTx("books", "readwrite", (s) => s.put(bookObj));
}

export async function updateBookMeta(id, patch) {
  const existing = await getBook(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await saveBook(updated);
  return updated;
}

export function deleteBook(id) {
  return runTx("books", "readwrite", (s) => s.delete(id));
}

export async function getVocab() {
  const items = await runTx("vocab", "readonly", (s) => s.getAll());
  return (items || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function saveVocabWord(entry) {
  return runTx("vocab", "readwrite", (s) => s.put(entry));
}

export function removeVocabWord(word) {
  return runTx("vocab", "readwrite", (s) => s.delete(word));
}

export function getCachedDefinition(word) {
  return runTx("dict_cache", "readonly", (s) => s.get(word));
}

export function setCachedDefinition(word, data) {
  return runTx("dict_cache", "readwrite", (s) => s.put({ word, data, cachedAt: Date.now() }));
}

async function buildSampleEpubBuffer() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Craft of Reading: Digital Typography &amp; Structure</dc:title>
    <dc:creator>A. Mercer</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:editorial-folio-starter-epub</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chap1"/>
    <itemref idref="chap2"/>
  </spine>
</package>`
  );

  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:editorial-folio-starter-epub"/></head>
  <docTitle><text>The Craft of Reading</text></docTitle>
  <navMap>
    <navPoint id="nav1" playOrder="1"><navLabel><text>Chapter I: Two-Page Balance</text></navLabel><content src="chap1.xhtml"/></navPoint>
    <navPoint id="nav2" playOrder="2"><navLabel><text>Chapter II: Resilience &amp; Contrast</text></navLabel><content src="chap2.xhtml"/></navPoint>
  </navMap>
</ncx>`
  );

  zip.file(
    "OEBPS/chap1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter I: Two-Page Balance</title></head>
<body>
  <h1>Chapter I — Two-Page Balance</h1>
  <p>Broad margins and paired columns invite slower, more <em>deliberate</em> attention. When a reader pauses on an unfamiliar term like <strong>verisimilitude</strong>, <strong>ephemeral</strong>, or <strong>epistemology</strong>, right-clicking surfaces the definition in the Marginalia Rail without covering surrounding prose.</p>
  <blockquote>"A well-set page disappears behind the ideas it carries."</blockquote>
  <p style="color:#000000;background:#ffffff;padding:10px;border-radius:6px;">
    [Publisher Inline Style Test] This paragraph carries hardcoded black text on a white background inside the EPUB XHTML. Switch to Ink or Night theme and toggle EPUB Contrast Guard off/on to verify theme protection.
  </p>
  <p>Preserving italics, blockquotes, headings, and section breaks ensures the author's intent stays intact while letting you tailor typography, margins, and line height.</p>
</body>
</html>`
  );

  zip.file(
    "OEBPS/chap2.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>Chapter II: Resilience &amp; Contrast</title></head>
<body>
  <h1>Chapter II — Resilience &amp; Contrast</h1>
  <p>Contrast failure happens when reader chrome turns dark while embedded stylesheets insist on dark ink. A deterministic CSS override layer guarantees <strong>legibility</strong> and serenity across Ivory, Antique, Sage, Ink, and Night themes.</p>
  <p>Every imported manuscript and your reading position are saved locally so sessions resume right where you left off.</p>
</body>
</html>`
  );

  return zip.generateAsync({ type: "arraybuffer", mimeType: "application/epub+zip" });
}

function buildSamplePdfBuffer() {
  const escPdf = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const makeStream = (lines) => {
    const ops = ["BT", "/F1 18 Tf", "56 730 Td", `(${escPdf(lines[0])}) Tj`, "/F1 11 Tf", "0 -30 Td"];
    for (let i = 1; i < lines.length; i++) {
      ops.push(`(${escPdf(lines[i])}) Tj`);
      ops.push("0 -18 Td");
    }
    ops.push("ET");
    return ops.join("\n");
  };

  const s1 = makeStream([
    "Monograph on Paper Geometry",
    "Page 1: Dual-Layer PDF Rendering (Canvas + TextLayer)",
    "",
    "Portable documents rely on precise coordinates and fixed layout.",
    "Converting a PDF naively into reflowed HTML often scrambles columns.",
    "Instead, PDF.js renders crisp glyphs onto a high-DPI Canvas layer",
    "while overlaying a transparent, word-aligned TextLayer.",
    "",
    "Right-click words such as fidelity, taxonomy, deterministic, or",
    "resilience directly on this page to verify dictionary lookup and",
    "Smart Dark Invert theme adaptation without distorting layout."
  ]);

  const s2 = makeStream([
    "Local Persistence & Offline Reading",
    "Page 2: Saving Full Books Locally",
    "",
    "Your imported EPUB and PDF books are stored locally in your browser",
    "alongside extracted covers, bookmarks, and cached word definitions.",
    "",
    "Every word lookup is cached locally so previously inspected terms",
    "open instantaneously even without an active internet connection."
  ]);

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${s1.length} >>\nstream\n${s1}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n",
    `6 0 obj\n<< /Length ${s2.length} >>\nstream\n${s2}\nendstream\nendobj\n`,
    "7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new TextEncoder().encode(pdf).buffer;
}

const SEEDED_FLAG = "editorial_folio_seeded_v1";

export async function seedStarterBooksIfEmpty() {
  const existing = await getAllBooks();
  const oldStarter = existing.find((b) => b.id === "starter-epub-craft" && b.coverStyle?.includes("#d6d0c4"));
  if (oldStarter) {
    await updateBookMeta(oldStarter.id, {
      coverStyle: "background: linear-gradient(175deg, #1e2024 0%, #131518 100%); color: #f5f2eb;"
    });
    return getAllBooks();
  }
  if (existing.length > 0 || localStorage.getItem(SEEDED_FLAG) === "1") {
    return existing;
  }

  const [epubData, pdfData] = await Promise.all([buildSampleEpubBuffer(), Promise.resolve(buildSamplePdfBuffer())]);

  const now = Date.now();
  const starters = [
    {
      id: "starter-epub-craft",
      title: "The Craft of Reading: Digital Typography & Structure",
      author: "A. Mercer",
      format: "EPUB",
      data: epubData,
      coverDataUrl: null,
      coverStyle: "background: linear-gradient(175deg, #1e2024 0%, #131518 100%); color: #f5f2eb;",
      coverTitleColor: "#f5f2eb",
      progress: 0,
      finished: false,
      lastLocation: null,
      bookmarks: [],
      addedAt: now,
      lastOpenedAt: now
    },
    {
      id: "starter-pdf-monograph",
      title: "Monograph on Paper Geometry",
      author: "Prof. R. Alvarez",
      format: "PDF",
      data: pdfData,
      coverDataUrl: null,
      coverStyle: "background: linear-gradient(155deg, #f3efe6 0%, #e1d7c3 100%); color: #2a2118;",
      coverTitleColor: "#2a2118",
      progress: 0,
      finished: false,
      lastLocation: 1,
      bookmarks: [],
      addedAt: now - 1000,
      lastOpenedAt: now - 1000
    }
  ];

  for (const book of starters) {
    await saveBook(book);
  }
  localStorage.setItem(SEEDED_FLAG, "1");
  return getAllBooks();
}
