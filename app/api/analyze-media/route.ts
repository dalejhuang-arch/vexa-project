// app/api/analyze-media/route.ts
//
// Resilient audio/video analysis endpoint.
//
// Strategy: instead of one model + one upload path, every request walks an ordered
// list of "plans" (model × MIME type × transport × schema-mode) until one produces a
// usable report. It switches models on 404/quota/overload, switches MIME labels when
// Gemini rejects a container, switches between inline and Files-API upload, drops the
// response schema if a model chokes on it, salvages truncated JSON, and discovers
// currently-available models from the API if every hard-coded name is gone.
//
// Debugging: in development open  /api/analyze-media?diag=1  to see which models
// your key can actually call (text + audio). Set VEXA_DIAG=true to allow it in prod.

import { NextResponse } from "next/server";
import { GoogleGenAI, FileState, Type } from "@google/genai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getGeminiApiKey } from "@/lib/env";
import { examples } from "@/data/examples";

export const runtime = "nodejs";
export const maxDuration = 90;
export const dynamic = "force-dynamic";

/* ───────────────────────── constants ───────────────────────── */

const MAX_BYTES = 20 * 1024 * 1024;
const INLINE_LIMIT = 14 * 1024 * 1024; // base64 inflates ~33%; Gemini request cap is 20 MB
const MIN_REAL_VIDEO_BYTES = 50_000;
const BUDGET_MS = 80_000; // total wall-clock for one request (route maxDuration is 90 s)
const ATTEMPT_MS = 45_000; // cap for a single generateContent call

// Env override: GEMINI_MODELS="gemini-2.5-flash,gemini-flash-latest"
const DEFAULT_MODELS = [
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];

const DEMO_FILES: Record<string, string> = {
  grandparent: "grandparent.mp4",
  tech: "tech-support.mp4",
  irs: "government.mp4",
};

const CATEGORIES = [
  "Government Imposter Scam",
  "Grandparent/Family Emergency Scam",
  "Tech Support Scam",
  "Romance Scam",
  "Prize/Lottery Scam",
  "Investment/Crypto Scam",
  "Bank/Financial Institution Imposter Scam",
  "Other/Unclear",
] as const;

const TACTICS = [
  "urgency",
  "authority_impersonation",
  "isolation",
  "threat",
  "too_good_to_be_true",
  "payment_request",
  "personal_info_request",
] as const;
type TacticId = (typeof TACTICS)[number];
type Tactic = TacticId | "none";

const EXPLAIN: Record<TacticId, string> = {
  urgency: "Creates artificial time pressure so you skip verification.",
  authority_impersonation: "Claims an official role to borrow credibility it hasn't earned.",
  isolation: "Tries to keep you away from anyone who could challenge the story.",
  threat: "Uses fear of consequences to override your judgment.",
  too_good_to_be_true: "Offers an unrealistic reward to lower your guard.",
  payment_request: "Requests money through channels that are hard to trace or reverse.",
  personal_info_request: "Tries to collect identity details, codes or device access.",
};

const COUNTER: Record<TacticId, string> = {
  urgency: "I don't decide under pressure. I'll verify this myself and call you back.",
  authority_impersonation: "Give me your name and a case number. I'll hang up and call the official number myself.",
  isolation: "I talk big decisions over with family. If this is legitimate, that won't be a problem.",
  threat: "Real agencies don't threaten arrest by phone. I'm ending this call and checking directly.",
  too_good_to_be_true: "I didn't enter anything, and legitimate offers never need upfront fees. No thank you.",
  payment_request: "I won't pay by gift card, crypto or wire. Send an official invoice by mail.",
  personal_info_request: "I never share personal details on an inbound call. I'll contact you through official channels.",
};

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    riskScore: { type: Type.INTEGER },
    category: { type: Type.STRING, enum: [...CATEGORIES] },
    summary: { type: Type.STRING },
    tacticCounts: {
      type: Type.OBJECT,
      properties: Object.fromEntries(TACTICS.map((t) => [t, { type: Type.INTEGER }])),
    },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          timestamp: { type: Type.NUMBER },
          tactic: { type: Type.STRING, enum: [...TACTICS, "none"] },
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
2. Segment the dialogue and detect the ONE primary manipulation tactic in each segment (${TACTICS.join(", ")}, or none).
3. Set timestamp to the approximate start time in seconds for each segment when you can determine it.
4. Do not infer emotion or deception from voice tone or cadence.
5. Give specific, actionable counter-advice for every flagged tactic.
6. riskScore is 0-100 reflecting how strongly the conversation matches a scam. tacticCounts must equal the number of segments flagged per tactic.
7. category must be exactly one of: ${CATEGORIES.map((c) => `"${c}"`).join(", ")}.
If there is no intelligible speech, return a single segment with text "[no intelligible speech]", tactic "none", and riskScore 0.
Respond with ONLY a JSON object (no markdown fences) shaped like:
{"riskScore":0,"category":"Other/Unclear","summary":"","tacticCounts":{"urgency":0,"authority_impersonation":0,"isolation":0,"threat":0,"too_good_to_be_true":0,"payment_request":0,"personal_info_request":0},"segments":[{"text":"","timestamp":0,"tactic":"none","explanation":"","counterAdvice":""}]}`;

const PROMPT = "Transcribe and analyze this phone call recording. Return only the JSON object described in the instructions.";

/* ───────────────────────── small helpers ───────────────────────── */

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Never let a credential reach a response body or log line. */
function redact(s: string): string {
  return s
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/AQ\.[0-9A-Za-z_-]{20,}/g, "[redacted-key]")
    .replace(/([?&]key=)[^&\s"']+/gi, "$1[redacted]");
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

class HttpError extends Error {
  attempts?: AttemptLog[];
  constructor(
    public status: number,
    public code: string,
    message: string,
    attempts?: AttemptLog[]
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.attempts = attempts;
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Kind = "auth" | "leaked" | "model" | "quota" | "transient" | "timeout" | "schema" | "media" | "parse" | "unknown";

class Fail extends Error {
  constructor(
    public kind: Kind,
    message: string,
    public status?: number
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      }
    );
  });
}

/** Pull a human-readable message + HTTP status out of whatever the SDK threw. */
function describe(err: unknown): { status?: number; message: string } {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null;
  let message = typeof e?.message === "string" ? e.message : String(err);
  let status = typeof e?.status === "number" ? e.status : typeof e?.code === "number" ? e.code : undefined;
  const brace = message.indexOf("{");
  if (brace >= 0) {
    try {
      const j: unknown = JSON.parse(message.slice(brace));
      if (isRecord(j) && isRecord(j.error)) {
        const inner = str(j.error.message);
        const st = str(j.error.status);
        if (inner) message = st ? `${inner} (${st})` : inner;
        if (status === undefined && typeof j.error.code === "number") status = j.error.code;
      }
    } catch {
      /* message wasn't JSON */
    }
  }
  return { status, message: redact(message).replace(/\s+/g, " ").slice(0, 300) };
}

function toFail(err: unknown): Fail {
  if (err instanceof Fail) return err;
  if (err instanceof TimeoutError) return new Fail("timeout", err.message);
  const { status, message } = describe(err);
  const t = message.toLowerCase();
  let kind: Kind = "unknown";
  if (/leaked/.test(t)) kind = "leaked";
  else if (
    status === 401 ||
    /api key not valid|api_key_invalid|invalid api key|api key expired|api key not found|pass a valid api key/.test(t)
  )
    kind = "auth";
  else if (status === 429 || /resource_exhausted|quota|rate.?limit|too many requests/.test(t)) kind = "quota";
  else if (
    status === 404 ||
    /is not found|not found for api version|not supported for generatecontent|no longer available|shut ?down|retired|decommission|unknown model|does not exist/.test(
      t
    )
  )
    kind = "model";
  else if (status === 403)
    kind = /api key|billing|blocked|disabled|suspended|has not been used|denied access/.test(t) ? "auth" : "model";
  else if (
    (status !== undefined && status >= 500) ||
    /overloaded|unavailable|deadline exceeded|econnreset|etimedout|fetch failed|socket hang up|network|internal error/.test(t)
  )
    kind = "transient";
  else if (status === 400 || status === 415 || status === 422 || /invalid argument/.test(t)) {
    if (/schema|response_?mime|responsemime|application\/json/.test(t)) kind = "schema";
    else kind = "media";
  }
  return new Fail(kind, message, status);
}

/* ───────────────────────── media sniffing ───────────────────────── */

type Container = "wav" | "mp3" | "aac" | "ogg" | "flac" | "aiff" | "m4a" | "mp4" | "webm";

function sniff(b: Buffer): Container | null {
  const s = (o: number, n: number) => b.toString("latin1", o, o + n);
  const at = (i: number) => b[i] ?? 0;
  if (b.length < 12) return null;
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

const EXT_TO_CONTAINER: Record<string, Container> = {
  wav: "wav",
  mp3: "mp3",
  aac: "aac",
  ogg: "ogg",
  flac: "flac",
  aiff: "aiff",
  m4a: "m4a",
  mp4: "mp4",
  webm: "webm",
};

/** Ordered list of MIME labels worth trying for this media (Gemini is picky about containers). */
function mimeVariants(buffer: Buffer, declared: string, fileName: string): string[] {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const container = sniff(buffer) ?? EXT_TO_CONTAINER[ext] ?? null;
  const isVideoDecl = declared.startsWith("video/");
  let list: string[] = [];
  switch (container) {
    case "wav":
      list = ["audio/wav", "audio/x-wav"];
      break;
    case "mp3":
      list = ["audio/mp3", "audio/mpeg"];
      break;
    case "aac":
      list = ["audio/aac"];
      break;
    case "ogg":
      list = ["audio/ogg"];
      break;
    case "flac":
      list = ["audio/flac"];
      break;
    case "aiff":
      list = ["audio/aiff"];
      break;
    case "m4a":
      list = ["audio/mp4", "video/mp4", "audio/aac"];
      break;
    case "mp4":
      list = isVideoDecl || !declared ? ["video/mp4", "audio/mp4"] : ["audio/mp4", "video/mp4"];
      break;
    case "webm":
      list = isVideoDecl ? ["video/webm", "audio/webm"] : ["audio/webm", "video/webm"];
      break;
    default:
      if (/^(audio|video)\//.test(declared)) list = [declared];
  }
  return list;
}

/* ───────────────────────── JSON recovery + normalization ───────────────────────── */

function salvageSegments(t: string): unknown {
  const at = t.indexOf('"segments"');
  if (at < 0) return null;
  const open = t.indexOf("[", at);
  if (open < 0) return null;
  const segments: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = open + 1; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          segments.push(JSON.parse(t.slice(start, i + 1)));
        } catch {
          /* skip a malformed segment */
        }
        start = -1;
      }
    }
  }
  const risk = t.match(/"riskScore"\s*:\s*(\d+)/);
  const cat = t.match(/"category"\s*:\s*"([^"]*)"/);
  const sum = t.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return {
    segments,
    riskScore: risk ? Number(risk[1]) : undefined,
    category: cat ? cat[1] : undefined,
    summary: sum ? sum[1] : undefined,
  };
}

function parseLoose(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    /* try harder */
  }
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      /* try salvage */
    }
  }
  return salvageSegments(t);
}

const TACTIC_ALIASES: Record<string, TacticId> = {
  authority: "authority_impersonation",
  impersonation: "authority_impersonation",
  false_authority: "authority_impersonation",
  payment: "payment_request",
  personal_info: "personal_info_request",
  info_request: "personal_info_request",
  too_good: "too_good_to_be_true",
  threats: "threat",
  secrecy: "isolation",
};

function toTactic(v: unknown): Tactic {
  const k = str(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((TACTICS as readonly string[]).includes(k)) return k as TacticId;
  return TACTIC_ALIASES[k] ?? "none";
}

function toCategory(v: unknown): string {
  const s = str(v).trim().toLowerCase();
  const exact = CATEGORIES.find((c) => c.toLowerCase() === s);
  if (exact) return exact;
  const hints: Array<[RegExp, string]> = [
    [/grandparent|family|emergency/, "Grandparent/Family Emergency Scam"],
    [/tech/, "Tech Support Scam"],
    [/government|irs|tax|revenue/, "Government Imposter Scam"],
    [/romance/, "Romance Scam"],
    [/prize|lottery/, "Prize/Lottery Scam"],
    [/invest|crypto/, "Investment/Crypto Scam"],
    [/bank|financial/, "Bank/Financial Institution Imposter Scam"],
  ];
  const hit = hints.find(([re]) => re.test(s));
  return hit ? hit[1] : "Other/Unclear";
}

type OutSegment = { text: string; tactic: Tactic; explanation: string; counterAdvice: string; timestamp?: number };

function normalizeAnalysis(parsed: unknown, mime: string) {
  const r = isRecord(parsed) ? parsed : {};
  const segments: OutSegment[] = [];
  (Array.isArray(r.segments) ? r.segments : []).forEach((item) => {
    if (!isRecord(item)) return;
    const text = str(item.text).trim();
    if (!text) return;
    const tactic = toTactic(item.tactic);
    const seg: OutSegment = { text, tactic, explanation: str(item.explanation), counterAdvice: str(item.counterAdvice) };
    const ts = toSeconds(item.timestamp ?? item.start ?? item.time);
    if (ts !== undefined) seg.timestamp = ts;
    if (tactic !== "none") {
      if (!seg.explanation) seg.explanation = EXPLAIN[tactic];
      if (!seg.counterAdvice) seg.counterAdvice = COUNTER[tactic];
    } else {
      seg.counterAdvice = "";
    }
    segments.push(seg);
  });

  if (segments.length === 0 && typeof r.transcript === "string") {
    r.transcript
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((text) => segments.push({ text, tactic: "none", explanation: "", counterAdvice: "" }));
  }
  if (segments.length === 0) throw new Fail("parse", "The model returned no transcript segments.");
  const only = segments[0];
  if (segments.length === 1 && only && /no intelligible speech/i.test(only.text)) {
    throw new HttpError(422, "no_speech", "No intelligible speech was detected in this recording.");
  }

  const counts = Object.fromEntries(TACTICS.map((t) => [t, segments.filter((s) => s.tactic === t).length])) as Record<
    TacticId,
    number
  >;
  const flagged = segments.filter((s) => s.tactic !== "none").length;
  const distinct = TACTICS.filter((t) => counts[t] > 0).length;

  const modelRisk = typeof r.riskScore === "number" && Number.isFinite(r.riskScore) ? r.riskScore : undefined;
  const riskScore = Math.round(
    clamp(
      modelRisk ?? (flagged === 0 ? 5 : 10 + distinct * 12 + (flagged / segments.length) * 30),
      0,
      100
    )
  );
  const category = toCategory(r.category);
  const summary =
    str(r.summary).trim() ||
    (flagged === 0
      ? "No clear manipulation tactics were detected in this call."
      : `This call resembles a ${category.toLowerCase()} and uses ${distinct} manipulation tactic${distinct === 1 ? "" : "s"}.`);

  return {
    riskScore,
    category,
    summary,
    tacticCounts: counts,
    segments,
    inputMode: "media" as const,
    mediaType: mime,
  };
}

/* ───────────────────────── model discovery ───────────────────────── */

function configuredModels(): string[] {
  const fromEnv = (process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^models\//, ""))
    .filter(Boolean);
  const out: string[] = [];
  fromEnv.concat(DEFAULT_MODELS).forEach((m) => {
    if (!out.includes(m)) out.push(m);
  });
  return out;
}

let discovery: { at: number; models: string[] } | null = null;

async function discoverModels(ai: GoogleGenAI, exclude: string[]): Promise<string[]> {
  try {
    if (!discovery || Date.now() - discovery.at > 10 * 60_000) {
      const pager = await withTimeout(ai.models.list({ config: { pageSize: 100 } }), 8000, "model list");
      const names: string[] = [];
      pager.page.forEach((m) => {
        const n = (m.name ?? "").replace(/^models\//, "");
        const actions = (m as { supportedActions?: string[] }).supportedActions;
        if (actions && !actions.includes("generateContent")) return;
        if (!/^gemini-/.test(n)) return;
        if (/(embedding|imagen|image|tts|live|native-audio|robotics|computer-use|aqa|veo|learnlm|gemma|exp)/.test(n)) return;
        names.push(n);
      });
      const rank = (n: string) => (/flash/.test(n) && !/lite/.test(n) ? 0 : /flash/.test(n) ? 1 : 2);
      names.sort((a, b) => rank(a) - rank(b) || (a < b ? 1 : -1));
      discovery = { at: Date.now(), models: names };
    }
    return discovery.models.filter((n) => !exclude.includes(n)).slice(0, 4);
  } catch {
    return [];
  }
}

/* ───────────────────────── the resilient analyzer ───────────────────────── */

type Via = "inline" | "files";
type Plan = { model: string; mime: string; via: Via; schema: boolean };
type AttemptLog = { model: string; via: Via; mime: string; schema: boolean; kind: Kind | "ok"; status?: number; note: string };

async function runAnalysis(buffer: Buffer, declaredType: string, fileName: string) {
  const deadline = Date.now() + BUDGET_MS;

  let apiKey: string;
  try {
    apiKey = getGeminiApiKey();
  } catch {
    throw new HttpError(500, "auth", "Server is missing a valid GEMINI_API_KEY. Add it to .env.local and restart the dev server.");
  }
  const ai = new GoogleGenAI({ apiKey });

  const mimes = mimeVariants(buffer, declaredType, fileName);
  const primary = mimes[0];
  if (!primary) {
    throw new HttpError(415, "media_unsupported", "Unsupported media type. Use .mp4, .mp3, .wav, .m4a or .webm.");
  }
  const canInline = buffer.length <= INLINE_LIMIT;
  const models = configuredModels();

  const attempts: AttemptLog[] = [];
  const deadModels = new Set<string>();
  const coolModels = new Set<string>();
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
      ai.files.upload({
        file: new Blob([new Uint8Array(buffer)], { type: mime }),
        config: { mimeType: mime, displayName: fileName.slice(0, 100) },
      }),
      Math.min(40_000, remaining() - 2000),
      "upload"
    );
    if (!up.name) throw new Fail("media", "Gemini upload returned no file name.");
    toDelete.push(up.name);
    let cur = up;
    const limit = Date.now() + Math.min(30_000, remaining() - 4000);
    while (cur.state === FileState.PROCESSING && Date.now() < limit) {
      await sleep(1200);
      cur = await ai.files.get({ name: up.name });
    }
    if (cur.state !== FileState.ACTIVE || !cur.uri) {
      throw new Fail("media", `Gemini could not process this file as ${mime} (state ${cur.state ?? "unknown"}).`);
    }
    const ref = { name: up.name, uri: cur.uri };
    uploads.set(mime, ref);
    return ref;
  }

  async function generate(plan: Plan): Promise<string> {
    const budget = Math.min(ATTEMPT_MS, remaining() - 1500);
    if (budget < 4000) throw new Fail("timeout", "Ran out of time budget.");
    let mediaPart;
    if (plan.via === "inline") {
      b64 ??= buffer.toString("base64");
      mediaPart = { inlineData: { data: b64, mimeType: plan.mime } };
    } else {
      const ref = await ensureUpload(plan.mime);
      mediaPart = { fileData: { fileUri: ref.uri, mimeType: plan.mime } };
    }
    const res = await withTimeout(
      ai.models.generateContent({
        model: plan.model,
        contents: [{ role: "user", parts: [mediaPart, { text: PROMPT }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 16384,
          ...(plan.schema ? { responseSchema } : {}),
        },
      }),
      budget,
      plan.model
    );
    const text = res.text ?? "";
    if (!text.trim()) {
      const reason = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? "empty";
      throw new Fail("parse", `The model returned an empty response (${String(reason)}).`);
    }
    return text;
  }

  function log(plan: Plan, kind: Kind | "ok", note: string, status?: number) {
    attempts.push({ model: plan.model, via: plan.via, mime: plan.mime, schema: plan.schema, kind, status, note: note.slice(0, 200) });
  }

  type Success = { report: ReturnType<typeof normalizeAnalysis>; model: string };

  async function tryOnce(plan: Plan): Promise<Success | Fail> {
    try {
      const text = await generate(plan);
      const report = normalizeAnalysis(parseLoose(text), plan.mime);
      log(plan, "ok", "ok");
      return { report, model: plan.model };
    } catch (err) {
      if (err instanceof HttpError && err.code === "no_speech") {
        noSpeech++;
        log(plan, "parse", "model heard no speech");
        if (noSpeech >= 2) throw err;
        return new Fail("parse", "no speech");
      }
      const fail = toFail(err);
      log(plan, fail.kind, fail.message, fail.status);
      return fail;
    }
  }

  function fatal(fail: Fail): HttpError | null {
    if (fail.kind === "leaked") {
      return new HttpError(
        500,
        "auth",
        "Google disabled this API key because it was exposed publicly. Create a new key at aistudio.google.com/apikey, put it in .env.local and restart."
      );
    }
    if (fail.kind === "auth") {
      return new HttpError(500, "auth", `The AI service rejected the API key: ${fail.message}`);
    }
    return null;
  }

  async function runPlans(plans: Plan[]): Promise<Success | null> {
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      if (!plan) continue;
      if (remaining() < 6000) return null;
      if (deadModels.has(plan.model) || coolModels.has(plan.model)) continue;
      if ((mediaFails.get(plan.mime) ?? 0) >= 2) continue;

      let out = await tryOnce(plan);
      if (out instanceof Fail && out.kind === "schema" && plan.schema) out = await tryOnce({ ...plan, schema: false });
      if (out instanceof Fail && out.kind === "transient" && remaining() > 12_000) {
        await sleep(1200);
        out = await tryOnce(plan);
      }
      if (!(out instanceof Fail)) return out;

      const stop = fatal(out);
      if (stop) throw stop;
      if (out.kind === "model") deadModels.add(plan.model);
      else if (out.kind === "quota") coolModels.add(plan.model);
      else if (out.kind === "media") mediaFails.set(plan.mime, (mediaFails.get(plan.mime) ?? 0) + 1);
    }
    return null;
  }

  function buildPlans(modelList: string[]): Plan[] {
    const plans: Plan[] = [];
    const push = (p: Plan) => {
      if (!plans.some((q) => q.model === p.model && q.mime === p.mime && q.via === p.via && q.schema === p.schema)) plans.push(p);
    };
    const top = modelList.slice(0, 3);
    if (canInline) modelList.forEach((m) => push({ model: m, mime: primary!, via: "inline", schema: true }));
    top.forEach((m) => push({ model: m, mime: primary!, via: "files", schema: true }));
    if (canInline) top.forEach((m) => push({ model: m, mime: primary!, via: "inline", schema: false }));
    mimes.slice(1).forEach((alt) =>
      top.forEach((m) => push({ model: m, mime: alt, via: canInline ? "inline" : "files", schema: true }))
    );
    return plans;
  }

  try {
    // Pass 1: hard-coded / env-configured models
    let win = await runPlans(buildPlans(models));

    // Pass 2: ask the API which models exist right now (covers renamed/retired models)
    if (!win && remaining() > 15_000) {
      const found = await discoverModels(ai, models);
      if (found.length) {
        win = await runPlans(
          found.flatMap((m): Plan[] => [{ model: m, mime: primary, via: canInline ? "inline" : "files", schema: true }])
        );
      }
    }

    // Pass 3: rate limits and overloads are often momentary. Wait, then retry the best models.
    const transientSeen = attempts.some((a) => a.kind === "quota" || a.kind === "transient" || a.kind === "timeout");
    if (!win && transientSeen && remaining() > 20_000) {
      await sleep(Math.min(5000, remaining() - 15_000));
      coolModels.clear();
      mediaFails.clear();
      const live = models.filter((m) => !deadModels.has(m)).slice(0, 2);
      win = await runPlans(live.map((m): Plan => ({ model: m, mime: primary, via: canInline ? "inline" : "files", schema: false })));
    }

    if (win) return win;

    // Everything failed: explain precisely why.
    const failures = attempts.filter((a) => a.kind !== "ok");
    const last = failures[failures.length - 1];
    const detail = last ? ` Last error [${last.model} · ${last.via} · ${last.mime}]: ${last.note}` : "";
    if (failures.length > 0 && failures.every((a) => a.kind === "quota")) {
      throw new HttpError(429, "rate_limited", "Every Gemini model is rate-limited right now. Wait a minute and retry.", attempts.slice(-10));
    }
    if (failures.length > 0 && failures.every((a) => a.kind === "model")) {
      throw new HttpError(
        502,
        "upstream",
        `None of the configured Gemini models are available to this key.${detail} Set GEMINI_MODELS in .env.local, or open /api/analyze-media?diag=1 to see what your key can call.`,
        attempts.slice(-10)
      );
    }
    const media = failures.filter((a) => a.kind === "media").length;
    const code = media > failures.length / 2 ? "media_unsupported" : "upstream";
    throw new HttpError(
      502,
      code,
      `Live analysis failed after ${attempts.length} attempt${attempts.length === 1 ? "" : "s"}.${detail}`.slice(0, 500),
      attempts.slice(-10)
    );
  } finally {
    await Promise.all(
      toDelete.map((name) =>
        ai.files.delete({ name }).catch(() => undefined)
      )
    );
  }
}

/* ───────────────────────── responses ───────────────────────── */

function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { error: { message: err.message, code: err.code, attempts: err.attempts } },
      { status: err.status }
    );
  }
  const { message } = describe(err);
  console.warn("[VEXA_MEDIA_ERROR]", message);
  return NextResponse.json(
    { error: { message: `Live analysis hit an unexpected error: ${message}`, code: "upstream" } },
    { status: 502 }
  );
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

/* ───────────────────────── POST ───────────────────────── */

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  // ---------- Demo requests (JSON) ----------
  if (contentType.includes("application/json")) {
    let body: { demoId?: string; live?: boolean } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: { message: "Invalid request body.", code: "bad_request" } }, { status: 400 });
    }

    const demoId = body.demoId;
    const fileName = demoId ? DEMO_FILES[demoId] : undefined;
    if (!demoId || !fileName) {
      return NextResponse.json({ error: { message: "Unknown demo scenario.", code: "bad_request" } }, { status: 400 });
    }

    // Default: instant, verified report. Live analysis is opt-in.
    if (!body.live) return NextResponse.json(cachedDemo(demoId, fileName));

    const filePath = path.join(process.cwd(), "public", "demo", fileName);
    const data = await readFile(filePath).catch(() => null);
    if (!data || data.length < MIN_REAL_VIDEO_BYTES) {
      console.warn(`[VEXA] Demo ${fileName} missing or invalid; serving verified report.`);
      return NextResponse.json(cachedDemo(demoId, fileName));
    }

    try {
      const { report, model } = await runAnalysis(data, "video/mp4", fileName);
      return NextResponse.json({ ...report, fileName, model });
    } catch (err) {
      console.warn("[VEXA_DEMO_LIVE_FAILOVER]", err instanceof Error ? redact(err.message) : err);
      return NextResponse.json(cachedDemo(demoId, fileName));
    }
  }

  // ---------- Real uploads (multipart) ----------
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: { message: "Unsupported request type.", code: "bad_request" } }, { status: 415 });
  }

  let file: File | null = null;
  try {
    const formData = await request.formData();
    const candidate = formData.get("file");
    if (candidate instanceof File) file = candidate;
  } catch {
    return NextResponse.json({ error: { message: "Invalid media payload.", code: "bad_request" } }, { status: 400 });
  }

  if (!file || file.size === 0) {
    return NextResponse.json({ error: { message: "No media file provided.", code: "bad_request" } }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: { message: "Media files must be 20 MB or smaller.", code: "too_large" } },
      { status: 413 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { report, model } = await runAnalysis(buffer, file.type, file.name);
    return NextResponse.json({ ...report, fileName: file.name, model }, { headers: { "X-Vexa-Model": model } });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ───────────────────────── GET ?diag=1 (troubleshooting) ───────────────────────── */

function silentWav(seconds = 1, rate = 16000): Buffer {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(n * 2, 40);
  return b;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production" && process.env.VEXA_DIAG !== "true") {
    return NextResponse.json({ error: { message: "Not found." } }, { status: 404 });
  }
  const url = new URL(request.url);
  if (!url.searchParams.has("diag")) {
    return NextResponse.json({ ok: true, hint: "Add ?diag=1 to test your key and models." });
  }

  let apiKey: string;
  try {
    apiKey = getGeminiApiKey();
  } catch (e) {
    return NextResponse.json({ keyOk: false, problem: e instanceof Error ? redact(e.message) : "Missing GEMINI_API_KEY." });
  }
  const ai = new GoogleGenAI({ apiKey });
  const models = configuredModels();
  const discovered = await discoverModels(ai, []);
  const wav = silentWav().toString("base64");

  const probe = async (model: string) => {
    const t0 = Date.now();
    const run = async (parts: Array<Record<string, unknown>>) => {
      try {
        await withTimeout(
          ai.models.generateContent({ model, contents: [{ role: "user", parts }], config: { maxOutputTokens: 16 } }),
          20_000,
          model
        );
        return "ok";
      } catch (e) {
        const f = toFail(e);
        return `${f.kind}${f.status ? ` ${f.status}` : ""}: ${f.message}`;
      }
    };
    const text = await run([{ text: "Reply with the single word OK." }]);
    const audio = await run([{ inlineData: { data: wav, mimeType: "audio/wav" } }, { text: "Reply with the single word OK." }]);
    return { model, text, audio, ms: Date.now() - t0 };
  };

  const toTest = models.concat(discovered.filter((m) => !models.includes(m)).slice(0, 3));
  const results = await Promise.all(toTest.map(probe));
  return NextResponse.json({
    keyOk: true,
    node: process.version,
    configuredModels: models,
    discoveredModels: discovered,
    results,
    verdict: results.some((r) => r.audio === "ok")
      ? "At least one model can process audio. Analysis should work."
      : "No model accepted audio. See the errors above (auth, billing, region, or quota).",
  });
}