// Splits a pasted transcript into speaker turns, even with no labels or line breaks.
const ABBREV = /\b(Mrs|Mr|Ms|Dr|St|Jr|Sr|No|vs|Inc|Ltd)\./g;

export function splitTurns(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/^[^\S\n]*\d+(?=[A-Z])/, "").trim();
  if (!text) return [];

  // 1. Explicit line breaks
  let parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  // 2. Double-space breaks (turns pasted onto one line)
  if (parts.length <= 2) {
    const dbl = text.split(/\n+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (dbl.length > parts.length) parts = dbl;
  }

  // 3. Sentence split for one giant block
  if (parts.length <= 2 && text.length > 300) {
    const protectedText = text.replace(ABBREV, "$1\u0000");
    const sentences =
      protectedText
        .match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)
        ?.map((s) => s.replace(/\u0000/g, ".").trim())
        .filter((s) => s.length > 1) ?? [];
    if (sentences.length > parts.length) parts = sentences;
  }

  return parts.filter((p) => p.length > 1).slice(0, 200);
}