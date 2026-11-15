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

  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = await res.json();
    const entry = entries[0];
    const phoneticObj = (entry.phonetics || []).find((p) => p.audio) || {};
    let audioUrl = phoneticObj.audio || "";
    if (audioUrl.startsWith("//")) audioUrl = "https:" + audioUrl;

    const normalized = {
      word,
      phonetic: entry.phonetic || (entry.phonetics || []).find((p) => p.text)?.text || "",
      audio: audioUrl,
      meanings: (entry.meanings || []).slice(0, 3).map((m) => ({
        partOfSpeech: m.partOfSpeech,
        definitions: (m.definitions || []).slice(0, 2).map((d) => ({
          definition: d.definition,
          example: d.example || ""
        }))
      }))
    };

    try {
      await setCachedDefinition(word, normalized);
    } catch {
      // Non-fatal cache write error
    }

    return { ...normalized, found: true, source: "Free Dictionary API" };
  } catch {
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
}
