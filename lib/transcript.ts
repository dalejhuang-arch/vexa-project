// lib/transcript.ts
import type { Speaker } from "./schema";

export type Turn = { speaker?: Speaker; text: string; start?: number };

const ABBREV = /\b(Mrs|Mr|Ms|Dr|St|Jr|Sr|No|vs|Inc|Ltd)\./g;

/* Exports from call-analysis tools look like:  "05 \n CALLER \n text \n Threat".
   Strip the index numbers and tag words, and fold the bare label onto the text line. */
const BARE_LABEL = /^(caller|scammer|agent|operator|speaker\s*a|you|victim|recipient|me|user|customer|speaker\s*b)$/i;
const TAG_LINE = /^(clear|threat|urgency|false authority|info request|isolation|payment request|too good to be true)$/i;

function normalizeExport(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((s) => s.trim());
  if (!lines.some((l) => BARE_LABEL.test(l))) return raw;
  const out: string[] = [];
  let pending = "";
  for (const l of lines) {
    if (!l) continue;
    if (/^\d{1,4}$/.test(l)) continue;
    if (TAG_LINE.test(l)) continue;
    if (BARE_LABEL.test(l)) {
      pending = l;
      continue;
    }
    out.push(pending ? `${pending}: ${l}` : l);
    pending = "";
  }
  return out.join("\n");
}

export function splitTurns(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n").replace(/^[^\S\n]*\d+(?=[A-Z])/, "").trim();
  if (!text) return [];

  let parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);

  if (parts.length <= 2) {
    const dbl = text.split(/\n+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (dbl.length > parts.length) parts = dbl;
  }

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

const LABEL_RE =
  /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(caller|scammer|agent|operator|speaker\s*a|you|victim|recipient|me|user|customer|speaker\s*b|person|a|b)\s*[:\-–—]\s*(.*)$/i;

/** Splits a transcript into turns and reads explicit speaker labels (CALLER:/YOU:/VICTIM:...) when present.
 *  Labels are treated as hints only; the analyst re-checks them against context. */
export function parseTurns(raw: string): Turn[] {
  const cleaned = normalizeExport(raw);
  const spaced = cleaned.replace(/\s+(?=(?:CALLER|SCAMMER|YOU|VICTIM|RECIPIENT)\s*:)/g, "\n");
  const turns: Turn[] = [];
  for (const part of splitTurns(spaced)) {
    const m = LABEL_RE.exec(part);
    if (m) {
      const label = (m[1] ?? "").toLowerCase().replace(/\s+/g, "");
      const speaker: Speaker = /^(caller|scammer|agent|operator|speakera|a)$/.test(label) ? "caller" : "victim";
      const text = (m[2] ?? "").trim();
      if (text.length > 0) turns.push({ speaker, text });
    } else if (part.length > 1) {
      turns.push({ text: part });
    }
  }
  return turns;
}