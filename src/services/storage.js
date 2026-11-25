const DB_NAME = "editorial_folio_db";
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("book_blobs")) {
        db.createObjectStore("book_blobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("vocab")) {
        db.createObjectStore("vocab", { keyPath: "word" });
      }
      if (!db.objectStoreNames.contains("dict_cache")) {
        db.createObjectStore("dict_cache", { keyPath: "word" });
      }

      // Migrate v1 records that stored binary `data` inside `books`
      if (event.oldVersion > 0 && event.oldVersion < 2 && tx) {
        const booksStore = tx.objectStore("books");
        const blobsStore = tx.objectStore("book_blobs");
        booksStore.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (record && record.data !== undefined) {
            const { data, ...meta } = record;
            blobsStore.put({ id: meta.id, data });
            cursor.update(meta);
          }
          cursor.continue();
        };
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

function runTx(storeNames, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        const store = Array.isArray(storeNames) ? tx : tx.objectStore(storeNames);
        const req = fn(store, tx);
        if (req && typeof req === "object" && "onsuccess" in req) {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        } else {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }
      })
  );
}

export async function getAllBooks() {
  const list = await runTx("books", "readonly", (s) => s.getAll());
  return (list || []).sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0));
}

export async function getBook(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["books", "book_blobs"], "readonly");
    let meta = null;
    let blob = null;
    tx.objectStore("books").get(id).onsuccess = (e) => { meta = e.target.result; };
    tx.objectStore("book_blobs").get(id).onsuccess = (e) => { blob = e.target.result; };
    tx.oncomplete = () => {
      if (!meta) resolve(null);
      else resolve({ ...meta, data: blob?.data ?? meta.data });
    };
    tx.onerror = () => reject(tx.error);
  });
}

export function saveBook(bookObj) {
  const { data, ...meta } = bookObj;
  return runTx(["books", "book_blobs"], "readwrite", (tx) => {
    tx.objectStore("books").put(meta);
    if (data !== undefined) {
      tx.objectStore("book_blobs").put({ id: meta.id, data });
    }
  });
}

export async function updateBookMeta(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("books", "readwrite");
    const store = tx.objectStore("books");
    let updated = null;
    store.get(id).onsuccess = (e) => {
      const existing = e.target.result;
      if (!existing) return;
      updated = { ...existing, ...patch };
      store.put(updated);
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
  });
}

export function deleteBook(id) {
  return runTx(["books", "book_blobs"], "readwrite", (tx) => {
    tx.objectStore("books").delete(id);
    tx.objectStore("book_blobs").delete(id);
  });
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
