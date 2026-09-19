// app/api/analyze-media/route.ts
import { NextResponse } from "next/server";
import { GoogleGenAI, FileState, Type } from "@google/genai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { getGeminiApiKey } from "@/lib/env";
import { analysisSchema, categories, tactics } from "@/lib/schema";
import { examples } from "@/data/examples";

export const runtime = "nodejs";
export const maxDuration = 90;

const MAX_BYTES = 20 * 1024 * 1024;
const MIN_REAL_VIDEO_BYTES = 50_000;
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];

const DEMO_FILES: Record<string, string> = {
  grandparent: "grandparent.mp4",
  tech: "tech-support.mp4",
  irs: "government.mp4",
};

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mp3: "audio/mp3",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "video/webm",
};

const MIME_ALIASES: Record<string, string> = {
  "audio/mpeg": "audio/mp3",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
};

const SUPPORTED_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "audio/mp3",
  "audio/wav",
  "audio/mp4",
  "audio/webm",
]);

function resolveMime(file: File): string | null {
  const declared = MIME_ALIASES[file.type] ?? file.type;
  if (SUPPORTED_MIMES.has(declared)) return declared;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    riskScore: { type: Type.INTEGER },
    category: { type: Type.STRING, enum: [...categories] },
    summary: { type: Type.STRING },
    tacticCounts: {
      type: Type.OBJECT,
      properties: Object.fromEntries(tactics.map((tactic) => [tactic, { type: Type.INTEGER }])),
      required: [...tactics],
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          timestamp: { type: Type.NUMBER },
          tactic: { type: Type.STRING, enum: [...tactics, "none"] },
          explanation: { type: Type.STRING },
          counterAdvice: { type: Type.STRING },
        },
        required: ["text", "tactic", "explanation", "counterAdvice"],
      },
    },
  },
  required: ["riskScore", "category", "summary", "tacticCounts", "segments"],
};

const SYSTEM_INSTRUCTION = `You are a forensic cybersecurity conversation analyst.
Analyze the provided audio or video recording of a suspicious phone call:
1. Transcribe the spoken dialogue line by line, preserving wording and speaker turns (prefix lines with CALLER: or YOU: when distinguishable).
2. Segment the dialogue and detect the ONE primary manipulation tactic in each segment (urgency, authority_impersonation, isolation, threat, too_good_to_be_true, payment_request, personal_info_request, or none).
3. Set timestamp to the approximate start time in seconds for each segment when you can determine it.
4. Do not infer emotion or deception from voice tone or cadence.
5. Give specific, actionable counter-advice for every flagged tactic.
6. riskScore is 0-100 reflecting how strongly the conversation matches a scam. tacticCounts must equal the number of segments flagged per tactic.
If there is no intelligible speech, return a single segment with text "[no intelligible speech]", tactic "none", and riskScore 0.
Respond strictly in JSON matching the schema.`;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function cachedDemo(demoId?: string, fileName?: string) {
  const matched = examples.find((e) => e.id === demoId) ?? examples[0]!;
  return {
    ...matched.result,
    inputMode: "media" as const,
    mediaType: "video/mp4",
    fileName: fileName ?? matched.label,
    cached: true,
  };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number };
  return e?.status ?? e?.code;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function generateWithRetry(ai: GoogleGenAI, fileUri: string, mimeType: string) {
  let lastError: unknown;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({
          model,
          contents: [
            { fileData: { fileUri, mimeType } },
            { text: "Transcribe and analyze this call recording." },
          ],
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.2,
          },
        });
      } catch (err) {
        lastError = err;
        const status = statusOf(err);
        if (status === 401 || status === 403 || status === 400) throw err;
        if (status === 404) break; // try next model
        if (status === 429 || status === 503 || status === 500) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }
  throw lastError ?? new Error("All models failed.");
}

async function analyzeWithGemini(file: File, mimeType: string) {
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  let uploadedName: string | undefined;

  try {
    const uploaded = await ai.files.upload({
      file,
      config: { mimeType, displayName: file.name.slice(0, 100) },
    });
    uploadedName = uploaded.name;
    if (!uploaded.name) throw new Error("Gemini upload returned no file name.");

    const deadline = Date.now() + 50_000;
    let current = uploaded;
    while (current.state === FileState.PROCESSING && Date.now() < deadline) {
      await sleep(1500);
      current = await ai.files.get({ name: uploaded.name });
    }
    if (current.state !== FileState.ACTIVE || !current.uri) {
      throw new HttpError(422, "The media could not be processed. Try re-exporting it as .mp4 or .wav.");
    }

    const result = await generateWithRetry(ai, current.uri, mimeType);
    const raw = result.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(502, "The analysis engine returned an unreadable response. Please retry.");
    }

    const segments = (parsed as { segments?: unknown[] })?.segments;
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new HttpError(422, "No intelligible speech was detected in this recording.");
    }

    const validated = analysisSchema.parse(parsed);
    const counts = Object.fromEntries(
      tactics.map((t) => [t, validated.segments.filter((s) => s.tactic === t).length])
    ) as typeof validated.tacticCounts;

    return { ...validated, tacticCounts: counts, inputMode: "media" as const, mediaType: mimeType };
  } finally {
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: { message: err.message } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { message: "The analysis result failed validation. Please retry." } },
      { status: 502 }
    );
  }
  const message = err instanceof Error ? err.message : "";
  if (message.includes("GEMINI_API_KEY")) {
    return NextResponse.json(
      { error: { message: "Server is missing a valid GEMINI_API_KEY." } },
      { status: 500 }
    );
  }
  const status = statusOf(err);
  if (status === 429) {
    return NextResponse.json(
      { error: { message: "The AI service is rate-limited right now. Wait a moment and retry." } },
      { status: 429 }
    );
  }
  if (status === 401 || status === 403) {
    return NextResponse.json(
      { error: { message: "The AI service rejected the API key." } },
      { status: 500 }
    );
  }
  console.warn("[VEXA_MEDIA_ERROR]", err);
  return NextResponse.json(
    { error: { message: "Live analysis is temporarily unavailable. Please retry." } },
    { status: 502 }
  );
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  // ---------- Demo requests (JSON) ----------
  if (contentType.includes("application/json")) {
    let body: { demoId?: string; live?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: { message: "Invalid request body." } }, { status: 400 });
    }

    const demoId = body.demoId;
    const fileName = demoId ? DEMO_FILES[demoId] : undefined;
    if (!demoId || !fileName) {
      return NextResponse.json({ error: { message: "Unknown demo scenario." } }, { status: 400 });
    }

    // Default: instant, verified report. Live analysis is opt-in.
    if (!body.live) return NextResponse.json(cachedDemo(demoId, fileName));

    const filePath = path.join(process.cwd(), "public", "demo", fileName);
    const buffer = await readFile(filePath).catch(() => null);
    if (!buffer || buffer.length < MIN_REAL_VIDEO_BYTES) {
      console.warn(`[VEXA] Demo ${fileName} missing or invalid; serving verified report.`);
      return NextResponse.json(cachedDemo(demoId, fileName));
    }

    try {
      const demoFile = new File([new Uint8Array(buffer)], fileName, { type: "video/mp4" });
      const result = await analyzeWithGemini(demoFile, "video/mp4");
      return NextResponse.json({ ...result, fileName });
    } catch (err) {
      console.warn("[VEXA_DEMO_LIVE_FAILOVER]", err);
      return NextResponse.json(cachedDemo(demoId, fileName));
    }
  }

  // ---------- Real uploads (multipart) ----------
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: { message: "Unsupported request type." } }, { status: 415 });
  }

  let file: File | null = null;
  try {
    const formData = await request.formData();
    const candidate = formData.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return NextResponse.json({ error: { message: "Invalid media payload." } }, { status: 400 });
  }

  if (!file || file.size === 0) {
    return NextResponse.json({ error: { message: "No media file provided." } }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: { message: "Media files must be 20 MB or smaller." } }, { status: 413 });
  }

  const mimeType = resolveMime(file);
  if (!mimeType) {
    return NextResponse.json(
      { error: { message: "Unsupported media type. Use .mp4, .mp3, .wav, .m4a or .webm." } },
      { status: 415 }
    );
  }

  try {
    const result = await analyzeWithGemini(file, mimeType);
    return NextResponse.json({ ...result, fileName: file.name });
  } catch (err) {
    return errorResponse(err);
  }
}