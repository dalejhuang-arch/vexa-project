// app/api/analyze/route.ts
import { NextResponse } from "next/server";
import { analyzeRequestSchema } from "@/lib/schema";
import { heuristicFallback } from "@/lib/heuristicFallback";
import { hasGeminiApiKey } from "@/lib/env";
import { analyzeWithGemini, classifyGeminiError } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  if (process.env.FORCE_FALLBACK === "true" || !hasGeminiApiKey()) {
    return NextResponse.json({
      ...heuristicFallback(transcript),
      inputMode: "fallback",
      fallbackReason: !hasGeminiApiKey() ? "auth" : "forced",
    });
  }

  try {
    const result = await analyzeWithGemini(transcript, audioSummary);
    return NextResponse.json(result);
  } catch (err) {
    console.warn("[VEXA_API_FAILOVER_TO_HEURISTICS]", err instanceof Error ? err.message.slice(0, 200) : "error");
    return NextResponse.json({
      ...heuristicFallback(transcript),
      inputMode: "fallback",
      fallbackReason: classifyGeminiError(err),
    });
  }
}