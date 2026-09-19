// app/api/analyze/route.ts
import { NextResponse } from "next/server";
import { GoogleGenAI, Type } from "@google/genai";
import { analyzeRequestSchema, categories, tactics, type Analysis } from "@/lib/schema";
import { heuristicFallback } from "@/lib/heuristicFallback";
import { getGeminiApiKey, hasGeminiApiKey } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 45;

const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"] as const;

const responseSchema = {
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

const SYSTEM_INSTRUCTION = `You are a Tier-3 DFIR forensic conversation analyst for an institutional Cyber Threat Intelligence unit.
Analyze the incoming phone dialogue intercept:
1. Divide the transcript turn by turn. Label speaker as 'caller' or 'recipient'.
2. Identify which ONE coercive manipulation vector is being applied per turn (urgency, authority_impersonation, isolation, threat, too_good_to_be_true, payment_request, personal_info_request, or none). Only caller lines carry coercive tactics.
3. Formulate a precise, operational counter-response the victim should deploy to break the psychological anchor.
4. Classify the threat into one of the 8 canonical fraud typologies.
5. Score risk (0-100) based on coercion velocity, unverified credentials, pressure deadlines, and irreversible funds transfer demands.
6. Provide a concise, forensic threat summary sentence.
Strictly return structured JSON conforming to the schema.`;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON in request payload" } }, { status: 400 });
  }

  const parsed = analyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { message: parsed.error.issues[0]?.message || "Invalid payload" } }, { status: 400 });
  }

  const { transcript, audioSummary } = parsed.data;

  // Check manual force fallback flag or missing API Key
  if (process.env.FORCE_FALLBACK === "true" || !hasGeminiApiKey()) {
    const fallback = heuristicFallback(transcript);
    return NextResponse.json({
      ...fallback,
      inputMode: "fallback",
      fallbackReason: !hasGeminiApiKey() ? "auth" : "forced",
    });
  }

  try {
    const apiKey = getGeminiApiKey();
    const ai = new GoogleGenAI({ apiKey });

    const contents = `TRANSCRIPT TO ANALYZE:\n${transcript}${
      audioSummary ? `\n\nCADENCE SIGNALS: ${JSON.stringify(audioSummary)}` : ""
    }`;

    let rawJson = "";
    let lastError: unknown;

    for (const model of MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.1,
          },
        });
        rawJson = response.text || "";
        if (rawJson) break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!rawJson) {
      throw lastError || new Error("Model returned empty stream");
    }

    const clean = rawJson.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsedResult = JSON.parse(clean) as Analysis;

    // Recalculate true tactic counts directly from segments
    const tacticCounts = Object.fromEntries(
      tactics.map((t) => [t, parsedResult.segments.filter((s) => s.tactic === t).length])
    ) as Analysis["tacticCounts"];

    return NextResponse.json({
      ...parsedResult,
      tacticCounts,
      inputMode: "transcript",
    });
  } catch (err: unknown) {
    console.warn("[VEXA_API_FAILOVER_TO_HEURISTICS]", err);
    const msg = String(err);
    const reason = /quota|429|RESOURCE_EXHAUSTED/i.test(msg)
      ? "http_429"
      : /API key|auth|401|403/i.test(msg)
      ? "auth"
      : /timeout/i.test(msg)
      ? "timeout"
      : "network";

    const fallback = heuristicFallback(transcript);
    return NextResponse.json({
      ...fallback,
      inputMode: "fallback",
      fallbackReason: reason,
    });
  }
}