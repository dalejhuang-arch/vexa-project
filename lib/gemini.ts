// lib/gemini.ts
import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey } from "./env";
import { analysisSchema, categories, tactics, type Analysis, type AudioSummary } from "./schema";
import { splitTurns } from "./transcript";

type FallbackReason = NonNullable<Analysis["fallbackReason"]>;

// Quotas are per-model, so falling through this list survives most 429s.
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"] as const;
const PER_MODEL_TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 42_000;

class GeminiTimeout extends Error {}
class SchemaError extends Error {}

export const responseSchema = {
  type: Type.OBJECT,
  properties: {
    riskScore: { type: Type.INTEGER },
    category: { type: Type.STRING, enum: [...categories] },
    verdict: { type: Type.STRING, enum: ["likely_scam", "suspicious", "likely_legitimate"] },
    summary: { type: Type.STRING },
    tacticCounts: {
      type: Type.OBJECT,
      properties: Object.fromEntries(tactics.map((t) => [t, { type: Type.INTEGER }])),
      required: [...tactics],
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          timestamp: { type: Type.NUMBER },
          speaker: { type: Type.STRING, enum: ["caller", "recipient", "unknown"] },
          tactic: { type: Type.STRING, enum: [...tactics, "none"] },
          explanation: { type: Type.STRING },
          counterAdvice: { type: Type.STRING },
        },
        required: ["text", "speaker", "tactic", "explanation", "counterAdvice"],
      },
    },
  },
  required: ["riskScore", "category", "verdict", "summary", "tacticCounts", "segments"],
};

export const ANALYST_RULES = `
CATEGORIES: ${categories.map((c) => `"${c}"`).join(", ")}.
TACTICS: urgency, authority_impersonation, isolation, threat, too_good_to_be_true, payment_request, personal_info_request, none.

SPEAKER INFERENCE — inputs frequently have NO speaker labels. Infer who speaks each segment using conversational logic:
- "caller" = the party who initiated the call, introduces themselves or an organization, gives instructions, asks for things, uses a formal or scripted register.
- "recipient" = the person receiving the call: asks clarifying or worried questions ("Is he in trouble?", "How much?"), answers requests, reacts emotionally, uses short natural replies.
- Speakers usually alternate; a short question after a long formal statement is almost always the recipient.
- Use "unknown" only when genuinely unclear. Strip any speaker labels from the segment text.

SEGMENTATION — one segment per speaker turn; split turns longer than ~3 sentences at sentence boundaries. Preserve wording exactly.

TACTIC RULES
- Only caller segments can carry a tactic. Recipient segments are always "none".
- Choose the ONE dominant tactic per caller segment, or "none" if the line has no coercive function.
- Polished scams avoid crude threats. Treat these as tactics: bureaucratic jargon used to sound official and confuse (authority_impersonation); "this is not an accusation" followed by pressure; staged hand-offs to a second "official"; "do not disconnect" / placing the victim on hold so they cannot consult anyone (isolation); refundable "verification payments", "guarantor" deposits, "processing adjustments", bail (payment_request); "remain calm" paired with an unfolding emergency (urgency); implied arrest or escalation (threat).
- Ordinary context-setting lines with no request, pressure, or credential ask are "none".

FRIENDLY / LEGITIMATE CALLS — family chatting, appointment reminders, delivery notices, and real customer service with no payment demand, no secrecy, no credential request and no coercion are LEGITIMATE. Do not invent tactics. Score them 0-15 and set verdict "likely_legitimate". Identifying as an organization alone is NOT a scam signal.

RISK CALIBRATION: 0-15 benign; 16-34 mildly unusual; 35-64 suspicious (some pressure or verification asks, no payment); 65-84 strong scam pattern; 85-100 textbook scam with payment demand plus threat/isolation/authority.
verdict: "likely_scam" (risk >= 65), "suspicious" (30-64), "likely_legitimate" (< 30).

tacticCounts MUST equal the number of segments flagged with each tactic.
counterAdvice: for flagged segments, one short, concrete sentence the recipient could say in the moment. For "none" segments, a brief neutral note.
summary: ONE plain-language sentence, no jargon.
Never fabricate audio observations if no cadence data was provided.
`;

const TEXT_SYSTEM_PROMPT = `You are a forensic conversation analyst specializing in phone-scam detection for a consumer-protection tool. You receive a call transcript (one turn per line, possibly without speaker labels) and optionally a vocal-cadence summary.
${ANALYST_RULES}
Respond ONLY with data matching the provided response schema.`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GeminiTimeout("Gemini request timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
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

function finalize(raw: string | undefined): Analysis {
  if (!raw) throw new SchemaError("Empty model response");
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new SchemaError("Model returned invalid JSON");
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  if (typeof obj.riskScore === "number") obj.riskScore = Math.max(0, Math.min(100, Math.round(obj.riskScore)));

  const parsed = analysisSchema.safeParse({ ...obj, inputMode: "transcript" });
  if (!parsed.success) throw new SchemaError(parsed.error.issues[0]?.message ?? "Schema validation failed");

  const v = parsed.data;
  const tacticCounts = Object.fromEntries(
    tactics.map((t) => [t, v.segments.filter((s) => s.tactic === t).length])
  ) as Analysis["tacticCounts"];
  return { ...v, tacticCounts } as Analysis;
}

export async function analyzeWithGemini(transcript: string, audioSummary?: AudioSummary): Promise<Analysis> {
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() }); // throws → classified "auth"
  const turns = splitTurns(transcript);
  const cadence = audioSummary
    ? `\n\nVOCAL CADENCE SUMMARY (from client-side audio analysis): ${JSON.stringify(audioSummary)}`
    : "";
  const contents = `TRANSCRIPT (one turn per line):\n${(turns.length ? turns : [transcript]).join("\n")}${cadence}`;

  const started = Date.now();
  let lastError: unknown;

  for (const model of MODELS) {
    if (Date.now() - started > TOTAL_BUDGET_MS) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await withTimeout(
          ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction: TEXT_SYSTEM_PROMPT,
              responseMimeType: "application/json",
              responseSchema,
              temperature: 0.2,
            },
          }),
          PER_MODEL_TIMEOUT_MS
        );
        return finalize(result.text);
      } catch (err) {
        lastError = err;
        const reason = classifyGeminiError(err);
        if (reason === "auth") throw err; // no point trying other models
        if (reason === "http_500" || reason === "http_503" || reason === "schema_invalid") {
          if (attempt === 0) {
            await sleep(700);
            continue; // one quick retry on the same model
          }
        }
        break; // 429 / timeout / other → next model
      }
    }
  }
  throw lastError ?? new Error("All Gemini models failed.");
}