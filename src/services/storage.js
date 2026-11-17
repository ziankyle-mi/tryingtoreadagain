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
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
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
