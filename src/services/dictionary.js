import { getCachedDefinition, setCachedDefinition } from "./storage.js";

const FALLBACK_DICT = {
  deliberate: {
    phonetic: "/dɪˈlɪb.ər.ət/",
    audio: "",
    meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Done consciously and intentionally; careful and unhurried.", example: "She took deliberate steps across the library floor." }] }]
  },
  verisimilitude: {
    phonetic: "/ˌvɛr.ɪ.sɪˈmɪl.ɪ.tjuːd/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "The appearance of being true or real.", example: "Detailed typography gave the folio historical verisimilitude." }] }]
  },
  epistemology: {
    phonetic: "/ɪˌpɪs.təˈmɒl.ə.dʒi/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "The theory of knowledge, especially regarding its methods, validity, and scope." }] }]
  },
  ephemeral: {
    phonetic: "/ɪˈfɛm.ər.əl/",
    audio: "",
    meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Lasting for a very short time." }] }]
  },
  legibility: {
    phonetic: "/ˌlɛdʒ.ɪˈbɪl.ɪ.ti/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "The quality of being clear enough to read." }] }]
  },
  fidelity: {
    phonetic: "/fɪˈdɛl.ɪ.ti/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "Faithfulness to a person, cause, or belief; the degree of exactness with which something is reproduced." }] }]
  },
  taxonomy: {
    phonetic: "/tækˈsɒn.ə.mi/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A scheme of classification." }] }]
  },
  deterministic: {
    phonetic: "/dɪˌtɜː.mɪˈnɪs.tɪk/",
    audio: "",
    meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Relating to a process whose output is completely determined by its inputs." }] }]
  },
  resilience: {
    phonetic: "/rɪˈzɪl.jəns/",
    audio: "",
    meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "The capacity to withstand or recover quickly from difficulties." }] }]
  }
};

export function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function bindWordLookupEvents(target, win, onWord) {
  const doc = win?.document || target?.ownerDocument || document;
  target.addEventListener("dblclick", (e) => {
    const word = extractSelectedWord(win) || extractWordAtPoint(doc, win, e.clientX, e.clientY);
    if (word) onWord(word, e.clientX, e.clientY);
  });
  target.addEventListener("mouseup", (e) => {
    if (e.button !== 0 || e.detail >= 2) return;
    const word = extractSelectedWord(win);
    if (word) onWord(word, e.clientX, e.clientY);
  });
  target.addEventListener("click", (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    const word = extractWordAtPoint(doc, win, e.clientX, e.clientY);
    if (word) onWord(word, e.clientX, e.clientY);
  });
}

export function cleanWord(raw) {
  return String(raw || "")
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
    .toLowerCase();
}

export function extractSelectedWord(win) {
  const sel = win?.getSelection?.()?.toString().trim() || "";
  if (!sel || /\s/.test(sel) || sel.length > 42) return "";
  return cleanWord(sel);
}

export function extractWordAtPoint(doc, win, clientX, clientY) {
  const sel = win.getSelection?.()?.toString().trim() || "";
  if (sel && !/\s/.test(sel)) {
    const cleaned = cleanWord(sel);
    if (cleaned) return cleaned;
  }

  let node = null;
  let offset = 0;

  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (range && range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }

  if (!node) return "";
  const text = node.textContent || "";
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z'-]/.test(text[start - 1])) start--;
  while (end < text.length && /[A-Za-z'-]/.test(text[end])) end++;
  return cleanWord(text.slice(start, end));
}

const POS_MAP = { n: "noun", v: "verb", adj: "adjective", adv: "adverb" };

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

async function fetchFromFreeDict(word) {
  const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!res.ok) return null;
  const entries = await res.json();
  const entry = entries?.[0];
  if (!entry?.meanings?.length) return null;

  const phoneticObj = (entry.phonetics || []).find((p) => p.audio) || {};
  let audioUrl = phoneticObj.audio || "";
  if (audioUrl.startsWith("//")) audioUrl = "https:" + audioUrl;

  return {
    word,
    phonetic: entry.phonetic || (entry.phonetics || []).find((p) => p.text)?.text || "",
    audio: audioUrl,
    meanings: entry.meanings.slice(0, 3).map((m) => ({
      partOfSpeech: m.partOfSpeech,
      definitions: (m.definitions || []).slice(0, 3).map((d) => ({
        definition: d.definition,
        example: d.example || ""
      }))
    }))
  };
}

async function fetchFromWiktionary(word) {
  const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const entries = data?.en;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const meanings = entries.slice(0, 3).map((m) => ({
    partOfSpeech: String(m.partOfSpeech || "term").toLowerCase(),
    definitions: (m.definitions || [])
      .map((d) => ({
        definition: stripHtml(d.definition),
        example: stripHtml(d.examples?.[0] || "")
      }))
      .filter((d) => d.definition)
      .slice(0, 3)
  })).filter((m) => m.definitions.length > 0);

  if (meanings.length === 0) return null;
  return { word, phonetic: "", audio: "", meanings };
}

async function fetchFromDatamuse(word) {
  const res = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=d&max=1`);
  if (!res.ok) return null;
  const items = await res.json();
  const hit = items?.[0];
  if (!hit || hit.word?.toLowerCase() !== word || !Array.isArray(hit.defs) || hit.defs.length === 0) {
    return null;
  }

  const grouped = new Map();
  for (const raw of hit.defs) {
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const pos = POS_MAP[raw.slice(0, tab)] || "term";
    const def = raw.slice(tab + 1).trim();
    if (!def) continue;
    if (!grouped.has(pos)) grouped.set(pos, []);
    if (grouped.get(pos).length < 3) grouped.get(pos).push({ definition: def, example: "" });
  }

  const meanings = Array.from(grouped.entries()).slice(0, 3).map(([partOfSpeech, definitions]) => ({
    partOfSpeech,
    definitions
  }));
  if (meanings.length === 0) return null;
  return { word, phonetic: "", audio: "", meanings };
}

const DICT_PROVIDERS = [
  ["Free Dictionary API", fetchFromFreeDict],
  ["Wiktionary", fetchFromWiktionary],
  ["Datamuse", fetchFromDatamuse]
];

export async function lookupDefinition(rawWord) {
  const word = cleanWord(rawWord);
  if (!word) {
    return { word: "", found: false, source: "Invalid selection", meanings: [] };
  }

  try {
    const cached = await getCachedDefinition(word);
    if (cached && cached.data) {
      return { ...cached.data, word, found: true, source: "Saved locally" };
    }
  } catch {
    // Continue to live lookup if cache read fails
  }

  for (const [source, fetchProvider] of DICT_PROVIDERS) {
    try {
      const normalized = await fetchProvider(word);
      if (!normalized) continue;
      try {
        await setCachedDefinition(word, normalized);
      } catch {
        // Non-fatal cache write error
      }
      return { ...normalized, found: true, source };
    } catch {
      // Try next backup provider
    }
  }

  const fb = FALLBACK_DICT[word];
  if (fb) {
    return { ...fb, word, found: true, source: "Offline Fallback" };
  }
  return {
    word,
    phonetic: "",
    audio: "",
    meanings: [],
    found: false,
    source: navigator.onLine ? "Word not found" : "Offline (uncached)"
  };
}
