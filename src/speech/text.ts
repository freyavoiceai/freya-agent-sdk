// Only real tags: "<" then a letter or "/". A comparison such as "%3 < %5" is text and stays.
const TAG = /<\/?[a-zA-Z][^<>]*>/g;

/** Drops html tags and ***bold*** markers that a chat answer may carry; TTS would read them. */
export function cleanText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(TAG, "")
    .replace(/\*+/g, "")
    // a long run of one mark is noise to a listener
    .replace(/([.!?…])\1{3,}/g, "$1$1$1")
    .replace(/\s{2,}/g, (gap) => (gap.includes("\n") ? "\n" : " "));
}

/** The buffer ends inside a tag that the next chunk will close, e.g. "<b" or "</". */
function endsInTag(buf: string): boolean {
  const i = buf.lastIndexOf("<");
  return i >= 0 && buf.length - i <= 64 && /^<\/?([a-zA-Z][^<>]*)?$/.test(buf.slice(i));
}

// A dot after these is not a sentence end: "Sayın Dr. Ahmet", "kart, nakit vb. ödemeler".
const ABBREVIATIONS = new Set([
  "dr", "prof", "doç", "doc", "yrd", "uzm", "op", "av", "sn", "bkz", "örn", "vb", "vs", "vd",
  "no", "tel", "cad", "sok", "mah", "apt", "blv", "hz", "şti", "ltd", "tic", "san", "mr", "mrs", "ms",
]);

// No \p{..} classes: not every React Native engine has them.
const isLetter = (c: string) => c.toLowerCase() !== c.toUpperCase();
const isLower = (c: string) => isLetter(c) && c === c.toLowerCase();
const isDigit = (c: string) => c >= "0" && c <= "9";
export const isEndMark = (c: string) => c === "." || c === "!" || c === "?" || c === "…";
const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r";

/** The word right before `at`: letters and digits, at most 12 of them. */
function wordBefore(text: string, at: number): string {
  let i = at;
  while (i > 0 && at - i < 12 && (isLetter(text[i - 1]) || isDigit(text[i - 1]))) i--;
  return text.slice(i, at);
}

/** A sentence longer than this is cut at a space, so TTS gets requests of a bounded size. */
const MAX_SENTENCE = 1000;

function capped(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_SENTENCE) {
    const space = rest.lastIndexOf(" ", MAX_SENTENCE);
    const at = space > 0 ? space : MAX_SENTENCE;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Text arriving in pieces in, whole sentences out. A sentence ends at . ! ? or an ellipsis
 * followed by a space; the end of the buffer alone is not enough ("30." may go on as "30.000").
 * A dot after an abbreviation ("Dr.") or an ordinal ("3. taksit", a list's "1.") is no end.
 */
export class SentenceAssembler {
  private buf = "";

  feed(text: string): string[] {
    this.buf += text;
    // inside a tag, wait for the rest
    if (endsInTag(this.buf)) return [];
    const clean = cleanText(this.buf);
    const out: string[] = [];
    let last = 0;
    // one pass over the characters: a regex here backtracks over long runs of marks
    for (let i = 0; i < clean.length; i++) {
      if (!isEndMark(clean[i])) continue;
      let j = i;
      while (j < clean.length && isEndMark(clean[j])) j++;
      const end = j;
      i = j - 1;
      if (end >= clean.length || !isSpace(clean[end])) continue;
      if (end - i === 1 && clean[i] === ".") {
        const word = wordBefore(clean, i);
        // an initial ("M. Kemal", "A.Ş.") or an abbreviation
        // a suffix after an apostrophe ("ayın 5'i.") is no initial
        const initial = word.length === 1 && isLetter(word) && clean[i - 2] !== "'" && clean[i - 2] !== "’";
        if (initial || ABBREVIATIONS.has(word.toLowerCase())) continue;
        if (word && [...word].every(isDigit)) {
          const before = clean.slice(last, i - word.length);
          // "1. Kimlik": a numbered line
          if (word.length <= 2 && (!before.trim() || /\n[ \t]*$/.test(before))) continue;
          const next = clean[end + 1];
          // "3. taksit" or "taksit 3. Sonra": the next letter decides
          if (next === undefined) break;
          if (isLower(next)) continue;
        }
      }
      out.push(...capped(clean.slice(last, end)));
      last = end;
    }
    let rest = clean.slice(last);
    while (rest.length > MAX_SENTENCE) {
      const space = rest.lastIndexOf(" ", MAX_SENTENCE);
      const at = space > 0 ? space : MAX_SENTENCE;
      const s = rest.slice(0, at).trim();
      if (s) out.push(s);
      rest = rest.slice(at);
    }
    // cleaning again changes nothing, and a raw buffer would grow with every chunk
    this.buf = rest;
    return out;
  }

  flush(): string[] {
    const t = cleanText(this.buf).trim();
    this.buf = "";
    return t ? [t] : [];
  }
}

/**
 * A long first sentence is what the listener waits for, and TTS time grows with length, so its
 * head up to the first comma is voiced on its own.
 */
export function firstCut(text: string): string[] {
  if (text.length < 60) return [text];
  const i = text.indexOf(", ", 15);
  return i > 0 && i < text.length - 15 ? [text.slice(0, i + 1), text.slice(i + 2)] : [text];
}
