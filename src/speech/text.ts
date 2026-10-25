// Only real tags: "<" then a letter or "/". A comparison such as "%3 < %5" is text and stays.
const TAG = /<\/?[a-zA-Z][^<>]*>/g;

/** Drops html tags and ***bold*** markers that a chat answer may carry; TTS would read them. */
export function cleanText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(TAG, "")
    .replace(/\*+/g, "")
    .replace(/\s{2,}/g, " ");
}

/** The buffer ends inside a tag that the next chunk will close, e.g. "<b" or "</". */
function endsInTag(buf: string): boolean {
  const i = buf.lastIndexOf("<");
  return i >= 0 && buf.length - i <= 64 && /^<\/?([a-zA-Z][^<>]*)?$/.test(buf.slice(i));
}

/**
 * Text arriving in pieces in, whole sentences out. A sentence ends at . ! ? or an ellipsis
 * followed by a space; the end of the buffer alone is not enough ("30." may go on as "30.000").
 */
export class SentenceAssembler {
  private buf = "";

  feed(text: string): string[] {
    this.buf += text;
    // inside a tag, wait for the rest
    if (endsInTag(this.buf)) return [];
    const clean = cleanText(this.buf);
    const out: string[] = [];
    const re = /[.!?…]+(?=\s)/g;
    let last = 0;
    for (let m = re.exec(clean); m; m = re.exec(clean)) {
      const s = clean.slice(last, m.index + m[0].length).trim();
      if (s) out.push(s);
      last = m.index + m[0].length;
    }
    if (out.length) this.buf = clean.slice(last);
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
