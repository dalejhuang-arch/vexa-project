// app/api/analyze-media/route.ts
// Stage 1: Gemini transcribes + diarizes the audio (CALLER / VICTIM by voice) with a resilient plan ladder.
// Stage 2: the shared analyst (lib/gemini.ts) classifies every turn. Falls back to the local heuristic engine.
import { NextResponse } from "next/server";
import { GoogleGenAI, FileState, Type } from "@google/genai";
import { getGeminiApiKey } from "@/lib/env";
import { analyzeTurns, classifyGeminiError } from "@/lib/gemini";
import { heuristicTurns } from "@/lib/heuristicFallback";
import { normalizeSpeaker } from "@/lib/schema";
import type { Turn } from "@/lib/transcript";

export const runtime = "nodejs";
export const maxDuration = 90;
export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;
const INLINE_LIMIT = 14 * 1024 * 1024;
const BUDGET_MS = 50_000;
const ATTEMPT_MS = 30_000;
const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite", "gemini-2.5-pro"];

const transcribeSchema = {
  type: Type.OBJECT,
  properties: {
    hasSpeech: { type: Type.BOOLEAN },
    turns: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING, enum: ["caller", "victim"] },
          start: { type: Type.NUMBER },
          text: { type: Type.STRING },
        },
        required: ["speaker", "start", "text"],
      },
    },
  },
  required: ["hasSpeech", "turns"],
};

const SYSTEM = `You are a forensic transcriptionist for phone-call evidence.
Transcribe the ENTIRE recording: every utterance from every speaker, including one-word replies (yes, okay, hello), interruptions, IVR/robocall voices and hold messages. Never skip, summarize or paraphrase.
Diarize by DISTINCT VOICES and turn-taking, not by content: start a new turn whenever the speaker changes.
Label "caller" = the party who placed the call and makes claims, instructions or requests. Label "victim" = the person receiving the call. A person who simply answers ("Hello?") is the victim. If only one voice exists (robocall/voicemail) every turn is "caller".
"start" = seconds from the beginning when the turn begins. Split monologues longer than ~3 sentences into consecutive turns by the same speaker. Do not analyze scam content here.
If there is no intelligible speech set hasSpeech=false and turns=[].
Return ONLY JSON: {"hasSpeech":true,"turns":[{"speaker":"caller","start":0,"text":""}]}`;
const PROMPT = "Transcribe and diarize this recording. Return only the JSON object.";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const redact = (s: string) => s.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]").replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class Timeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Timeout(`${label} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

type Kind = "auth" | "model" | "quota" | "transient" | "timeout" | "schema" | "media" | "parse" | "nospeech" | "unknown";
class Fail extends Error {
  constructor(public kind: Kind, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function toFail(err: unknown): Fail {
  if (err instanceof Fail) return err;
  if (err instanceof Timeout) return new Fail("timeout", err.message);
  const e = err as { status?: unknown; message?: unknown } | null;
  const message = redact(typeof e?.message === "string" ? e.message : String(err)).replace(/\s+/g, " ").slice(0, 300);
  const status = typeof e?.status === "number" ? e.status : undefined;
  const t = message.toLowerCase();
  let kind: Kind = "unknown";
  if (status === 401 || /leaked|api key not valid|api_key_invalid|invalid api key|api key expired/.test(t)) kind = "auth";
  else if (status === 429 || /resource_exhausted|quota|rate.?limit/.test(t)) kind = "quota";
  else if (status === 404 || /not found|no longer available|unknown model|does not exist/.test(t)) kind = "model";
  else if (status === 403) kind = /api key|billing|blocked|disabled|denied/.test(t) ? "auth" : "model";
  else if ((status !== undefined && status >= 500) || /overloaded|unavailable|deadline|econnreset|fetch failed|network/.test(t)) kind = "transient";
  else if (status === 400 || status === 415 || status === 422) kind = /schema|response_?mime/.test(t) ? "schema" : "media";
  return new Fail(kind, message);
}

/* ── media sniffing ── */
type Container = "wav" | "mp3" | "aac" | "ogg" | "flac" | "aiff" | "m4a" | "mp4" | "webm";
function sniff(b: Buffer): Container | null {
  if (b.length < 12) return null;
  const s = (o: number, n: number) => b.toString("latin1", o, o + n);
  const at = (i: number) => b[i] ?? 0;
  if (s(0, 4) === "RIFF" && s(8, 4) === "WAVE") return "wav";
  if (s(0, 3) === "ID3") return "mp3";
  if (s(4, 4) === "ftyp") return /^M4[AB] /.test(s(8, 4)) ? "m4a" : "mp4";
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "webm";
  if (s(0, 4) === "OggS") return "ogg";
  if (s(0, 4) === "fLaC") return "flac";
  if (s(0, 4) === "FORM" && s(8, 4) === "AIFF") return "aiff";
  if (at(0) === 0xff && (at(1) & 0xe0) === 0xe0) return (at(1) & 0xf6) === 0xf0 ? "aac" : "mp3";
  return null;
}
const EXT: Record<string, Container> = { wav: "wav", mp3: "mp3", aac: "aac", ogg: "ogg", flac: "flac", aiff: "aiff", m4a: "m4a", mp4: "mp4", webm: "webm" };

function mimeVariants(buffer: Buffer, declared: string, fileName: string): string[] {
  const c = sniff(buffer) ?? EXT[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? null;
  const vid = declared.startsWith("video/");
  switch (c) {
    case "wav": return ["audio/wav", "audio/x-wav"];
    case "mp3": return ["audio/mp3", "audio/mpeg"];
    case "aac": return ["audio/aac"];
    case "ogg": return ["audio/ogg"];
    case "flac": return ["audio/flac"];
    case "aiff": return ["audio/aiff"];
    case "m4a": return ["audio/mp4", "video/mp4", "audio/aac"];
    case "mp4": return vid || !declared ? ["video/mp4", "audio/mp4"] : ["audio/mp4", "video/mp4"];
    case "webm": return vid ? ["video/webm", "audio/webm"] : ["audio/webm", "video/webm"];
    default: return /^(audio|video)\//.test(declared) ? [declared] : [];
  }
}

/* ── JSON recovery ── */
function salvageTurns(t: string): unknown {
  const at = t.indexOf('"turns"');
  const open = at < 0 ? -1 : t.indexOf("[", at);
  if (open < 0) return null;
  const turns: unknown[] = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = open + 1; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) { try { turns.push(JSON.parse(t.slice(start, i + 1))); } catch { /* skip */ } start = -1; }
    }
  }
  return { hasSpeech: turns.length > 0, turns };
}
function parseLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { /* next */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* next */ } }
  return salvageTurns(t);
}
function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v * 10) / 10;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d+):(\d{1,2})(?:\.\d+)?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}
function toTurns(parsed: unknown): Turn[] {
  const r = isRec(parsed) ? parsed : {};
  if (r.hasSpeech === false) throw new Fail("nospeech", "no speech");
  const arr = Array.isArray(r.turns) ? r.turns : Array.isArray(parsed) ? parsed : [];
  const turns: Turn[] = [];
  for (const t of arr) {
    if (!isRec(t)) continue;
    const text = str(t.text).trim();
    if (!text) continue;
    const sp = normalizeSpeaker(t.speaker);
    turns.push({ speaker: sp === "unknown" ? undefined : sp, text, start: toSeconds(t.start ?? t.timestamp) });
  }
  if (turns.length === 0) throw new Fail("parse", "The model returned no transcript turns.");
  if (turns.length === 1 && /no intelligible speech/i.test(turns[0]?.text ?? "")) throw new Fail("nospeech", "no speech");
  return turns.slice(0, 200);
}

/* ── model discovery ── */
function configuredModels(): string[] {
  const env = (process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL ?? "").split(",").map((s) => s.trim().replace(/^models\//, "")).filter(Boolean);
  return Array.from(new Set([...env, ...DEFAULT_MODELS]));
}
async function discoverModels(ai: GoogleGenAI, exclude: string[]): Promise<string[]> {
  try {
    const pager = await withTimeout(ai.models.list({ config: { pageSize: 100 } }), 8000, "model list");
    const names: string[] = [];
    pager.page.forEach((m) => {
      const n = (m.name ?? "").replace(/^models\//, "");
      const actions = (m as { supportedActions?: string[] }).supportedActions;
      if (actions && !actions.includes("generateContent")) return;
      if (!/^gemini-/.test(n) || /(embedding|imagen|image|tts|live|native-audio|robotics|computer-use|aqa|veo|learnlm|gemma|exp)/.test(n)) return;
      names.push(n);
    });
    return names.filter((n) => !exclude.includes(n)).slice(0, 4);
  } catch {
    return [];
  }
}

/* ── stage 1: resilient transcription ── */
type Via = "inline" | "files";
type Plan = { model: string; mime: string; via: Via; schema: boolean };

async function transcribe(buffer: Buffer, declared: string, fileName: string): Promise<{ turns: Turn[]; model: string; mime: string }> {
  const deadline = Date.now() + BUDGET_MS;
  let apiKey: string;
  try { apiKey = getGeminiApiKey(); } catch {
    throw new HttpError(500, "auth", "Server is missing a valid GEMINI_API_KEY. Add it to .env.local and restart.");
  }
  const ai = new GoogleGenAI({ apiKey });
  const mimes = mimeVariants(buffer, declared, fileName);
  const primary = mimes[0];
  if (!primary) throw new HttpError(415, "media_unsupported", "Unsupported media type. Use .mp4, .mp3, .wav, .m4a or .webm.");
  const canInline = buffer.length <= INLINE_LIMIT;
  const models = configuredModels();

  const errors: string[] = [];
  const dead = new Set<string>();
  const cool = new Set<string>();
  const mediaFails = new Map<string, number>();
  const uploads = new Map<string, { name: string; uri: string }>();
  const toDelete: string[] = [];
  let b64: string | undefined;
  let noSpeech = 0;
  const remaining = () => deadline - Date.now();

  async function ensureUpload(mime: string) {
    const cached = uploads.get(mime);
    if (cached) return cached;
    const up = await withTimeout(
      ai.files.upload({ file: new Blob([new Uint8Array(buffer)], { type: mime }), config: { mimeType: mime, displayName: fileName.slice(0, 100) } }),
      Math.max(5000, Math.min(35_000, remaining() - 2000)),
      "upload"
    );
    if (!up.name) throw new Fail("media", "Gemini upload returned no file name.");
    toDelete.push(up.name);
    let cur = up;
    const limit = Date.now() + Math.min(25_000, Math.max(0, remaining() - 4000));
    while (cur.state === FileState.PROCESSING && Date.now() < limit) {
      await sleep(1200);
      cur = await ai.files.get({ name: up.name });
    }
    if (cur.state !== FileState.ACTIVE || !cur.uri) throw new Fail("media", `Gemini could not process this file as ${mime}.`);
    const ref = { name: up.name, uri: cur.uri };
    uploads.set(mime, ref);
    return ref;
  }

  async function attempt(plan: Plan): Promise<{ turns: Turn[]; model: string; mime: string } | Fail> {
    try {
      const budget = Math.min(ATTEMPT_MS, remaining() - 1500);
      if (budget < 4000) throw new Fail("timeout", "Ran out of time budget.");
      let part;
      if (plan.via === "inline") {
        b64 ??= buffer.toString("base64");
        part = { inlineData: { data: b64, mimeType: plan.mime } };
      } else {
        const ref = await ensureUpload(plan.mime);
        part = { fileData: { fileUri: ref.uri, mimeType: plan.mime } };
      }
      const res = await withTimeout(
        ai.models.generateContent({
          model: plan.model,
          contents: [{ role: "user", parts: [part, { text: PROMPT }] }],
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: "application/json",
            temperature: 0,
            maxOutputTokens: 16384,
            ...(plan.schema ? { responseSchema: transcribeSchema } : {}),
          },
        }),
        budget,
        plan.model
      );
      const text = res.text ?? "";
      if (!text.trim()) throw new Fail("parse", `Empty response (${String(res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? "empty")}).`);
      return { turns: toTurns(parseLoose(text)), model: plan.model, mime: plan.mime };
    } catch (err) {
      const f = toFail(err);
      errors.push(`${plan.model}/${plan.via}/${plan.mime}: ${f.kind} ${f.message}`.slice(0, 220));
      if (f.kind === "nospeech") {
        noSpeech++;
        if (noSpeech >= 2) throw new HttpError(422, "no_speech", "No intelligible speech was detected in this recording.");
      }
      return f;
    }
  }

  async function runPlans(plans: Plan[]) {
    for (const plan of plans) {
      if (remaining() < 6000) return null;
      if (dead.has(plan.model) || cool.has(plan.model) || (mediaFails.get(plan.mime) ?? 0) >= 2) continue;
      let out = await attempt(plan);
      if (out instanceof Fail && out.kind === "schema" && plan.schema) out = await attempt({ ...plan, schema: false });
      if (out instanceof Fail && out.kind === "transient" && remaining() > 12_000) { await sleep(1200); out = await attempt(plan); }
      if (!(out instanceof Fail)) return out;
      if (out.kind === "auth") throw new HttpError(500, "auth", `The AI service rejected the API key: ${out.message}`);
      if (out.kind === "model") dead.add(plan.model);
      else if (out.kind === "quota") cool.add(plan.model);
      else if (out.kind === "media") mediaFails.set(plan.mime, (mediaFails.get(plan.mime) ?? 0) + 1);
    }
    return null;
  }

  function buildPlans(list: string[]): Plan[] {
    const plans: Plan[] = [];
    const push = (p: Plan) => { if (!plans.some((q) => q.model === p.model && q.mime === p.mime && q.via === p.via && q.schema === p.schema)) plans.push(p); };
    const top = list.slice(0, 3);
    if (canInline) list.forEach((m) => push({ model: m, mime: primary!, via: "inline", schema: true }));
    top.forEach((m) => push({ model: m, mime: primary!, via: "files", schema: true }));
    if (canInline) top.forEach((m) => push({ model: m, mime: primary!, via: "inline", schema: false }));
    mimes.slice(1).forEach((alt) => top.forEach((m) => push({ model: m, mime: alt, via: canInline ? "inline" : "files", schema: true })));
    return plans;
  }

  try {
    let win = await runPlans(buildPlans(models));
    if (!win && remaining() > 15_000) {
      const found = await discoverModels(ai, models);
      if (found.length) win = await runPlans(found.map((m): Plan => ({ model: m, mime: primary, via: canInline ? "inline" : "files", schema: true })));
    }
    if (!win && remaining() > 18_000 && errors.some((e) => /quota|transient|timeout/.test(e))) {
      await sleep(Math.min(4000, remaining() - 14_000));
      cool.clear();
      mediaFails.clear();
      win = await runPlans(models.filter((m) => !dead.has(m)).slice(0, 2).map((m): Plan => ({ model: m, mime: primary, via: canInline ? "inline" : "files", schema: false })));
    }
    if (win) return win;
    if (noSpeech > 0) throw new HttpError(422, "no_speech", "No intelligible speech was detected in this recording.");
    const last = errors[errors.length - 1] ?? "";
    if (errors.length > 0 && errors.every((e) => /quota/.test(e))) throw new HttpError(429, "rate_limited", "Every Gemini model is rate-limited right now. Wait a minute and retry.");
    throw new HttpError(502, "upstream", `Transcription failed after ${errors.length} attempts. Last: ${last}`.slice(0, 500));
  } finally {
    await Promise.all(toDelete.map((name) => ai.files.delete({ name }).catch(() => undefined)));
  }
}

/* ── POST ── */
export async function POST(request: Request) {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return NextResponse.json({ error: { message: "Unsupported request type.", code: "bad_request" } }, { status: 415 });
  }
  let file: File | null = null;
  try {
    const c = (await request.formData()).get("file");
    if (c instanceof File) file = c;
  } catch {
    return NextResponse.json({ error: { message: "Invalid media payload.", code: "bad_request" } }, { status: 400 });
  }
  if (!file || file.size === 0) return NextResponse.json({ error: { message: "No media file provided.", code: "bad_request" } }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: { message: "Media files must be 20 MB or smaller.", code: "too_large" } }, { status: 413 });

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { turns, model, mime } = await transcribe(buffer, file.type, file.name);

    let analysis;
    let fallbackReason: string | undefined;
    try {
      analysis = await analyzeTurns(turns, { authoritative: turns.every((t) => t.speaker), budgetMs: 28_000 });
    } catch (err) {
      console.warn("[VEXA_MEDIA_STAGE2_FALLBACK]", err instanceof Error ? redact(err.message).slice(0, 200) : "error");
      analysis = heuristicTurns(turns);
      fallbackReason = classifyGeminiError(err);
    }
    return NextResponse.json(
      { ...analysis, inputMode: "media", mediaType: mime, fileName: file.name, model, ...(fallbackReason ? { fallbackReason } : {}) },
      { headers: { "X-Vexa-Model": model } }
    );
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: { message: err.message, code: err.code } }, { status: err.status });
    const f = toFail(err);
    console.warn("[VEXA_MEDIA_ERROR]", f.message);
    return NextResponse.json({ error: { message: `Live analysis hit an unexpected error: ${f.message}`, code: "upstream" } }, { status: 502 });
  }
}