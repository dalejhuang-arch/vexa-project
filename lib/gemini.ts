// lib/gemini.ts
import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey } from "./env";
import { categories, normalizeSpeaker, tactics, type Analysis, type AudioSummary, type Speaker, type TacticValue } from "./schema";
import { parseTurns, type Turn } from "./transcript";
import {
  TACTIC_COUNTER,
  TACTIC_EXPLAIN,
  buildSummary,
  countTactics,
  detectCategory,
  detectTactic,
  inferSpeakers,
  neutralNote,
  riskFloor,
  riskFromCounts,
  verdictOf,
} from "./heuristicFallback";

type FallbackReason = NonNullable<Analysis["fallbackReason"]>;

const PER_MODEL_TIMEOUT_MS = 20_000;
class GeminiTimeout extends Error {}
class SchemaError extends Error {}

export const responseSchema = {
  type: Type.OBJECT,
  properties: {
    riskScore: { type: Type.INTEGER },
    category: { type: Type.STRING, enum: [...categories] },
    summary: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          turn: { type: Type.INTEGER },
          speaker: { type: Type.STRING, enum: ["caller", "victim"] },
          tactic: { type: Type.STRING, enum: [...tactics, "none"] },
          explanation: { type: Type.STRING },
          counterAdvice: { type: Type.STRING },
        },
        required: ["turn", "speaker", "tactic", "explanation", "counterAdvice"],
      },
    },
  },
  required: ["riskScore", "category", "summary", "segments"],
};

export const ANALYST_RULES = `
CATEGORIES: ${categories.map((c) => `"${c}"`).join(", ")}.

INPUT: numbered turns "id | speaker hint | text". Hint is CALLER / VICTIM when known (ground truth, never contradict it) or "?" when unknown.
OUTPUT: EXACTLY one segment per input turn, same order, "turn" = the input id. NEVER skip, merge or add turns. Short replies ("Yes.", "Okay", "But what is this?") get their own segment.

SPEAKERS (for "?" hints) - reason over the WHOLE conversation:
- CALLER placed the call: introduces themselves or an organization, makes claims, gives instructions, asks for things, uses formal/scripted language, robocall/IVR voices.
- VICTIM received the call: answers, asks worried/clarifying questions ("Who is this?", "How much?"), agrees, hesitates, pushes back.
- A short greeting at the very start ("Hello?") is the victim answering. Speakers normally alternate, but a caller may speak several turns in a row.

TACTICS (one dominant per CALLER turn, else "none"). Victim turns are ALWAYS "none" but use them as context (compliance or doubt shows how the caller's pressure landed).
- urgency: deadline or time pressure ("within 48 hours", "right now", "before the warrant is issued").
- authority_impersonation: claims to be a government agent, investigator, bank, utility, tech company, lawyer; titles, case numbers, official-sounding departments, bureaucratic jargon meant to sound official.
- isolation: keeps the victim from consulting anyone or verifying: "don't tell anyone", "stay on the line", "do not disconnect", hold placements.
- threat: arrest, warrant, lawsuit, legal action, frozen account, deportation, harm, "escalate to authorities".
- too_good_to_be_true: prize, rebate, refund, grant, guaranteed returns, unexpected money.
- payment_request: any demand for money: gift cards, crypto, wire, cash, down payment, "settlement", bail, refundable deposit, verification/processing fees.
- personal_info_request: SSN/SIN, birth date, card or account or meter numbers, passwords, OTP codes, remote access, "press 1 to verify".
Judge a line by its FUNCTION in context, not keywords. "We will never ask for your password" is not a request. "This is not an accusation" followed by pressure IS pressure. A line that only introduces the caller without pressure can be "none", but a fake official title is authority_impersonation.

LEGITIMATE CALLS: appointment reminders, delivery notices, family chat and normal customer service with no payment demand, secrecy, credential ask or coercion are LEGITIMATE. Do not invent tactics. Score 0-15.

RISK: 0-15 benign; 16-34 unusual; 35-64 suspicious; 65-84 strong scam pattern; 85-100 textbook scam (payment demand plus threat/authority/isolation).
counterAdvice: for flagged turns one short concrete sentence the victim could say. Empty string for "none".
summary: ONE plain-language sentence.
Never invent audio observations.
`;

const SYSTEM_PROMPT = `You are a forensic phone-scam analyst for a cybersecurity threat-intelligence tool.
${ANALYST_RULES}
Return ONLY JSON: {"riskScore":0,"category":"Other/Unclear","summary":"","segments":[{"turn":1,"speaker":"caller","tactic":"none","explanation":"","counterAdvice":""}]}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new GeminiTimeout("Gemini request timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function classifyGeminiError(error: unknown): FallbackReason {
  if (error instanceof GeminiTimeout) return "timeout";
  if (error instanceof SchemaError) return "schema_invalid";
  const e = error as { status?: number; message?: string } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const msg = String(e?.message ?? error ?? "");
  if (msg.includes("GEMINI_API_KEY")) return "auth";
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) return "auth";
  if (status === 429 || /RESOURCE_EXHAUSTED|\b429\b|quota/i.test(msg)) return "http_429";
  if (status === 400) return "schema_invalid";
  if (status === 500) return "http_500";
  if (status === 502) return "http_502";
  if (status === 503 || /UNAVAILABLE|overloaded/i.test(msg)) return "http_503";
  return "network";
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const isTactic = (v: string): v is (typeof tactics)[number] => (tactics as readonly string[]).includes(v);

function toTactic(v: unknown): TacticValue {
  const k = str(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isTactic(k)) return k;
  const alias: Record<string, TacticValue> = {
    authority: "authority_impersonation",
    impersonation: "authority_impersonation",
    payment: "payment_request",
    personal_info: "personal_info_request",
    info_request: "personal_info_request",
    too_good: "too_good_to_be_true",
    threats: "threat",
  };
  return alias[k] ?? "none";
}

function finalize(raw: string | undefined, turns: Turn[], authoritative: boolean): Analysis {
  if (!raw) throw new SchemaError("Empty model response");
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new SchemaError("Model returned invalid JSON");
  }
  const obj: Rec = isRec(json) ? json : {};
  const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];

  // Align model output to input turns by id (never trust ordering or count).
  const byTurn = new Map<number, Rec>();
  rawSegs.forEach((s, i) => {
    if (!isRec(s)) return;
    const n = Number(s.turn);
    const id = Number.isInteger(n) && n >= 1 && n <= turns.length ? n : rawSegs.length === turns.length ? i + 1 : 0;
    if (id && !byTurn.has(id)) byTurn.set(id, s);
  });

  const guessed = inferSpeakers(turns);
  const segments = turns.map((t, i) => {
    const s = byTurn.get(i + 1);
    let speaker: Speaker = authoritative && t.speaker && t.speaker !== "unknown" ? t.speaker : normalizeSpeaker(s?.speaker);
    if (speaker === "unknown") speaker = t.speaker ?? guessed[i] ?? "unknown";
    let tactic: TacticValue = s ? toTactic(s.tactic) : detectTactic(t.text, speaker); // missing turn -> local repair
    if (speaker === "victim") tactic = "none";
    const explanation = tactic === "none" ? neutralNote(speaker) : str(s?.explanation).trim() || TACTIC_EXPLAIN[tactic];
    const counterAdvice = tactic === "none" ? "" : str(s?.counterAdvice).trim() || TACTIC_COUNTER[tactic];
    return { text: t.text, timestamp: t.start, speaker, tactic, explanation, counterAdvice };
  });

  const counts = countTactics(segments);
  const flagged = segments.filter((s) => s.tactic !== "none").length;
  const modelRisk = typeof obj.riskScore === "number" && Number.isFinite(obj.riskScore) ? obj.riskScore : riskFromCounts(counts, flagged, segments.length);
  let risk = Math.max(modelRisk, riskFloor(counts));
  if (flagged === 0) risk = Math.min(risk, 20);
  risk = Math.max(0, Math.min(100, Math.round(risk)));

  const modelCat = str(obj.category);
  let category = (categories as readonly string[]).includes(modelCat) ? (modelCat as (typeof categories)[number]) : "Other/Unclear";
  if (category === "Other/Unclear" && flagged > 0) category = detectCategory(segments.filter((s) => s.speaker !== "victim").map((s) => s.text).join(" "));

  return {
    riskScore: risk,
    category,
    verdict: verdictOf(risk),
    summary: str(obj.summary).trim() || buildSummary(category, counts, flagged),
    tacticCounts: counts,
    segments,
    inputMode: "transcript",
  };
}

type Step = { model: string; schema: boolean };
function ladder(): Step[] {
  const env = (process.env.GEMINI_MODELS ?? "").split(",").map((s) => s.trim().replace(/^models\//, "")).filter(Boolean);
  const uniq = Array.from(new Set([...env, "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"]));
  const steps: Step[] = uniq.map((model) => ({ model, schema: true }));
  steps.push({ model: uniq[0] ?? "gemini-flash-latest", schema: false }, { model: uniq[1] ?? "gemini-2.5-flash", schema: false });
  return steps;
}

export type AnalyzeOpts = { authoritative?: boolean; audioSummary?: AudioSummary; budgetMs?: number };

/** Analyze turns with Gemini. Always returns one segment per turn or throws (caller then uses the heuristic engine). */
export async function analyzeTurns(turns: Turn[], opts: AnalyzeOpts = {}): Promise<Analysis> {
  if (turns.length === 0) throw new SchemaError("No turns to analyze");
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() }); // throws -> "auth"
  const authoritative = opts.authoritative ?? turns.every((t) => t.speaker && t.speaker !== "unknown");
  const lines = turns.map((t, i) => `${i + 1} | ${t.speaker && t.speaker !== "unknown" ? t.speaker.toUpperCase() : "?"} | ${t.text}`);
  const cadence = opts.audioSummary ? `\n\nVOCAL CADENCE SUMMARY: ${JSON.stringify(opts.audioSummary)}` : "";
  const contents = `TURNS (${turns.length}). Return exactly ${turns.length} segments.\n${lines.join("\n")}${cadence}`;

  const started = Date.now();
  const budget = opts.budgetMs ?? 42_000;
  let lastError: unknown;

  for (const step of ladder()) {
    if (Date.now() - started > budget) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await withTimeout(
          ai.models.generateContent({
            model: step.model,
            contents,
            config: {
              systemInstruction: SYSTEM_PROMPT,
              responseMimeType: "application/json",
              temperature: 0.1,
              maxOutputTokens: 16384,
              ...(step.schema ? { responseSchema } : {}),
            },
          }),
          PER_MODEL_TIMEOUT_MS
        );
        return finalize(result.text, turns, authoritative);
      } catch (err) {
        lastError = err;
        const reason = classifyGeminiError(err);
        if (reason === "auth") throw err;
        if ((reason === "http_500" || reason === "http_503" || reason === "schema_invalid") && attempt === 0) {
          await sleep(600);
          continue;
        }
        break; // 429 / timeout / other -> next rung
      }
    }
  }
  throw lastError ?? new Error("All Gemini models failed.");
}

export async function analyzeWithGemini(transcript: string, audioSummary?: AudioSummary): Promise<Analysis> {
  const turns = parseTurns(transcript);
  return analyzeTurns(turns.length ? turns : [{ text: transcript.trim() }], { audioSummary });
}