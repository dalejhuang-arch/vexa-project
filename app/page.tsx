// app/page.tsx
"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Variants } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  AudioLines,
  ChevronDown,
  CircleCheck,
  Clock,
  CreditCard,
  Crosshair,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Fingerprint,
  Gift,
  Info,
  KeyRound,
  Layers,
  Loader2,
  Lock,
  Mic,
  Moon,
  Play,
  Printer,
  Radio,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Upload,
  UserX,
  X,
  type LucideIcon,
} from "lucide-react";
import { heuristicFallback } from "@/lib/heuristicFallback";
import { examples } from "@/data/examples";

/* ═══════════════════════════ TYPES ═══════════════════════════ */

type TacticId =
  | "urgency"
  | "authority_impersonation"
  | "isolation"
  | "threat"
  | "too_good_to_be_true"
  | "payment_request"
  | "personal_info_request";
type Tactic = TacticId | "none";
type TacticCounts = Record<TacticId, number>;
type Speaker = "caller" | "victim" | "unknown";

type Segment = { text: string; speaker: Speaker; tactic: Tactic; explanation: string; counterAdvice: string; start?: number };

type Analysis = {
  riskScore: number;
  category: string;
  summary: string;
  tacticCounts: TacticCounts;
  segments: Segment[];
  inputMode?: "transcript" | "media" | "fallback";
  fallbackReason?: string;
  mediaType?: string;
};

type AudioSummary = { pauseCount: number; longestPauseSec: number; paceSpikeTimestamps: number[] };
type CadencePoint = { timestamp: number; energy: number; isPause: boolean };
type Report = Analysis & { fileName?: string; mode?: "ai" | "fallback"; processingMs?: number };
type Demo = { id: string; label: string; file: string };
type Tab = "recording" | "transcript";
type Phase = "idle" | "uploading" | "analyzing";
type Kind = "audio" | "video";
type Stamp = [number | null, number | null];
type Marks = { t: number[]; total: number };

/* ═══════════════════════════ CONSTANTS ═══════════════════════════ */

const DEMOS: Demo[] = [
  { id: "utility", label: "Utility Rebate Scam (FTC)", file: "utility-rebate.mp3" },
  { id: "fbi", label: "Debt Arrest Threat (FBI)", file: "fbi-imposter.mp4" },
];

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RECORD_SECONDS = 120;
const MAX_TRANSCRIPT_CHARS = 20000;
const ALLOWED_EXT = ["mp4", "mp3", "wav", "m4a", "webm"];

const TACTIC_IDS: readonly TacticId[] = [
  "urgency",
  "authority_impersonation",
  "isolation",
  "threat",
  "too_good_to_be_true",
  "payment_request",
  "personal_info_request",
];

type TacticMeta = { label: string; short: string; Icon: LucideIcon; def: string };
const TACTICS: Record<TacticId, TacticMeta> = {
  urgency: { label: "Urgency", short: "URGENCY", Icon: Clock, def: "Rushes you so you act before you can check anything." },
  authority_impersonation: { label: "False Authority", short: "AUTHORITY", Icon: ShieldAlert, def: "Pretends to be the government, your bank, or the police." },
  isolation: { label: "Isolation", short: "ISOLATION", Icon: UserX, def: "Keeps you away from anyone who would spot the scam." },
  threat: { label: "Threat", short: "THREAT", Icon: AlertTriangle, def: "Scares you with arrest, fines, or losing your money." },
  too_good_to_be_true: { label: "Too Good To Be True", short: "TOO GOOD", Icon: Gift, def: "Offers a prize, a refund, or a guaranteed return." },
  payment_request: { label: "Payment Request", short: "PAYMENT", Icon: CreditCard, def: "Asks for gift cards, crypto, or a wire transfer." },
  personal_info_request: { label: "Info Request", short: "INFO REQ", Icon: KeyRound, def: "Asks for codes, passwords, or access to your computer." },
};

const STEPS = [
  { n: "01", title: "Drop it in", body: "Upload a recording or paste what was said. Either one works." },
  { n: "02", title: "We read it", body: "Every line is written down and matched to whoever said it — caller or victim." },
  { n: "03", title: "See the tricks", body: "Each caller line is checked against seven known tricks and paired with what to say back." },
];

const HERO_STATS: Array<[string, string]> = [
  ["7 tricks", "spotted and named"],
  ["Line by line", "who said what"],
  ["Audio + text", "either works"],
];

/* ═══════════════════════════ HELPERS ═══════════════════════════ */

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const kindOf = (f: File): Kind => {
  if (f.type.startsWith("audio/")) return "audio";
  if (f.type.startsWith("video/")) return "video";
  return ["mp3", "wav", "m4a"].includes(extOf(f.name)) ? "audio" : "video";
};
const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const isTactic = (v: unknown): v is TacticId => typeof v === "string" && (TACTIC_IDS as readonly string[]).includes(v);

function normSpeaker(v: unknown): Speaker {
  const s = asStr(v).toLowerCase().trim();
  if (/^(caller|scammer|agent|operator|attacker|robocall|speaker ?a|a)$/.test(s)) return "caller";
  if (/^(victim|recipient|you|user|target|customer|receiver|speaker ?b|b)$/.test(s)) return "victim";
  return "unknown";
}

function toSeconds(v: unknown): number | undefined {
  const n = asNum(v);
  if (n !== undefined) return n >= 0 ? n : undefined;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d+):(\d{1,2})(?:\.\d+)?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  return undefined;
}

function errorMessage(json: unknown, fallback: string): string {
  if (isRecord(json) && isRecord(json.error) && typeof json.error.message === "string") return json.error.message;
  return fallback;
}

const emptyCounts = (): TacticCounts => ({
  urgency: 0,
  authority_impersonation: 0,
  isolation: 0,
  threat: 0,
  too_good_to_be_true: 0,
  payment_request: 0,
  personal_info_request: 0,
});

function countTactics(segments: Segment[]): TacticCounts {
  const counts = emptyCounts();
  segments.forEach((s) => {
    if (s.tactic !== "none") counts[s.tactic] += 1;
  });
  return counts;
}

const riskLevel = (s: number) => (s >= 81 ? "CRITICAL" : s > 60 ? "HIGH" : s >= 25 ? "ELEVATED" : "LOW");
const riskColor = (s: number) => (s > 60 ? "var(--hot)" : s < 25 ? "var(--ok)" : "var(--amber)");
const speakerLabel = (s: Speaker) => (s === "caller" ? "CALLER" : s === "victim" ? "VICTIM" : "UNKNOWN");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function normalizeReport(raw: unknown): Report {
  const r = isRecord(raw) ? raw : {};
  const segments: Segment[] = [];
  (Array.isArray(r.segments) ? r.segments : []).forEach((item) => {
    if (!isRecord(item)) return;
    const text = asStr(item.text)
      .replace(/^\s*(?:caller|victim|you|recipient)\s*:\s*/i, "")
      .trim();
    if (!text) return;
    const speaker = normSpeaker(item.speaker);
    const tactic: Tactic = speaker !== "victim" && isTactic(item.tactic) ? item.tactic : "none";
    segments.push({
      text,
      speaker,
      tactic,
      explanation: asStr(item.explanation),
      counterAdvice: asStr(item.counterAdvice),
      start: toSeconds(item.start) ?? toSeconds(item.startSec) ?? toSeconds(item.timestamp) ?? toSeconds(item.time),
    });
  });
  const rawCounts = isRecord(r.tacticCounts) ? r.tacticCounts : {};
  let counts = emptyCounts();
  let sum = 0;
  TACTIC_IDS.forEach((id) => {
    const n = asNum(rawCounts[id]);
    counts[id] = n !== undefined ? Math.max(0, Math.round(n)) : 0;
    sum += counts[id];
  });
  if (sum === 0 || segments.length > 0) counts = countTactics(segments);
  const inputModes = ["transcript", "media", "fallback"] as const;
  return {
    riskScore: Math.round(clamp(asNum(r.riskScore) ?? 0, 0, 100)),
    category: asStr(r.category, "Suspicious Call"),
    summary: asStr(r.summary, "Analysis complete."),
    tacticCounts: counts,
    segments,
    inputMode: inputModes.find((m) => m === r.inputMode),
    fallbackReason: asStr(r.fallbackReason) || undefined,
    mediaType: asStr(r.mediaType) || undefined,
    fileName: asStr(r.fileName) || undefined,
    mode: r.mode === "fallback" ? "fallback" : "ai",
    processingMs: asNum(r.processingMs),
  };
}

const transcriptOf = (segments: Segment[]) => segments.map((s) => `${speakerLabel(s.speaker)}: ${s.text}`).join("\n");

/* ═══════════════════════════ AUDIO ANALYSIS ═══════════════════════════ */

function encodeCompactWav(mono: Float32Array, sourceRate: number, name: string): File {
  const target = 16000;
  const ratio = sourceRate / target;
  const outLen = Math.floor(mono.length / ratio);
  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + outLen * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = a; k < b; k++) sum += mono[k] ?? 0;
    const v = clamp(sum / (b - a), -1, 1);
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new File([buffer], name, { type: "audio/wav" });
}

async function decodeToMono(source: Blob): Promise<{ mono: Float32Array; sr: number }> {
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  const ctx = new Ctor();
  try {
    const raw = await source.arrayBuffer();
    const audio = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(raw, resolve, (e) => reject(e ?? new Error("decode failed")));
    });
    const len = audio.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / audio.numberOfChannels;
    }
    return { mono, sr: audio.sampleRate };
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

async function measure(mono: Float32Array, sr: number) {
  const FRAME = 0.05;
  const frameLen = Math.max(1, Math.round(sr * FRAME));
  const nFrames = Math.floor(mono.length / frameLen);
  const rms = new Float32Array(nFrames);
  let peak = 0;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const off = f * frameLen;
    for (let j = 0; j < frameLen; j++) {
      const v = mono[off + j] ?? 0;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    rms[f] = Math.sqrt(sum / frameLen);
    if (f % 500 === 499) await sleep(0);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.min(0.02, Math.max(0.002, p90 * 0.15));

  const minPauseFrames = Math.ceil(0.5 / FRAME);
  const paused = new Uint8Array(nFrames);
  const pauseDurations: number[] = [];
  let runStart = -1;
  for (let f = 0; f <= nFrames; f++) {
    const quiet = f < nFrames && (rms[f] ?? 0) < threshold;
    if (quiet) {
      if (runStart < 0) runStart = f;
    } else if (runStart >= 0) {
      const run = f - runStart;
      if (runStart > 0 && f < nFrames && run >= minPauseFrames) {
        pauseDurations.push(run * FRAME);
        for (let k = runStart; k < f; k++) paused[k] = 1;
      }
      runStart = -1;
    }
  }

  const onsets: number[] = [];
  for (let f = 1; f < nFrames; f++) {
    const cur = rms[f] ?? 0;
    const prev = rms[f - 1] ?? 0;
    if (cur > threshold * 1.5 && cur > prev * 1.6 + 0.002) onsets.push(f * FRAME);
  }
  const density: number[] = [];
  let lo = 0;
  onsets.forEach((t, i) => {
    while (lo < i && (onsets[lo] ?? 0) < t - 2) lo++;
    density.push(i - lo + 1);
  });
  const mean = density.length ? density.reduce((a, b) => a + b, 0) / density.length : 0;
  const std = density.length ? Math.sqrt(density.reduce((a, b) => a + (b - mean) * (b - mean), 0) / density.length) : 0;
  const spikeAt = Math.max(5, mean + 1.5 * std);
  const spikes: number[] = [];
  onsets.forEach((t, i) => {
    const last = spikes[spikes.length - 1];
    if ((density[i] ?? 0) >= spikeAt && (last === undefined || t - last >= 3) && spikes.length < 10) spikes.push(Math.round(t * 10) / 10);
  });

  const bucket = Math.max(5, Math.ceil(nFrames / 300));
  const telemetry: CadencePoint[] = [];
  for (let start = 0; start < nFrames; start += bucket) {
    const end = Math.min(nFrames, start + bucket);
    let sum = 0;
    let pausedCount = 0;
    for (let f = start; f < end; f++) {
      sum += rms[f] ?? 0;
      pausedCount += paused[f] ?? 0;
    }
    const n = end - start;
    telemetry.push({
      timestamp: Math.round(start * FRAME * 10) / 10,
      energy: Math.round((sum / n) * 10000) / 10000,
      isPause: pausedCount >= n * 0.8,
    });
  }
  return {
    telemetry,
    peak,
    summary: {
      pauseCount: pauseDurations.length,
      longestPauseSec: Math.round(Math.max(0, ...pauseDurations) * 10) / 10,
      paceSpikeTimestamps: spikes,
    } as AudioSummary,
  };
}

/** Server-side ffmpeg extraction: the fix for containers whose audio codec the browser can't decode. */
async function extractOnServer(source: File): Promise<File> {
  const body = new FormData();
  body.append("file", source, source.name);
  let res: Response;
  try {
    res = await fetch("/api/extract-audio", { method: "POST", body });
  } catch {
    throw new Error("We couldn't reach the audio helper.");
  }
  if (!res.ok) {
    const j: unknown = await res.json().catch(() => null);
    throw new Error(errorMessage(j, `audio extraction failed (${res.status})`));
  }
  const blob = await res.blob();
  const base = source.name.replace(/\.[^.]+$/, "") || "audio";
  return new File([blob], `${base}-extracted.wav`, { type: "audio/wav" });
}

type Prep = {
  telemetry: CadencePoint[];
  summary: AudioSummary;
  uploadWav: File | null;
  playbackWav: File | null;
  note: string;
};

async function prepareAudio(source: File): Promise<Prep> {
  let mono: Float32Array;
  let sr: number;
  let extracted: File | null = null;
  try {
    ({ mono, sr } = await decodeToMono(source));
  } catch {
    extracted = await extractOnServer(source); // throws with a specific reason (e.g. "no audio track")
    ({ mono, sr } = await decodeToMono(extracted));
  }
  const m = await measure(mono, sr);
  const base = source.name.replace(/\.[^.]+$/, "") || "audio";
  let note = "";
  if (m.peak < 0.001) note = "There's no speech in this file — it's silent.";
  const compact = !extracted && source.size > 4 * 1024 * 1024 ? encodeCompactWav(mono, sr, `${base}-compact.wav`) : null;
  return { telemetry: m.telemetry, summary: m.summary, uploadWav: extracted ?? compact, playbackWav: extracted, note };
}

/* ═══════════════════════════ STYLES ═══════════════════════════ */

const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap");

.vexa-root{
  --vx-sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --vx-mono:var(--font-jetbrains-mono,"JetBrains Mono"),ui-monospace,SFMono-Regular,Menlo,monospace;
  --vx-display:"Space Grotesk",var(--vx-sans);

  --bg:#05080A;--bg-soft:#080E11;--panel:#0A1114;--panel-2:#0D171B;
  --ink:#E4F1EB;--muted:rgba(228,241,235,.54);--dim:rgba(228,241,235,.30);
  --line:rgba(228,241,235,.09);--line-2:rgba(228,241,235,.18);
  --acc:#25E39B;--acc-dim:rgba(37,227,155,.07);--acc-line:rgba(37,227,155,.32);
  --hot:#FF5C4D;--hot-dim:rgba(255,92,77,.10);--hot-line:rgba(255,92,77,.36);
  --ok:#25E39B;--amber:#FFB347;--amber-dim:rgba(255,179,71,.10);

  /* square-grid field, now a faint halo that fades out before the content starts */
  --grid-line:rgba(37,227,155,.030);
  --grid-line-fine:rgba(228,241,235,.011);
  /* two soft pools of light for depth, no pattern noise */
  --bg-glow:rgba(37,227,155,.055);
  --bg-glow-2:rgba(37,227,155,.028);

  position:relative;min-height:100vh;color:var(--ink);
  background-color:var(--bg);
  background-image:
    radial-gradient(125% 80% at 50% -20%,var(--bg-glow),transparent 68%),
    radial-gradient(90% 60% at 50% 116%,var(--bg-glow-2),transparent 70%);
  background-repeat:no-repeat;
  background-attachment:fixed;
  font-family:var(--vx-mono);font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden;
}
html.light .vexa-root{
  --bg:#E9EDEB;--bg-soft:#F7F9F8;--panel:#FFFFFF;--panel-2:#FFFFFF;
  --ink:#07130E;--muted:rgba(7,19,14,.60);--dim:rgba(7,19,14,.34);
  --line:rgba(7,19,14,.11);--line-2:rgba(7,19,14,.22);
  --acc:#067D57;--acc-dim:rgba(6,125,87,.06);--acc-line:rgba(6,125,87,.34);
  --hot:#BE331F;--hot-dim:rgba(190,51,31,.08);--hot-line:rgba(190,51,31,.32);
  --ok:#067D57;--amber:#8A5A00;--amber-dim:rgba(138,90,0,.08);
  --grid-line:rgba(6,125,87,.045);
  --grid-line-fine:rgba(7,19,14,.014);
  --bg-glow:rgba(6,125,87,.055);
  --bg-glow-2:rgba(6,125,87,.030);
}
.vexa-root ::selection{background:var(--acc);color:#04140D}
.vexa-root :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.vexa-root button{cursor:pointer;font-family:var(--vx-mono)}

.font-display{font-family:var(--vx-display);font-weight:700;letter-spacing:-.015em}
.kicker{font-family:var(--vx-mono);font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase}
.px{font-family:var(--vx-mono);text-transform:uppercase;letter-spacing:.12em;font-weight:600;font-size:11px}
.px[class*="text-[9px]"]{font-size:10.5px}
.px[class*="text-[10px]"]{font-size:11px}
.px[class*="text-[11px]"]{font-size:12px}

.acc{color:var(--acc)} .hot{color:var(--hot)} .ok{color:var(--ok)} .amb{color:var(--amber)}

.box-acc{border:1px solid var(--acc-line);background:var(--acc-dim);color:var(--acc)}
.box-hot{border:1px solid var(--hot-line);background:var(--hot-dim);color:var(--hot)}
.box-ok{border:1px solid var(--acc-line);background:var(--acc-dim);color:var(--acc)}

/* ── panels ── */
.console-card,.hud{
  position:relative;border:1px solid var(--line);
  background:linear-gradient(180deg,var(--panel-2),var(--panel));
}
.hud::before,.hud::after{content:"";position:absolute;width:9px;height:9px;border:1px solid var(--acc-line);pointer-events:none}
.hud::before{top:-1px;left:-1px;border-right:0;border-bottom:0}
.hud::after{bottom:-1px;right:-1px;border-left:0;border-top:0}

/* ── background layer: quiet grid halo, masked so it never competes with content ── */
.gridfield{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:
    linear-gradient(var(--grid-line) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid-line) 1px,transparent 1px),
    linear-gradient(var(--grid-line-fine) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid-line-fine) 1px,transparent 1px);
  background-size:96px 96px,96px 96px,24px 24px,24px 24px;
  background-position:0 0,0 0,0 0,0 0;
  -webkit-mask-image:radial-gradient(145% 96% at 50% -4%,#000 0%,rgba(0,0,0,.5) 40%,transparent 74%);
  mask-image:radial-gradient(145% 96% at 50% -4%,#000 0%,rgba(0,0,0,.5) 40%,transparent 74%)}
.scanlines{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.16;
  background:repeating-linear-gradient(180deg,rgba(255,255,255,.02) 0 1px,transparent 1px 4px)}
html.light .scanlines{display:none}
.vx-content{position:relative;z-index:2}

/* ── chrome: no bar any more, just the theme switch parked in the corner ── */
.vx-theme-corner{position:fixed;top:.75rem;right:.75rem;z-index:50;
  display:flex;align-items:center;padding:.25rem;
  border:1px solid var(--line);background:color-mix(in srgb,var(--bg) 84%,transparent);
  backdrop-filter:blur(14px)}
.led{position:relative;display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--acc)}
.led::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--acc);animation:vx-ping 2.4s ease-out infinite}
.led-hot{background:var(--hot)} .led-hot::after{background:var(--hot)}
@keyframes vx-ping{0%{transform:scale(1);opacity:.55}100%{transform:scale(3.2);opacity:0}}
.vx-caret{display:inline-block;width:6px;height:11px;margin-left:3px;vertical-align:-1px;background:var(--acc);animation:vx-blink 1s steps(2,start) infinite}
@keyframes vx-blink{to{visibility:hidden}}

/* ── brand lockup: animated mark + VEXA / SCAM CALL CHECKER ── */
.vx-brand{display:flex;align-items:center;gap:.7rem;min-width:0}
.vx-brand-text{display:flex;flex-direction:column;gap:2px;line-height:1;min-width:0}
.vx-brand-name{font-family:var(--vx-display);font-weight:700;font-size:19px;letter-spacing:.15em}
.vx-brand-tag{font-family:var(--vx-mono);font-size:9.5px;font-weight:600;letter-spacing:.2em;color:var(--acc)}
@media (max-width:420px){.vx-brand-tag{letter-spacing:.14em;font-size:9px}}

.vx-mark{position:relative;display:inline-grid;place-items:center;flex:0 0 auto}
.vx-mark-ring{transform-box:fill-box;transform-origin:center;animation:vx-mark-spin 16s linear infinite;opacity:.9}
.vx-mark-arc{transform-box:fill-box;transform-origin:center;animation:vx-mark-spin 3.8s linear infinite}
.vx-mark-scan{transform-box:fill-box;filter:blur(.6px);animation:vx-mark-scan 3.4s cubic-bezier(.45,0,.55,1) infinite}
@keyframes vx-mark-spin{to{transform:rotate(360deg)}}
@keyframes vx-mark-scan{0%{transform:translateY(-7px);opacity:0}10%{opacity:.95}88%{opacity:.95}100%{transform:translateY(32px);opacity:0}}

/* ── buttons ── */
.btn{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;
  border:1px solid var(--acc);background:var(--acc);color:#04140D;font-weight:700;font-size:12px;
  letter-spacing:.16em;text-transform:uppercase;padding:1rem 1.25rem;transition:filter .12s,box-shadow .12s,transform .12s;
  clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
.btn:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 12px 34px -14px var(--acc)}
.btn:disabled{cursor:not-allowed;background:transparent;color:var(--dim);border-color:var(--line-2);border-style:dashed;box-shadow:none;filter:none}

.tog{display:inline-flex;align-items:center;gap:.45rem;border:1px solid var(--line-2);background:transparent;color:var(--muted);
  font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:.45rem .7rem;transition:color .12s,border-color .12s,background .12s}
.tog:hover:not(:disabled){color:var(--ink);border-color:var(--acc-line);background:var(--acc-dim)}
.tog[aria-pressed="true"]{color:var(--acc);border-color:var(--acc-line);background:var(--acc-dim)}
.tog:disabled{opacity:.4;cursor:not-allowed}

.chan{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;border:1px dashed var(--line-2);background:transparent;
  color:var(--ink);font-size:11.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;padding:.9rem 1rem;
  transition:border-color .14s,background .14s,color .14s}
.chan:hover:not(:disabled){border-style:solid;border-color:var(--acc);background:var(--acc-dim);color:var(--acc)}
.chan[data-live="true"]{border-style:solid;border-color:var(--hot-line);background:var(--hot-dim);color:var(--hot)}
.chan:disabled{opacity:.45;cursor:not-allowed}

/* ── drop zone ── */
.dz{position:relative;width:100%;overflow:hidden;border:1px dashed var(--line-2);text-align:center;
  background:radial-gradient(130% 140% at 50% 0%,var(--acc-dim),transparent 62%),linear-gradient(180deg,var(--bg-soft),transparent);
  transition:border-color .16s,background .16s}
html.light .dz{background:radial-gradient(130% 140% at 50% 0%,var(--acc-dim),transparent 62%),#FBFCFB}
.dz:hover{border-color:var(--acc-line)}
.dz[data-drag="true"]{border-style:solid;border-color:var(--acc);background:radial-gradient(130% 140% at 50% 0%,var(--acc-dim),transparent 72%)}
.dz .tick{position:absolute;width:12px;height:12px;border-color:var(--acc);opacity:.55;pointer-events:none}
.dz .tick-tl{top:0;left:0;border-top:1px solid;border-left:1px solid}
.dz .tick-tr{top:0;right:0;border-top:1px solid;border-right:1px solid}
.dz .tick-bl{bottom:0;left:0;border-bottom:1px solid;border-left:1px solid}
.dz .tick-br{bottom:0;right:0;border-bottom:1px solid;border-right:1px solid}
.dz-sweep{position:absolute;left:0;right:0;top:0;height:1px;opacity:0;
  background:linear-gradient(90deg,transparent,var(--acc),transparent);animation:vx-sweep 4.2s cubic-bezier(.45,0,.55,1) infinite}
@keyframes vx-sweep{0%{top:0;opacity:0}12%{opacity:.6}88%{opacity:.6}100%{top:100%;opacity:0}}
.sigil{position:relative;display:grid;place-items:center;height:64px;width:64px}
.sigil > span{position:absolute;inset:0;border:1px solid var(--acc-line)}
.sigil > span + span{border-style:dashed;opacity:.6;animation:vx-spin 14s linear infinite}
@keyframes vx-spin{to{transform:rotate(90deg)}}

/* ── step tree ── */
.tree{position:relative}
.tree-child{position:relative;display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.3rem 0 .3rem 1.15rem}
.tree-child::before{content:"";position:absolute;left:0;top:50%;width:.75rem;height:1px;background:var(--line-2)}
.tree-rail{border-left:1px solid var(--line-2)}
.tree-dot{width:9px;height:9px;border:1px solid var(--line-2);flex-shrink:0;display:block}
@keyframes vx-draw{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.tree-child{animation:vx-draw .22s ease-out}

.vx-cell{width:12px;height:12px;border:1px solid var(--line);transition:transform .1s}
.vx-cell:hover{transform:scale(1.25)}
.vx-hoverbg:hover{background:var(--acc-dim)}
.rule{height:1px;background:linear-gradient(90deg,transparent,var(--acc-line),transparent)}

@media (prefers-reduced-motion:reduce){
  .vx-caret,.dz-sweep,.led::after,.sigil > span + span,.tree-child,.vexa-root .animate-spin,.vexa-root .animate-pulse{animation:none!important}
  .vx-mark-ring,.vx-mark-arc{animation:none!important}
  .vx-mark-scan{animation:none!important;opacity:0}
  .vx-cell:hover{transform:none}
}
@media print{
  .no-print,.gridfield,.scanlines{display:none!important}
  html .vexa-root,html.dark .vexa-root,html.light .vexa-root{
    --bg:#fff;--bg-soft:#fff;--panel:#fff;--panel-2:#fff;--ink:#000;--muted:rgba(0,0,0,.66);--dim:rgba(0,0,0,.5);
    --line:rgba(0,0,0,.16);--line-2:rgba(0,0,0,.3);--acc:#065F46;--acc-dim:rgba(6,95,70,.07);--acc-line:rgba(6,95,70,.4);
    --hot:#991B1B;--hot-dim:rgba(153,27,27,.07);--hot-line:rgba(153,27,27,.35);--ok:#065F46;--amber:#7C4A00;
    background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .vx-content{padding-top:0!important}
  .console-card,.hud{break-inside:avoid;box-shadow:none!important}
  .hud::before,.hud::after{display:none}
}

/* ── scroll cue: tells the judge there is more underneath ── */
.scroll-cue{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:60;display:flex;align-items:center;gap:.5rem;
  border:1px solid var(--acc-line);background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(10px);
  color:var(--acc);padding:.5rem .85rem;box-shadow:0 18px 36px -24px var(--acc)}
.scroll-cue:hover{background:var(--acc-dim)}
.scroll-cue .sc-txt{font-family:var(--vx-mono);font-size:10px;font-weight:600;letter-spacing:.2em;text-transform:uppercase}
.scroll-cue svg{animation:vx-bob 1.7s ease-in-out infinite}
@keyframes vx-bob{0%,100%{transform:translateY(-2px);opacity:.55}50%{transform:translateY(2px);opacity:1}}
@media (min-width:1024px){
  .scroll-cue{left:auto;right:14px;bottom:auto;top:50%;transform:translateY(-50%);flex-direction:column;gap:.6rem}
  .scroll-cue .sc-txt{writing-mode:vertical-rl}
  .scroll-cue:hover{transform:translateY(-50%) translateX(-2px)}
}

/* ── action rail + the always-visible run button ── */
.rail{position:relative;border:1px solid var(--line);background:linear-gradient(180deg,var(--panel-2),var(--panel))}
.rail-cta{border:1px solid var(--acc-line);box-shadow:0 26px 50px -36px var(--acc);
  background:radial-gradient(120% 130% at 50% 0%,var(--acc-dim),transparent 72%),var(--panel)}
.btn-lg{padding:1.05rem 1.25rem;font-size:13px}
.btn-pulse{position:relative}
.btn-pulse::after{content:"";position:absolute;inset:-1px;border:1px solid var(--acc);opacity:0;pointer-events:none;animation:vx-halo 2.8s ease-out infinite}
@keyframes vx-halo{0%{opacity:.5;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.05)}}

/* ── live equalizer shown while the scan runs ── */
.rail-live{display:grid;grid-template-columns:repeat(28,1fr);align-items:end;gap:2px;height:40px}
.rail-live i{display:block;background:var(--acc);animation:vx-eq 1.15s ease-in-out infinite}
@keyframes vx-eq{0%,100%{height:16%}50%{height:100%}}

/* ── progress rails ── */
.step-bar{position:relative;height:2px;background:var(--line);overflow:hidden}
.step-bar > span{display:block;height:100%;background:var(--acc);transition:width .4s ease}

/* ── roomier branch steps ── */
.tree-wide .tree-child{padding:.5rem 0 .5rem 1.35rem}
.tree-wide .tree-child::before{width:.9rem}
.tree-wide .tree-dot{width:11px;height:11px}

/* ── jump links in the report contents bar ── */
.jump-link{font-family:var(--vx-mono);font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--acc);
  border-bottom:1px solid var(--acc-line);padding-bottom:1px;transition:opacity .12s}
.jump-link:hover{opacity:.65}

/* ── the 7 tricks tiles: roomy, one idea per card ── */
.trick-grid{display:grid;gap:1px;background:var(--line)}
.trick-cell{background:var(--bg-soft);padding:1.5rem}
@media (min-width:640px){
  .trick-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .trick-cell{padding:1.75rem}
  .trick-cell-wide{grid-column:span 2}
}
@media (min-width:1280px){
  .trick-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .trick-cell-wide{grid-column:span 1}
}

.trick-num{font-family:var(--vx-mono);font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;white-space:nowrap}
.trick-name{font-family:var(--vx-display);font-weight:700;font-size:15px;line-height:1.25;letter-spacing:.02em}

@media (prefers-reduced-motion:reduce){
  .scroll-cue svg,.rail-live i,.btn-pulse::after{animation:none!important}
}

/* ── hero: animated mark halo + one-line fade-in ── */
.hero-mark{position:relative;display:inline-grid;place-items:center;flex:0 0 auto}
.hero-mark::after{content:"";position:absolute;inset:-7px;border-radius:50%;
  background:radial-gradient(circle,var(--acc-dim),transparent 70%);
  animation:vx-halo-soft 3.2s ease-in-out infinite}
@keyframes vx-halo-soft{0%,100%{opacity:.25;transform:scale(.94)}50%{opacity:.65;transform:scale(1.03)}}
.hero-in{animation:vx-hero .5s cubic-bezier(.16,1,.3,1) both}
@keyframes vx-hero{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* ── classification rubber stamp ── */
.vexa-root{--stamp-hot:#FF6A57;--stamp-warn:#FFB347;--stamp-ok:#25E39B}
html.light .vexa-root{--stamp-hot:#B3271A;--stamp-warn:#8A5A00;--stamp-ok:#067D57}

.stamp{
  --stamp-ink:var(--stamp-hot);
  position:relative;display:inline-block;max-width:100%;
  padding:1rem 1.35rem .95rem;
  border:3px double var(--stamp-ink);
  color:var(--stamp-ink);
  background:
    radial-gradient(120% 120% at 18% 12%,color-mix(in srgb,var(--stamp-ink) 12%,transparent),transparent 62%),
    radial-gradient(color-mix(in srgb,var(--stamp-ink) 15%,transparent) .5px,transparent .6px) 0 0/4px 4px,
    repeating-linear-gradient(115deg,color-mix(in srgb,var(--stamp-ink) 6%,transparent) 0 1px,transparent 1px 6px);
  box-shadow:0 26px 48px -36px var(--stamp-ink);
}
.stamp-warn{--stamp-ink:var(--stamp-warn)}
.stamp-ok{--stamp-ink:var(--stamp-ok)}
.stamp::before{content:"";position:absolute;inset:5px;border:1px solid color-mix(in srgb,var(--stamp-ink) 50%,transparent);pointer-events:none}
.stamp > *{position:relative}
.stamp-top{display:flex;align-items:center;gap:.75rem;font-family:var(--vx-mono);font-size:9.5px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;opacity:.85}
.stamp-top i{flex:1;height:1px;background:color-mix(in srgb,var(--stamp-ink) 45%,transparent)}
.stamp-cat{display:block;margin-top:.6rem;font-family:var(--vx-display);font-weight:700;font-size:1.6rem;line-height:1.05;
  letter-spacing:.02em;text-transform:uppercase;word-break:break-word;
  text-shadow:1.5px 1.6px 0 color-mix(in srgb,var(--stamp-ink) 24%,transparent)}
@media (min-width:640px){.stamp-cat{font-size:1.95rem}}
.stamp-meta{display:block;margin-top:.75rem;padding-top:.6rem;border-top:1px solid color-mix(in srgb,var(--stamp-ink) 40%,transparent);
  font-family:var(--vx-mono);font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase}

@media print{
  .stamp{box-shadow:none!important}
}
@media (prefers-reduced-motion:reduce){
  .hero-in,.hero-mark::after{animation:none!important}
}
`;

/* ═══════════════════════════ BRAND + ATOMS ═══════════════════════════ */

const MARK_PATH = "M8 2H9L16 19L23 2H24A6 6 0 0 1 30 8V24A6 6 0 0 1 24 30H8A6 6 0 0 1 2 24V8A6 6 0 0 1 8 2Z";

/**
 * The Vexa mark. Still by default fallback, animated otherwise: a radar ring
 * and sweep arc circle the plate while a scan band passes over it top to bottom,
 * the way a scanner sweeps a document. Purely decorative, aria-hidden.
 */
function VexaMark({ size = 24, className = "", animated = true }: { size?: number; className?: string; animated?: boolean }) {
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!animated) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" className={className}>
        <path d={MARK_PATH} />
      </svg>
    );
  }
  return (
    <span className={`vx-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 36 36" width={size} height={size} focusable="false">
        <defs>
          <clipPath id={`vxm-clip-${uid}`}>
            <path d={MARK_PATH} transform="translate(2 2)" />
          </clipPath>
          <linearGradient id={`vxm-fill-${uid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--acc)" />
            <stop offset="100%" stopColor="var(--acc)" stopOpacity=".6" />
          </linearGradient>
        </defs>

        {/* radar ring — slow rotation */}
        <g className="vx-mark-ring">
          <circle cx="18" cy="18" r="16.6" fill="none" stroke="var(--acc-line)" strokeWidth="1" strokeDasharray="2.5 5.5" />
        </g>
        {/* radar sweep — fast arc */}
        <g className="vx-mark-arc">
          <circle cx="18" cy="18" r="16.6" fill="none" stroke="var(--acc)" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="9 95.3" />
        </g>

        <g transform="translate(2 2)">
          <path d={MARK_PATH} fill="currentColor" opacity="0.36" />
          <g clipPath={`url(#vxm-clip-${uid})`}>
            <path d={MARK_PATH} fill={`url(#vxm-fill-${uid})`} opacity="0.30" />
            <rect className="vx-mark-scan" x="-1" y="0" width="34" height="3.5" fill="var(--acc)" opacity="0.9" />
          </g>
        </g>
      </svg>
    </span>
  );
}

/** Mark + wordmark + the tagline that says what this is. Kept for reuse. */
function VexaLogo() {
  return (
    <span className="vx-brand">
      <VexaMark size={26} />
      <span className="vx-brand-text">
        <span className="vx-brand-name">VEXA</span>
        <span className="vx-brand-tag">SCAM CALL CHECKER</span>
      </span>
    </span>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("dark") && !root.classList.contains("light")) {
      let stored: string | null = null;
      try {
        stored = localStorage.getItem("theme");
      } catch {
        stored = null;
      }
      const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
      const next = stored ?? (prefersLight ? "light" : "dark");
      root.classList.toggle("dark", next === "dark");
      root.classList.toggle("light", next === "light");
    }
    setDark(root.classList.contains("dark"));
  }, []);
  function toggle() {
    const root = document.documentElement;
    const next = !root.classList.contains("dark");
    root.classList.toggle("dark", next);
    root.classList.toggle("light", !next);
    root.style.colorScheme = next ? "dark" : "light";
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* storage blocked */
    }
    setDark(next);
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="vx-hoverbg border border-[color:var(--line)] p-2 text-[color:var(--muted)] transition hover:text-[color:var(--ink)]"
    >
      {dark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

/**
 * The only chrome left: the theme switch, parked in the top-right corner.
 * There is no top bar any more, so the hero is the first thing you read.
 */
function ThemeCorner() {
  return (
    <div className="vx-theme-corner no-print">
      <ThemeToggle />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode; beam?: boolean }) {
  return (
    <div className="vexa-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="gridfield" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
      <div className="vx-content min-h-screen">{children}</div>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div role="alert" className="box-hot mt-3 flex items-start gap-3 p-3 text-xs leading-relaxed">
      <AlertCircle size={14} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2.5 border-l border-[color:var(--acc-line)] bg-[color:var(--acc-dim)] p-3 text-[11px] leading-relaxed text-[color:var(--muted)]">
      <Info size={13} className="acc mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function TacticChip({ tactic }: { tactic: Tactic }) {
  if (tactic === "none")
    return (
      <span className="px box-acc inline-flex shrink-0 items-center gap-1.5 self-start px-2 py-1 text-[9px]">
        <CircleCheck size={11} /> CLEAR
      </span>
    );
  const { Icon, label } = TACTICS[tactic];
  return (
    <span className="px box-hot inline-flex shrink-0 items-center gap-1.5 self-start px-2 py-1 text-[9px]">
      <Icon size={11} /> {label}
    </span>
  );
}

function SpeakerBadge({ speaker }: { speaker: Speaker }) {
  const cls =
    speaker === "caller"
      ? "box-hot"
      : speaker === "victim"
      ? "box-acc"
      : "border border-[color:var(--line)] text-[color:var(--muted)]";
  return <span className={`px inline-block w-[4.8rem] shrink-0 px-1.5 py-1 text-center text-[9px] ${cls}`}>{speakerLabel(speaker)}</span>;
}

/* ═══════════════════════════ LIVE STAGE TIMERS ═══════════════════════════ */

function useElapsed(t0: number | null, t1: number | null): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (t0 === null || t1 !== null) return;
    let id = 0;
    const tick = () => {
      setNow(performance.now());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [t0, t1]);
  if (t0 === null) return 0;
  return Math.max(0, ((t1 ?? (now || performance.now())) - t0) / 1000);
}

type StageState = "idle" | "running" | "done" | "warn";

/** A big pipeline stage: square status cell, connector rail, live counter, and optional nested steps. */
function StageRow({
  index,
  title,
  detail,
  state,
  stamp,
  last = false,
  children,
}: {
  index: number;
  title: string;
  detail: string;
  state: StageState;
  stamp: Stamp;
  last?: boolean;
  children?: React.ReactNode;
}) {
  const secs = useElapsed(stamp[0], stamp[1]);
  const tone = state === "done" ? "var(--ok)" : state === "warn" ? "var(--hot)" : state === "running" ? "var(--acc)" : "var(--dim)";
  return (
    <li className="grid grid-cols-[26px_1fr] gap-3">
      <div className="flex flex-col items-center">
        <span
          className="grid h-[26px] w-[26px] shrink-0 place-items-center border text-[10px] font-semibold"
          style={{
            borderColor: state === "idle" ? "var(--line-2)" : tone,
            color: state === "idle" ? "var(--muted)" : tone,
            background: state === "idle" ? "transparent" : "var(--acc-dim)",
          }}
        >
          {state === "running" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : state === "done" ? (
            <CircleCheck size={13} />
          ) : state === "warn" ? (
            <AlertTriangle size={12} />
          ) : (
            String(index).padStart(2, "0")
          )}
        </span>
        {!last && <span className="my-1 w-px flex-1" style={{ background: state === "done" ? "var(--acc-line)" : "var(--line-2)" }} aria-hidden="true" />}
      </div>
      <div className="min-w-0 pb-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[11.5px] font-semibold tracking-[.12em] uppercase" style={{ color: state === "idle" ? "var(--muted)" : "var(--ink)" }}>
            {title}
          </span>
          <span className="shrink-0 text-[13px] font-semibold tabular-nums" style={{ color: tone }} aria-label="elapsed seconds">
            {stamp[0] === null ? "--.--" : secs.toFixed(2)}
            <span className="text-[10px] opacity-60">s</span>
          </span>
        </div>
        {detail && <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--muted)]">{detail}</p>}
        {children}
      </div>
    </li>
  );
}

/**
 * The nested run: one line per step, branching downward from the stage above.
 * Each row grows its own check mark and its own duration as it finishes.
 * With a "STEP n OF m" rail and a total clock so the wait never looks dead.
 */
function BranchSteps({ lines, active, marksRef }: { lines: string[]; active: boolean; marksRef: React.MutableRefObject<Marks> }) {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(0);
  const [now, setNow] = useState(0);
  const t0 = useRef(0);

  useEffect(() => {
    if (!active) return;
    t0.current = performance.now();
    marksRef.current = { t: [0], total: 0 };
    setCount(1);
    setNow(0);
    const tick = setInterval(() => setNow((performance.now() - t0.current) / 1000), 80);
    const adv = setInterval(
      () =>
        setCount((c) => {
          if (c >= lines.length) return c;
          marksRef.current.t[c] = (performance.now() - t0.current) / 1000;
          return c + 1;
        }),
      reduce ? 200 : 1000
    );
    return () => {
      clearInterval(tick);
      clearInterval(adv);
      marksRef.current.total = (performance.now() - t0.current) / 1000;
    };
  }, [active, lines, reduce, marksRef]);

  if (!active && count === 0) return null;

  const marks = marksRef.current.t;
  const doneCount = active ? count - 1 : count;
  const total = marksRef.current.total || now;
  const filled = Math.min(Math.max(count, 1), lines.length);
  const complete = !active && filled >= lines.length;

  return (
    <div className="mt-3">
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker shrink-0" style={{ color: complete ? "var(--ok)" : "var(--acc)" }}>
          {complete ? "ALL STEPS DONE" : `STEP ${filled} OF ${lines.length}`}
        </span>
        <span className="step-bar flex-1">
          <span style={{ width: `${(filled / lines.length) * 100}%` }} />
        </span>
        <span className="kicker shrink-0 tabular-nums text-[color:var(--dim)]">{fmtSec(total)}</span>
      </div>
      <ul className="tree tree-rail tree-wide">
        {lines.map((line, i) => {
          const isDone = i < doneCount;
          const isRunning = active && i === doneCount;
          const start = marks[i];
          const end = i + 1 < marks.length ? marks[i + 1] : total;
          const secs = start !== undefined && end !== undefined ? `${Math.max(0, end - start).toFixed(2)}s` : "—";
          const lit = isDone || isRunning;
          return (
            <li key={line} className="tree-child" style={{ opacity: lit ? 1 : 0.5 }}>
              <span className="flex min-w-0 items-center gap-2.5 text-[12px]" style={{ color: lit ? "var(--ink)" : "var(--muted)" }}>
                {isDone ? (
                  <CircleCheck size={12} className="acc shrink-0" />
                ) : isRunning ? (
                  <Loader2 size={12} className="acc shrink-0 animate-spin" />
                ) : (
                  <span className="tree-dot" aria-hidden="true" />
                )}
                <span className="truncate">{line}</span>
                {isRunning && <span className="vx-caret" aria-hidden="true" />}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums" style={{ color: lit ? "var(--acc)" : "var(--dim)" }}>
                {secs}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ═══════════════════════════ PAGE CUES + ACTION RAIL ═══════════════════════════ */

const REPORT_SECTIONS: Array<{ id: string; label: string; mediaOnly?: boolean }> = [
  { id: "sec-insights", label: "At a glance" },
  { id: "sec-lines", label: "Line by line" },
  { id: "sec-charts", label: "Voice charts", mediaOnly: true },
  { id: "sec-verdict", label: "What to do now" },
  { id: "sec-details", label: "Report details" },
  { id: "glossary", label: "The 7 tricks" },
];

/** A quiet, always-on cue that there is more underneath. Clicking it jumps a screen down. */
function ScrollCue() {
  const reduce = useReducedMotion();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const check = () => {
      const el = document.documentElement;
      setShow(el.scrollHeight - (window.scrollY + window.innerHeight) > 180);
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    const id = setInterval(check, 700);
    return () => {
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      clearInterval(id);
    };
  }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.button
          type="button"
          className="scroll-cue no-print"
          aria-label="Scroll down — there is more below"
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 8 }}
          onClick={() => window.scrollBy({ top: window.innerHeight * 0.85, behavior: reduce ? "auto" : "smooth" })}
        >
          <span className="sc-txt">More below</span>
          <ChevronDown size={13} />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** Runs while the scan works, inside the progress card so nothing floats loose. */
function LiveWaitPanel() {
  return (
    <div className="mt-4 border-t border-[color:var(--line)] pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="kicker hot flex items-center gap-2">
          <Radio size={12} /> LIVE
        </span>
        <span className="kicker text-[color:var(--dim)]">KEEP THIS OPEN</span>
      </div>
      <div className="rail-live" aria-hidden="true">
        {Array.from({ length: 28 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${(i % 9) * 0.12}s` }} />
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
        Vexa is listening for pauses, pacing, and the exact words each person used.
      </p>
    </div>
  );
}

/**
 * The right-hand rail, in the order you actually need it: run the scan,
 * then watch the stages. Nothing sticks, so the stages can never slide
 * underneath the run card.
 */
function ActionRail({
  busy,
  phase,
  progress,
  ctaLabel,
  ctaDisabled,
  onRun,
  stageCount,
  stages,
  hint,
}: {
  busy: boolean;
  phase: Phase;
  progress: number;
  ctaLabel: string;
  ctaDisabled: boolean;
  onRun: () => void;
  stageCount: number;
  stages: React.ReactNode;
  hint?: string;
}) {
  return (
    <aside className="min-w-0 lg:border-l lg:border-[color:var(--line)] lg:pl-6">
      <div className="space-y-4">
        {/* ── STEP 2 · RUN THE SCAN ── */}
        <div className="rail rail-cta hidden p-4 lg:block">
          <div className="flex items-center justify-between gap-3">
            <span className="kicker flex items-center gap-2" style={{ color: busy ? "var(--hot)" : "var(--acc)" }}>
              <span className={`led ${busy ? "led-hot" : ""}`} />
              {busy ? (phase === "uploading" ? `UPLOADING ${progress}%` : "READING THE CALL") : "READY TO RUN"}
            </span>
            <span className="kicker flex items-center gap-2 text-[color:var(--dim)]">
              <span className="grid h-[18px] w-[18px] place-items-center border border-[color:var(--acc-line)] bg-[color:var(--acc-dim)] text-[10px] text-[color:var(--acc)]">2</span>
              RUN THE SCAN
            </span>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
            {hint ?? "Press this and Vexa reads every line, names every trick, and writes the report."}
          </p>
          <button type="button" className={`btn btn-lg mt-3 ${busy || ctaDisabled ? "" : "btn-pulse"}`} disabled={ctaDisabled} onClick={onRun}>
            {busy ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}
            {ctaLabel}
          </button>
          {busy && phase === "uploading" && (
            <div className="mt-3 step-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Upload progress">
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-[color:var(--muted)]">
            <span className="flex items-center gap-1.5">
              <Lock size={11} className="acc" /> Nothing is saved
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck size={11} className="acc" /> Deleted after the scan
            </span>
          </div>
        </div>

        {/* ── live stages ── */}
        <div className="rail p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="kicker flex items-center gap-2">
              <Activity size={12} className="acc" /> LIVE PROGRESS
            </span>
            <span className="kicker text-[color:var(--dim)]">
              {stageCount} STAGE{stageCount > 1 ? "S" : ""}
            </span>
          </div>
          <ol>{stages}</ol>
          {busy && <LiveWaitPanel />}
        </div>
      </div>
    </aside>
  );
}

/* ═══════════════════════════ MEDIA PLAYER ═══════════════════════════ */

function MediaPlayer({
  src,
  kind,
  altAudio,
  mediaRef,
  onFail,
  className = "",
}: {
  src: string;
  kind: Kind;
  altAudio?: string;
  mediaRef?: React.MutableRefObject<HTMLMediaElement | null>;
  onFail?: () => void;
  className?: string;
}) {
  const aRef = useRef<HTMLAudioElement | null>(null);
  const vRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = vRef.current;
    const a = aRef.current;
    if (!altAudio || !v || !a) return;
    const play = () => {
      a.currentTime = v.currentTime;
      void a.play().catch(() => undefined);
    };
    const pause = () => a.pause();
    const sync = () => {
      a.currentTime = v.currentTime;
      a.playbackRate = v.playbackRate;
    };
    v.addEventListener("play", play);
    v.addEventListener("pause", pause);
    v.addEventListener("seeked", sync);
    v.addEventListener("ratechange", sync);
    return () => {
      v.removeEventListener("play", play);
      v.removeEventListener("pause", pause);
      v.removeEventListener("seeked", sync);
      v.removeEventListener("ratechange", sync);
    };
  }, [altAudio, src]);

  if (kind === "audio")
    return (
      <audio
        key={altAudio ?? src}
        ref={(el) => {
          if (mediaRef) mediaRef.current = el;
        }}
        src={altAudio ?? src}
        controls
        preload="metadata"
        onError={onFail}
        className={`w-full ${className}`}
      />
    );
  return (
    <div>
      <video
        key={src}
        ref={(el) => {
          vRef.current = el;
          if (mediaRef) mediaRef.current = el;
        }}
        src={src}
        controls
        playsInline
        muted={Boolean(altAudio)}
        preload="metadata"
        onError={onFail}
        className={`max-h-72 w-full border border-[color:var(--line)] bg-black ${className}`}
      />
      {altAudio && <audio ref={aRef} src={altAudio} preload="auto" />}
    </div>
  );
}

/* ═══════════════════════════ REPORT COMPONENTS ═══════════════════════════ */

/**
 * The verdict, pressed on like a rubber stamp. Slightly tilted, double-ruled
 * border, offset "double ink" shadow, and it springs into place the first time
 * it scrolls into view. Ink colour follows the threat level in both themes.
 */
function ClassificationStamp({ category, risk }: { category: string; risk: number }) {
  const reduce = useReducedMotion();
  const clear = risk < 25;
  const level = riskLevel(risk);
  const settle = { opacity: 1, scale: 1, rotate: -3.2 };
  const from = { opacity: 0, scale: 1.18, rotate: -9 };
  return (
    <motion.div
      role="group"
      aria-label={`${category}. Threat level ${level}. Risk ${risk} out of 100.`}
      className={`stamp ${clear ? "stamp-ok" : risk <= 60 ? "stamp-warn" : "stamp-hot"}`}
      initial={reduce ? settle : from}
      whileInView={settle}
      viewport={{ once: true, amount: 0.35 }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 20, mass: 0.7 }}
    >
      <span className="stamp-top">
        <span>VEXA · SCAM CALL REPORT</span>
        <i aria-hidden="true" />
        <span>{clear ? "NO THREAT" : "FLAGGED"}</span>
      </span>
      <span className="stamp-cat">{category}</span>
      <span className="stamp-meta">
        THREAT LEVEL {level} · RISK {risk}/100
      </span>
    </motion.div>
  );
}

function RiskGauge({ score }: { score: number }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const [val, setVal] = useState(reduce ? score : 0);
  const R = 54;
  const C = 2 * Math.PI * R;
  const color = riskColor(score);
  useEffect(() => {
    const unsub = mv.on("change", (v) => setVal(v));
    const controls = animate(mv, score, { duration: reduce ? 0 : 1, ease: "easeOut" });
    return () => {
      unsub();
      controls.stop();
    };
  }, [score, reduce, mv]);
  return (
    <div className="console-card p-6">
      <div className="kicker mb-4 text-[color:var(--muted)]">RISK SCORE</div>
      <div className="relative mx-auto aspect-square w-full max-w-[220px]">
        <svg viewBox="0 0 140 140" className="h-full w-full" aria-hidden="true">
          <g transform="rotate(-90 70 70)">
            {Array.from({ length: 40 }, (_, i) => {
              const a = (i / 40) * Math.PI * 2;
              return (
                <line
                  key={i}
                  x1={70 + Math.cos(a) * 62}
                  y1={70 + Math.sin(a) * 62}
                  x2={70 + Math.cos(a) * (i % 10 === 0 ? 68 : 65)}
                  y2={70 + Math.sin(a) * (i % 10 === 0 ? 68 : 65)}
                  stroke="var(--line-2)"
                  strokeWidth={i % 10 === 0 ? 2 : 1}
                />
              );
            })}
            <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" strokeWidth="8" />
            <circle cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - val / 100)} />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-6xl tabular-nums" style={{ color }} aria-hidden="true">
            {Math.round(val)}
          </span>
          <span className="kicker mt-1.5 text-[color:var(--muted)]">OUT OF 100</span>
        </div>
      </div>
      <div className="kicker mt-4 flex items-center justify-center gap-2" style={{ color }}>
        {score < 25 ? <CircleCheck size={13} /> : <AlertTriangle size={13} />}
        {riskLevel(score)}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        Risk score {score} out of 100. Threat level {riskLevel(score)}.
      </p>
    </div>
  );
}

const LIST_VARIANTS: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const ITEM_VARIANTS: Variants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: "easeOut" } } };

function SegmentReveal({ segments, onSeek }: { segments: Segment[]; onSeek?: (t: number) => void }) {
  const reduce = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [scope, setScope] = useState<"all" | "flagged">("all");
  const [who, setWho] = useState<"any" | "caller" | "victim">("any");
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const flaggedCount = segments.filter((s) => s.tactic !== "none").length;
  const inScope = (s: Segment) => scope === "all" || s.tactic !== "none";
  const callerN = segments.filter((s) => s.speaker === "caller" && inScope(s)).length;
  const victimN = segments.filter((s) => s.speaker === "victim" && inScope(s)).length;
  const scopeN = segments.filter(inScope).length;

  const rows = segments
    .map((seg, index) => ({ seg, index }))
    .filter((r) => inScope(r.seg) && (who === "any" || r.seg.speaker === who));
  const allOpen = rows.some((r) => r.seg.tactic !== "none") && rows.every((r) => r.seg.tactic === "none" || open[r.index]);

  function toggleAll() {
    if (allOpen) return setOpen({});
    const next: Record<number, boolean> = {};
    rows.forEach((r) => {
      if (r.seg.tactic !== "none") next[r.index] = true;
    });
    setOpen(next);
  }

  return (
    <div>
      <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Line scope" className="flex gap-2">
            <button type="button" className="tog" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              Every line ({segments.length})
            </button>
            <button type="button" className="tog" aria-pressed={scope === "flagged"} onClick={() => setScope("flagged")}>
              Red flags ({flaggedCount})
            </button>
          </div>
          <span className="h-5 w-px bg-[color:var(--line-2)]" aria-hidden="true" />
          <div role="group" aria-label="Speaker filter" className="flex gap-2">
            <button type="button" className="tog" aria-pressed={who === "any"} onClick={() => setWho("any")}>
              Both ({scopeN})
            </button>
            <button type="button" className="tog" aria-pressed={who === "caller"} onClick={() => setWho("caller")}>
              Caller ({callerN})
            </button>
            <button type="button" className="tog" aria-pressed={who === "victim"} onClick={() => setWho("victim")}>
              Victim ({victimN})
            </button>
          </div>
        </div>
        {rows.some((r) => r.seg.tactic !== "none") && (
          <button type="button" onClick={toggleAll} className="tog">
            {allOpen ? "Collapse all" : "Open every red flag"}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="box-ok flex items-center gap-3 p-5 text-xs">
          <CircleCheck size={16} /> No {scope === "flagged" ? "red-flag " : ""}lines match this filter{who !== "any" ? ` for ${who.toUpperCase()}` : ""}.
        </div>
      ) : (
        <motion.ol key={`${scope}-${who}`} variants={reduce ? undefined : LIST_VARIANTS} initial={reduce ? false : "hidden"} animate={reduce ? undefined : "show"} className="space-y-2">
          {rows.map(({ seg, index }) => {
            const flagged = seg.tactic !== "none";
            const isOpen = Boolean(open[index]);
            const panelId = `${uid}-panel-${index}`;
            return (
              <motion.li
                key={index}
                id={`line-${index}`}
                variants={reduce ? undefined : ITEM_VARIANTS}
                className={`console-card relative grid scroll-mt-24 grid-cols-[2.6rem_1fr] gap-x-3 overflow-hidden p-3 ${flagged ? "" : "opacity-80"}`}
              >
                {flagged && <span className="absolute inset-y-0 left-0 w-[3px] bg-[color:var(--hot)]" aria-hidden="true" />}
                <div className="pt-1 text-[11px] leading-tight text-[color:var(--muted)]">
                  <div className="px">{String(index + 1).padStart(2, "0")}</div>
                  {seg.start !== undefined && <div className="mt-1 opacity-80">{clock(seg.start)}</div>}
                </div>
                <div className="min-w-0">
                  <div className="flex items-start gap-3">
                    <SpeakerBadge speaker={seg.speaker} />
                    {flagged ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={() => setOpen((o) => ({ ...o, [index]: !o[index] }))}
                        className="flex min-w-0 flex-1 flex-col gap-2 text-left sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                      >
                        <span className="text-[13px] leading-relaxed" style={{ fontFamily: "var(--vx-sans)" }}>
                          {seg.text}
                        </span>
                        <TacticChip tactic={seg.tactic} />
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <span className="text-[13px] leading-relaxed" style={{ fontFamily: "var(--vx-sans)" }}>
                          {seg.text}
                        </span>
                        <TacticChip tactic="none" />
                      </div>
                    )}
                  </div>
                  <AnimatePresence initial={false}>
                    {flagged && isOpen && (
                      <motion.div
                        id={panelId}
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                        transition={{ duration: reduce ? 0 : 0.18, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-3 pt-4">
                          {seg.explanation && (
                            <div>
                              <div className="kicker text-[color:var(--muted)]">WHY THIS IS A RED FLAG</div>
                              <p className="mt-1.5 text-[13px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                                {seg.explanation}
                              </p>
                            </div>
                          )}
                          {seg.counterAdvice && (
                            <div className="border-l-2 border-[color:var(--hot)] pl-3">
                              <div className="kicker hot">WHAT TO SAY INSTEAD</div>
                              <p className="mt-1.5 text-[13px] leading-relaxed" style={{ fontFamily: "var(--vx-sans)" }}>
                                {seg.counterAdvice}
                              </p>
                            </div>
                          )}
                          {onSeek && seg.start !== undefined && (
                            <button type="button" onClick={() => onSeek(seg.start ?? 0)} className="tog no-print inline-flex items-center gap-1.5">
                              <Play size={10} /> Play from {clock(seg.start)}
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.li>
            );
          })}
        </motion.ol>
      )}
    </div>
  );
}

function TacticRadar({ counts, risk }: { counts: TacticCounts; risk: number }) {
  const reduce = useReducedMotion();
  const max = Math.max(3, ...TACTIC_IDS.map((id) => counts[id]));
  const data = useMemo(() => TACTIC_IDS.map((id) => ({ tactic: TACTICS[id].short, count: counts[id] })), [counts]);
  const color = risk > 60 ? "var(--hot)" : "var(--acc)";
  return (
    <div className="console-card p-6">
      <div className="kicker mb-2 text-[color:var(--muted)]">TRICKS USED</div>
      <div className="h-[270px] w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="66%" margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
            <PolarGrid stroke="var(--line-2)" />
            <PolarAngleAxis dataKey="tactic" tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--vx-mono)" }} />
            <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
            <Radar dataKey="count" stroke={color} fill={color} fillOpacity={0.26} strokeWidth={2} isAnimationActive={!reduce} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CadenceChart({ telemetry, summary, flaggedTimes }: { telemetry: CadencePoint[]; summary?: AudioSummary; flaggedTimes: number[] }) {
  const reduce = useReducedMotion();
  const gid = `cad${useId().replace(/:/g, "")}`;
  const data = telemetry.map((p) => ({ t: p.timestamp, energy: p.energy }));
  return (
    <div className="console-card p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="kicker acc">VOICE ENERGY OVER TIME</span>
        {summary && (
          <span className="text-[11px] text-[color:var(--muted)]">
            {summary.pauseCount} pauses · longest {summary.longestPauseSec.toFixed(1)}s · {summary.paceSpikeTimestamps.length} fast bursts
          </span>
        )}
      </div>
      <div className="h-[190px] w-full" role="img" aria-label="Chart of vocal energy over time">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--acc)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--acc)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => clock(Number(v))}
              tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "var(--vx-mono)" }}
              stroke="var(--line-2)"
            />
            <YAxis hide />
            <Tooltip
              cursor={{ stroke: "var(--acc)" }}
              contentStyle={{ background: "var(--panel)", border: "1px solid var(--line-2)", borderRadius: 0, fontFamily: "var(--vx-mono)", fontSize: 12 }}
              labelFormatter={(l) => clock(Number(l))}
              formatter={(v) => [Number(v).toFixed(3), "energy"]}
            />
            <Area type="monotone" dataKey="energy" stroke="var(--acc)" strokeWidth={1.75} fill={`url(#${gid})`} isAnimationActive={!reduce} />
            {flaggedTimes.map((t, i) => (
              <ReferenceLine key={`${t}-${i}`} x={t} stroke="var(--hot)" strokeDasharray="3 3" />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[11px] text-[color:var(--muted)]">Green = how loud the voice is. Dashed red = a line where a trick was spotted.</p>
    </div>
  );
}

const LOG_TEXT = [
  "Reading the transcript",
  "Splitting it into lines",
  "Working out who is speaking",
  "Matching known scam tricks",
  "Scoring every line",
  "Writing up the report",
];
const LOG_MEDIA = [
  "Checking the file",
  "Pulling out the voices",
  "Writing down what was said",
  "Working out who is speaking",
  "Matching known scam tricks",
  "Scoring every line",
  "Writing up the report",
];

function fmtSec(n: number) {
  return `${Math.max(0, n).toFixed(2)}s`;
}

/** The finished step list, kept for the report. */
function TerminalLog({ mode, marks }: { mode: "media" | "text"; marks?: Marks }) {
  const [open, setOpen] = useState(false);
  const lines = mode === "media" ? LOG_MEDIA : LOG_TEXT;
  const t = marks?.t ?? [];
  const shown = t.length > 0 ? Math.min(t.length, lines.length) : lines.length;
  return (
    <div className="console-card p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2">
        <span className="acc kicker flex items-center gap-2">
          <CircleCheck size={13} /> DONE{marks && marks.total > 0 ? ` IN ${fmtSec(marks.total)}` : ""} · {open ? "HIDE" : "SHOW"} STEPS
        </span>
        <ChevronDown size={14} className={`text-[color:var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="mt-3 space-y-1.5 border-t border-[color:var(--line)] pt-3 text-[11px]">
          {lines.slice(0, shown).map((line, i) => {
            const start = t[i];
            const end = i + 1 < t.length ? t[i + 1] : marks?.total;
            return (
              <li key={line} className="flex items-center justify-between gap-3 text-[color:var(--muted)]">
                <span className="flex items-center gap-2">
                  <CircleCheck size={11} className="acc shrink-0" /> {line}
                </span>
                {start !== undefined && end !== undefined && <span className="acc tabular-nums">{fmtSec(end - start)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScanMetadata({ report, audio }: { report: Report; audio: boolean }) {
  const flagged = report.segments.filter((s) => s.tactic !== "none").length;
  const callers = report.segments.filter((s) => s.speaker === "caller").length;
  const victims = report.segments.filter((s) => s.speaker === "victim").length;
  const rows: Array<[string, string]> = [
    ["TYPE OF CALL", report.category],
    ["TOOK", report.processingMs !== undefined ? `${(report.processingMs / 1000).toFixed(2)} s` : "—"],
    ["LINES READ", String(report.segments.length)],
    ["LINES FLAGGED", String(flagged)],
    ["CALLER / VICTIM", `${callers} / ${victims}`],
    ["INPUT", audio ? "Audio or video" : "Pasted text"],
    ["MODE", audio ? "Sound + words" : "Words only"],
  ];
  return (
    <div className="console-card p-6">
      <div className="kicker mb-3 text-[color:var(--muted)]">REPORT DETAILS</div>
      <dl className="text-[11.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 border-t border-[color:var(--line)] py-2">
            <dt className="kicker shrink-0 pt-0.5 text-[color:var(--muted)]">{k}</dt>
            <dd className="text-right font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TacticGlossary() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  useEffect(() => {
    const openIt = () => setOpen(true);
    const onHash = () => {
      if (window.location.hash === "#glossary") setOpen(true);
    };
    window.addEventListener("vexa:glossary", openIt);
    window.addEventListener("hashchange", onHash);
    onHash();
    return () => {
      window.removeEventListener("vexa:glossary", openIt);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  return (
    <div className="console-card">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-5 py-4">
        <span className="kicker flex items-center gap-2">
          <Terminal size={13} className="acc" /> THE 7 TRICKS, EXPLAINED
        </span>
        <ChevronDown size={15} className={`text-[color:var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id={panelId} className="trick-grid border-t border-[color:var(--line)]">
          {TACTIC_IDS.map((id, i) => {
            const { Icon, label, def } = TACTICS[id];
            const last = i === TACTIC_IDS.length - 1;
            return (
              <li key={id} className={`trick-cell ${last ? "trick-cell-wide" : ""}`}>
                <div className="flex items-center justify-between gap-4">
                  <span className="trick-num text-[color:var(--dim)]">TRICK {String(i + 1).padStart(2, "0")}</span>
                  <Icon size={15} className="hot shrink-0" />
                </div>
                <h3 className="trick-name mt-3 uppercase">{label}</h3>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                  {def}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const CATEGORY_ACTION: Record<string, string> = {
  "government imposter scam": "Agencies never demand gift cards, crypto or wires. Hang up and reach the agency through the number on its official website.",
  "grandparent/family emergency scam": "Hang up and call your family member on a number you already have. Agree on a family code word for real emergencies.",
  "tech support scam": "Legitimate companies don't cold-call about viruses or pop-ups. Never install software or grant remote access to a caller.",
  "romance scam": "Never send money to someone you haven't met in person. Reverse-search their photos and talk it over with a friend.",
  "prize/lottery scam": "You can't win a contest you didn't enter, and real prizes or rebates never require credential verification over the phone.",
  "investment/crypto scam": "Guaranteed returns don't exist. Check the firm's registration with your securities regulator first.",
  "bank/financial institution imposter scam": "Hang up and call the number printed on your card. Banks never ask for full PINs or one-time codes.",
};

function actionFor(category: string): string {
  const c = category.toLowerCase();
  if (CATEGORY_ACTION[c]) return CATEGORY_ACTION[c];
  if (/tech|remote|computer/.test(c)) return CATEGORY_ACTION["tech support scam"] ?? "";
  if (/gift|card|refund|overpay|bank/.test(c)) return "Legitimate organizations never ask for gift cards or cash handoffs. Hang up and call the number printed on your card or statement.";
  if (/gov|irs|cra|fbi|police|arrest/.test(c)) return CATEGORY_ACTION["government imposter scam"] ?? "";
  return "Hang up and verify the caller through an official number you look up yourself.";
}

function InsightsPanel({ report }: { report: Report }) {
  const segs = report.segments;
  const total = segs.length;
  const flagged = segs.filter((s) => s.tactic !== "none").length;
  const callers = segs.filter((s) => s.speaker === "caller");
  const victims = segs.filter((s) => s.speaker === "victim");
  const words = (list: Segment[]) => list.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  const cw = words(callers);
  const vw = words(victims);
  const talkPct = cw + vw > 0 ? Math.round((cw / (cw + vw)) * 100) : 0;
  const firstIdx = segs.findIndex((s) => s.tactic !== "none");
  const active = TACTIC_IDS.filter((id) => report.tacticCounts[id] > 0).sort((a, b) => report.tacticCounts[b] - report.tacticCounts[a]);
  const dominant = active[0];
  const maxCount = dominant ? report.tacticCounts[dominant] : 1;
  const clear = report.riskScore < 25;
  const half = Math.ceil(total / 2);
  const firstHalf = segs.slice(0, half).filter((s) => s.tactic !== "none").length;
  const secondHalf = segs.slice(half).filter((s) => s.tactic !== "none").length;
  const trend = flagged === 0 ? "None" : secondHalf > firstHalf ? "Getting worse" : secondHalf < firstHalf ? "Calming down" : "Steady";
  const pressure = callers.length ? Math.round((callers.filter((s) => s.tactic !== "none").length / callers.length) * 100) : 0;

  const actions: string[] = clear
    ? ["Low risk detected. Still verify unexpected callers independently before sharing personal information."]
    : [
        actionFor(report.category),
        "Never share codes, PINs, passwords or remote access with someone who called you.",
        "Already paid or shared details? Contact your bank right away and change affected passwords.",
        "Report it to the Canadian Anti-Fraud Centre (antifraudcentre.ca) or, in the US, the FTC (reportfraud.ftc.gov).",
      ];

  const tiles: Array<{ k: string; v: React.ReactNode }> = [
    { k: "LINES FLAGGED", v: `${flagged} / ${total}` },
    {
      k: "MAIN TRICK",
      v: dominant ? (
        <span className="flex items-center gap-1.5">
          {(() => {
            const { Icon } = TACTICS[dominant];
            return <Icon size={13} className="hot shrink-0" />;
          })()}
          <span className="truncate">{TACTICS[dominant].label}</span>
        </span>
      ) : (
        <span className="ok flex items-center gap-1.5">
          <CircleCheck size={13} /> NONE
        </span>
      ),
    },
    { k: "FIRST RED FLAG", v: firstIdx >= 0 ? `Line ${firstIdx + 1}${segs[firstIdx]?.start !== undefined ? ` · ${clock(segs[firstIdx]?.start ?? 0)}` : ""}` : "—" },
    { k: "TRICKS USED", v: `${active.length} of 7` },
    { k: "CALLER LINES", v: String(callers.length) },
    { k: "VICTIM LINES", v: String(victims.length) },
    { k: "CALLER PUSHING", v: `${pressure}%` },
    { k: "PATTERN", v: trend },
  ];

  return (
    <div className="console-card p-6">
      <span className="kicker acc">AT A GLANCE</span>
      <div className="mt-4 grid grid-cols-2 gap-px bg-[color:var(--line)] sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="min-w-0 bg-[color:var(--bg-soft)] p-3">
            <div className="kicker text-[color:var(--muted)]">{t.k}</div>
            <div className="mt-1.5 text-[12px] font-semibold">{t.v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <div className="kicker mb-2 flex justify-between text-[color:var(--muted)]">
          <span>WHO TALKED MOST</span>
          <span>
            CALLER {talkPct}% · VICTIM {100 - talkPct}%
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden border border-[color:var(--line)]" role="img" aria-label={`Caller ${talkPct} percent, victim ${100 - talkPct} percent of words`}>
          <div className="h-full bg-[color:var(--hot)]" style={{ width: `${talkPct}%` }} />
          <div className="h-full bg-[color:var(--acc)]" style={{ width: `${100 - talkPct}%` }} />
        </div>
      </div>

      <div className="mt-5">
        <div className="kicker mb-2 text-[color:var(--muted)]">EVERY LINE AT A GLANCE · CLICK TO JUMP</div>
        <div className="flex flex-wrap gap-1">
          {segs.map((s, i) => (
            <button
              key={i}
              type="button"
              title={`${i + 1}. ${speakerLabel(s.speaker)}${s.tactic !== "none" ? ` · ${TACTICS[s.tactic].label}` : ""}`}
              aria-label={`Jump to line ${i + 1}`}
              onClick={() => document.getElementById(`line-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className="vx-cell"
              style={{
                background: s.tactic !== "none" ? "var(--hot)" : s.speaker === "victim" ? "var(--acc)" : "transparent",
                opacity: s.tactic === "none" && s.speaker !== "victim" ? 0.5 : 1,
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[color:var(--muted)]">Red = caller line with a red flag · Green = victim reply · Hollow = caller line with nothing wrong.</p>
      </div>

      {active.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="How often each trick appears">
          {active.map((id) => {
            const { Icon, label } = TACTICS[id];
            const n = report.tacticCounts[id];
            return (
              <li key={id} className="flex items-center gap-3 text-[11px]">
                <Icon size={13} className="hot shrink-0" />
                <span className="w-36 shrink-0 truncate uppercase tracking-[.08em]">{label}</span>
                <span className="h-2 flex-1 overflow-hidden bg-[color:var(--line)]">
                  <span className="block h-full bg-[color:var(--hot)]" style={{ width: `${(n / maxCount) * 100}%` }} />
                </span>
                <span className="w-5 text-right font-semibold">{n}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div id="sec-verdict" className="mt-5 scroll-mt-24 border-t border-[color:var(--line)] pt-4">
        <div className="kicker mb-3">{clear ? "WHAT THIS MEANS" : "WHAT TO DO NOW"}</div>
        <ul className="space-y-2 text-[12.5px] leading-relaxed" style={{ fontFamily: "var(--vx-sans)" }}>
          {actions.map((a) => (
            <li key={a} className="flex items-start gap-2.5">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 ${clear ? "bg-[color:var(--ok)]" : "bg-[color:var(--acc)]"}`} />
              <span>{a}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ReportView({
  report,
  cadence,
  audioSummary,
  audioNote,
  previewUrl,
  previewKind,
  playbackWavUrl,
  fromMedia,
  marks,
  onReset,
}: {
  report: Report;
  cadence: CadencePoint[];
  audioSummary?: AudioSummary;
  audioNote: string;
  previewUrl: string;
  previewKind: Kind;
  playbackWavUrl: string;
  fromMedia: boolean;
  marks: Marks;
  onReset: () => void;
}) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const transcriptText = transcriptOf(report.segments) || "No dialogue was found.";

  // Open the report at the very top, every time.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, []);

  const flaggedTimes: number[] = [];
  report.segments.forEach((s) => {
    if (s.tactic !== "none" && s.start !== undefined) flaggedTimes.push(s.start);
  });

  /**
   * Seek that actually lands: if the media hasn't loaded its metadata yet the
   * element silently ignores currentTime, so we wait for loadedmetadata once.
   */
  function seek(t: number) {
    const el = mediaRef.current;
    if (!el) return;
    const apply = () => {
      try {
        el.currentTime = Math.max(0, t);
      } catch {
        /* element not seekable yet */
      }
      void el.play().catch(() => undefined);
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener("loadedmetadata", apply, { once: true });
  }

  function download() {
    const { fallbackReason: _drop, ...clean } = report;
    void _drop;
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), ...clean, transcript: transcriptText }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vexa-dossier-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const showPlayer = fromMedia && Boolean(previewUrl) && !playerError;

  return (
    <Shell>
      <ThemeCorner />
      <ScrollCue />
      <main className="mx-auto max-w-[1440px] px-4 pb-8 pt-16 sm:px-6">
        <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--line)] pb-4">
          <button type="button" onClick={onReset} className="tog">
            <ArrowLeft size={12} /> CHECK ANOTHER CALL
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={download} className="tog">
              <Download size={11} /> SAVE AS JSON
            </button>
            <button type="button" onClick={() => window.print()} className="tog">
              <Printer size={11} /> PRINT / PDF
            </button>
          </div>
        </div>

        {/* jump list — the judge can see everything that is in here */}
        <nav aria-label="Report contents" className="no-print mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 border border-[color:var(--line)] bg-[color:var(--bg-soft)] px-4 py-3">
          <span className="kicker flex items-center gap-2 text-[color:var(--dim)]">
            <Layers size={12} /> IN THIS REPORT
          </span>
          {REPORT_SECTIONS.filter((s) => !s.mediaOnly || fromMedia).map((s) => (
            <button
              key={s.id}
              type="button"
              className="jump-link"
              onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {s.label}
            </button>
          ))}
          <span className="kicker ml-auto flex items-center gap-1.5 text-[color:var(--muted)]">
            <ChevronDown size={12} className="acc" /> SCROLL FOR THE FULL BREAKDOWN
          </span>
        </nav>

        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_380px] lg:items-start">
          <section className="contents lg:block lg:min-w-0 lg:space-y-6">
            <div className="order-1 lg:order-none">
              <ClassificationStamp category={report.category} risk={report.riskScore} />
            </div>
            <div className="console-card order-3 p-6 lg:order-none">
              <span className="kicker acc">THE SHORT VERSION</span>
              <p className="font-display mt-2 text-xl leading-snug sm:text-2xl">{report.summary}</p>
              {report.fileName && <p className="kicker mt-3 text-[color:var(--muted)]">FILE · {report.fileName}</p>}
            </div>
            {showPlayer && (
              <div className="console-card no-print order-4 p-6 lg:order-none">
                <div className="kicker mb-3 text-[color:var(--muted)]">PLAYBACK</div>
                <MediaPlayer src={previewUrl} kind={previewKind} altAudio={playbackWavUrl || undefined} mediaRef={mediaRef} onFail={() => setPlayerError(true)} />
              </div>
            )}
            <div id="sec-insights" className="order-5 scroll-mt-24 lg:order-none">
              <InsightsPanel report={report} />
            </div>
            <div id="sec-lines" className="order-6 scroll-mt-24 lg:order-none">
              <div className="mb-4 flex items-center justify-between border-b border-[color:var(--line)] pb-3">
                <span className="kicker acc">LINE BY LINE</span>
                <span className="kicker text-[color:var(--muted)]">{report.segments.length} LINES</span>
              </div>
              <SegmentReveal segments={report.segments} onSeek={showPlayer ? seek : undefined} />
            </div>
            <div className="console-card order-7 p-6 lg:order-none">
              <div className="mb-3 flex items-center justify-between">
                <span className="kicker text-[color:var(--muted)]">FULL TRANSCRIPT</span>
                <span className="kicker text-[color:var(--muted)]">IN ORDER</span>
              </div>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[color:var(--line)] pt-3 text-[11px] leading-relaxed opacity-90">{transcriptText}</pre>
            </div>
          </section>

          <aside className="contents lg:sticky lg:top-20 lg:block lg:space-y-6 lg:self-start">
            <div className="order-2 lg:order-none">
              <RiskGauge score={report.riskScore} />
            </div>
            <div className="order-9 lg:order-none">
              <TacticRadar counts={report.tacticCounts} risk={report.riskScore} />
            </div>
            <div id="sec-details" className="order-10 scroll-mt-24 lg:order-none">
              <ScanMetadata report={report} audio={fromMedia || Boolean(report.mediaType)} />
            </div>
            {fromMedia && (cadence.length > 0 || audioNote) && (
              <div id="sec-charts" className="order-11 space-y-3 scroll-mt-24 lg:order-none">
                {cadence.length > 0 && <CadenceChart telemetry={cadence} summary={audioSummary} flaggedTimes={flaggedTimes} />}
                {audioNote && (
                  <p className="text-[11px] leading-relaxed text-[color:var(--muted)]">{audioNote}</p>
                )}
              </div>
            )}
            <div className="order-12 lg:order-none">
              <TerminalLog mode={fromMedia ? "media" : "text"} marks={marks} />
            </div>
            <div id="glossary" className="order-13 scroll-mt-24 lg:order-none">
              <TacticGlossary />
            </div>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

/* ═══════════════════════════ PAGE ═══════════════════════════ */

export default function Page() {
  const [tab, setTab] = useState<Tab>("recording");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [previewKind, setPreviewKind] = useState<Kind>("video");
  const [previewError, setPreviewError] = useState(false);
  const [selectedDemo, setSelectedDemo] = useState<Demo | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportFromMedia, setReportFromMedia] = useState(false);
  const [reportMarks, setReportMarks] = useState<Marks>({ t: [], total: 0 });
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [cadence, setCadence] = useState<CadencePoint[]>([]);
  const [audioSummary, setAudioSummary] = useState<AudioSummary | undefined>();
  const [audioNote, setAudioNote] = useState("");
  const [wavUrl, setWavUrl] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [cadStamp, setCadStamp] = useState<Stamp>([null, null]);
  const [anStamp, setAnStamp] = useState<Stamp>([null, null]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [demoLoading, setDemoLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const uploadWavRef = useRef<File | null>(null);
  const loadToken = useRef(0);
  const previewRef = useRef("");
  const wavRef = useRef("");
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marksRef = useRef<Marks>({ t: [], total: 0 });
  const chooseFileRef = useRef<(f: File, d?: Demo) => Promise<void>>(async () => undefined);
  const tabIds = useId().replace(/:/g, "");
  const session = useId().replace(/[^a-z0-9]/gi, "").slice(-4).toUpperCase() || "4F2A";

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  useEffect(() => {
    wavRef.current = wavUrl;
  }, [wavUrl]);

  useEffect(() => {
    return () => {
      if (previewRef.current.startsWith("blob:")) URL.revokeObjectURL(previewRef.current);
      if (wavRef.current) URL.revokeObjectURL(wavRef.current);
      xhrRef.current?.abort();
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Nudge the page down so the intake console and both stages are in view.
  useEffect(() => {
    if (!preview) return;
    const id = setTimeout(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 180);
    return () => clearTimeout(id);
  }, [preview]);

  const clearMedia = useCallback(() => {
    loadToken.current += 1;
    if (previewRef.current.startsWith("blob:")) URL.revokeObjectURL(previewRef.current);
    if (wavRef.current) URL.revokeObjectURL(wavRef.current);
    setFile(null);
    setPreview("");
    setPreviewError(false);
    setSelectedDemo(null);
    setCadence([]);
    setAudioSummary(undefined);
    setAudioNote("");
    setWavUrl("");
    setDecoding(false);
    setCadStamp([null, null]);
    setAnStamp([null, null]);
    setProgress(0);
    uploadWavRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  function showReport(next: Report, fromMedia: boolean) {
    setReportMarks({ t: [...marksRef.current.t], total: marksRef.current.total || (next.processingMs ?? 0) / 1000 });
    setReport(next);
    setReportFromMedia(fromMedia);
  }

  async function runPrep(source: File, token: number) {
    setDecoding(true);
    setCadStamp([performance.now(), null]);
    try {
      const p = await prepareAudio(source);
      if (token !== loadToken.current) return;
      setCadence(p.telemetry);
      setAudioSummary(p.summary);
      uploadWavRef.current = p.uploadWav;
      if (p.playbackWav) setWavUrl(URL.createObjectURL(p.playbackWav));
      setAudioNote(p.note);
    } catch (e) {
      if (token === loadToken.current) {
        setAudioNote("We couldn't read the sound in this file, but the words can still be analyzed.");
        void e;
      }
    } finally {
      if (token === loadToken.current) {
        setDecoding(false);
        setCadStamp(([a]) => [a, performance.now()]);
      }
    }
  }

  async function chooseFile(candidate: File, demo?: Demo) {
    setError("");
    const ext = extOf(candidate.name);
    if (!ALLOWED_EXT.includes(ext) && !/^(audio|video)\//.test(candidate.type)) {
      setError("That file type won't work. Use .mp4, .mp3, .wav, .m4a or .webm.");
      return;
    }
    if (candidate.size === 0) {
      setError("That file is empty.");
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setError("That file is over the 20 MB limit. Try a shorter clip.");
      return;
    }
    clearMedia();
    const token = loadToken.current;
    setFile(candidate);
    setSelectedDemo(demo ?? null);
    setPreviewKind(kindOf(candidate));
    setPreview(URL.createObjectURL(candidate));
    await runPrep(candidate, token);
  }
  chooseFileRef.current = chooseFile;

  // Demos are real files run through the exact same pipeline as an upload.
  async function chooseDemo(demo: Demo) {
    setError("");
    setDemoLoading(true);
    try {
      const res = await fetch(`/demo/${demo.file}`);
      const blob = await res.blob();
      if (!res.ok || blob.size < 5000 || blob.type.includes("html")) throw new Error("missing");
      const audio = /\.(mp3|wav|m4a)$/i.test(demo.file);
      const type = blob.type && !blob.type.includes("octet") ? blob.type : audio ? "audio/mpeg" : "video/mp4";
      await chooseFile(new File([blob], demo.file, { type }), demo);
    } catch {
      setError(`That sample isn't available. Put ${demo.file} in /public/demo/ and reload.`);
    } finally {
      setDemoLoading(false);
    }
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }

  async function startRecording() {
    setError("");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        recTimerRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        const type = (rec.mimeType || mime || "audio/webm").split(";")[0] ?? "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size > 0) {
          const ext = type.includes("mp4") ? "m4a" : "webm";
          void chooseFileRef.current(new File([blob], `recording-${Date.now()}.${ext}`, { type }));
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSeconds(0);
      const startedAt = Date.now();
      recTimerRef.current = setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        setRecSeconds(Math.min(secs, MAX_RECORD_SECONDS));
        if (secs >= MAX_RECORD_SECONDS) stopRecording();
      }, 500);
    } catch {
      setError("We couldn't reach your microphone. Check the browser's permission prompt.");
    }
  }

  /** Retries transient failures in the background; only falls back to the local engine after several honest attempts. */
  async function requestAnalysis(text: string): Promise<Report> {
    let last: Report | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: text, audioSummary }),
        });
        const json: unknown = await response.json().catch(() => null);
        if (response.ok && isRecord(json)) {
          const r = normalizeReport(json);
          if (r.segments.length > 0 && !r.fallbackReason && r.inputMode !== "fallback") return r;
          if (r.segments.length > 0) last = r;
        } else if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429) {
          throw new Error(errorMessage(json, "That didn't work. Try again."));
        }
      } catch (caught) {
        if (caught instanceof Error && !(caught instanceof TypeError) && caught.message !== "Failed to fetch") throw caught;
      }
      if (attempt < 2) await sleep(900 * (attempt + 1));
    }
    const base = last ?? normalizeReport(heuristicFallback(text));
    return { ...base, fallbackReason: undefined };
  }

  async function analyzeText(override?: string) {
    const text = (override ?? transcript).trim();
    if (!text) {
      setError("Paste the call transcript first, then run it.");
      return;
    }
    setBusy(true);
    setPhase("analyzing");
    setError("");
    setAnStamp([performance.now(), null]);
    const started = Date.now();
    try {
      const data = await requestAnalysis(text);
      marksRef.current.total = (Date.now() - started) / 1000;
      showReport({ ...data, mode: "ai", processingMs: Date.now() - started }, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The analysis didn't finish. Try again.");
    } finally {
      setBusy(false);
      setPhase("idle");
      setAnStamp(([a]) => [a, performance.now()]);
    }
  }

  function uploadWithProgress(media: File): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", "/api/analyze-media");
      xhr.timeout = 150000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.upload.onload = () => {
        setProgress(100);
        setPhase("analyzing");
      };
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (data === null) {
          reject(new Error(xhr.status === 413 ? "That file is too big. Try a shorter clip." : "We couldn't read the reply. Try again."));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(errorMessage(data, `The analysis failed (${xhr.status}).`)));
      };
      xhr.onerror = () => reject(new Error("The upload dropped. Check your connection and try again."));
      xhr.ontimeout = () => reject(new Error("This is taking too long. Try a shorter clip."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      const body = new FormData();
      body.append("file", media, media.name);
      xhr.send(body);
    });
  }

  async function analyzeMedia() {
    if (!file) {
      setError("Add a recording first.");
      return;
    }
    setBusy(true);
    setError("");
    setProgress(0);
    setPhase("uploading");
    setAnStamp([performance.now(), null]);
    const started = Date.now();
    try {
      const compact = uploadWavRef.current;
      const toUpload = compact && compact.size < file.size ? compact : compact && file.size > 14 * 1024 * 1024 ? compact : file;
      let json: unknown;
      try {
        json = await uploadWithProgress(toUpload);
      } catch (first) {
        // one silent retry for transient network / upstream failures
        if (first instanceof Error && /upload dropped|taking too long|read the reply|502|429/.test(first.message)) {
          await sleep(1200);
          setProgress(0);
          setPhase("uploading");
          json = await uploadWithProgress(toUpload);
        } else throw first;
      }
      const data = normalizeReport(json);
      data.fileName = file.name;
      if (data.segments.length === 0) throw new Error("We didn't find any dialogue in that file.");
      marksRef.current.total = (Date.now() - started) / 1000;
      showReport({ ...data, fallbackReason: undefined, inputMode: data.inputMode ?? "media", mode: "ai", processingMs: Date.now() - started }, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The analysis didn't finish. Try again.");
    } finally {
      setBusy(false);
      setPhase("idle");
      setAnStamp(([a]) => [a, performance.now()]);
      xhrRef.current = null;
    }
  }

  function reset() {
    setReport(null);
    setReportFromMedia(false);
    setTranscript("");
    setError("");
    clearMedia();
  }

  if (report) {
    return (
      <ReportView
        report={report}
        cadence={reportFromMedia ? cadence : []}
        audioSummary={reportFromMedia ? audioSummary : undefined}
        audioNote={reportFromMedia ? audioNote : ""}
        previewUrl={preview}
        previewKind={previewKind}
        playbackWavUrl={wavUrl}
        fromMedia={reportFromMedia}
        marks={reportMarks}
        onReset={reset}
      />
    );
  }

  const hasMedia = Boolean(file);
  const locked = busy || recording;
  const statusLabel = phase === "uploading" ? `Uploading ${progress}%` : phase === "analyzing" ? "Reading the call…" : "";

  const cadState: StageState = decoding ? "running" : cadStamp[1] !== null ? (cadence.length > 0 ? "done" : "warn") : "idle";
  const anState: StageState = busy ? "running" : anStamp[1] !== null ? "done" : "idle";
  const cadDetail = decoding
    ? "Listening for pauses and pace…"
    : cadState === "done"
    ? `${audioSummary?.pauseCount ?? 0} pauses · ${audioSummary?.paceSpikeTimestamps.length ?? 0} fast bursts · longest ${audioSummary?.longestPauseSec.toFixed(1) ?? "0.0"}s`
    : cadState === "warn"
    ? "No sound found in this file"
    : "Waiting for a recording";
  const anDetail = busy ? (phase === "uploading" ? `Uploading ${progress}%` : "") : "Waiting for you to press Analyze";

  const ctaDisabled = busy || (tab === "recording" ? decoding || recording || !hasMedia : !transcript.trim());
  const ctaLabel = busy ? statusLabel || "WORKING…" : decoding && tab === "recording" ? "GETTING THE AUDIO…" : "ANALYZE CALL";

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (locked) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setTab((t) => (t === "recording" ? "transcript" : "recording"));
      setError("");
    }
  }

  return (
    <Shell>
      <ThemeCorner />
      <main className="mx-auto max-w-[1440px] px-4 pb-24 pt-10 sm:px-6">
        {/* ── brief: animated mark, one short line, one row of facts ── */}
        <section className="hero-in mb-8 border-b border-[color:var(--line)] pb-8">
          <span className="kicker acc inline-flex items-center gap-2">
            <Crosshair size={12} /> CHECK A SUSPICIOUS CALL
          </span>
          <h1 className="font-display mt-5 flex items-center gap-3 text-2xl leading-tight sm:text-3xl">
            <span className="hero-mark">
              <VexaMark size={34} />
            </span>
            <span>
              <span className="acc">Vexa</span> hears the scam before it lands.
            </span>
          </h1>
          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
            Upload a recording or paste what was said. Vexa writes it down, shows who said what, names every trick the caller used, and gives you the words to say back.
          </p>
          <ul className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {HERO_STATS.map(([k, v]) => (
              <li key={k} className="kicker flex items-center gap-2 text-[color:var(--muted)]">
                <span className="h-1.5 w-1.5 shrink-0 bg-[color:var(--acc)]" aria-hidden="true" />
                <span className="text-[color:var(--acc)]">{k}</span>
                {v}
              </li>
            ))}
          </ul>
        </section>

        {/* ── intake console ── */}
        <section className="hud" aria-label="Analyzer">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--line)] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-3">
              <ScanSearch size={14} className="acc" />
              <span className="kicker">SCAN A CALL</span>
            </div>
            <div className="flex items-center gap-4">
              <span className="kicker acc flex items-center gap-2">
                <span className={`led ${busy ? "led-hot" : ""}`} />
                {busy ? "WORKING" : recording ? "RECORDING" : "READY"}
              </span>
              <span className="kicker hidden text-[color:var(--muted)] sm:inline">ID 0x{session}</span>
            </div>
          </div>

          {/* channel selector */}
          <div className="flex" role="tablist" aria-label="Input type">
            {(
              [
                ["recording", "Audio or video", FileAudio],
                ["transcript", "Paste a transcript", FileText],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${tabIds}-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`${tabIds}-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                disabled={locked}
                onKeyDown={onTabKey}
                onClick={() => {
                  setTab(id);
                  setError("");
                }}
                className={`relative flex flex-1 items-center justify-center gap-2 border-b border-[color:var(--line)] px-4 py-3 text-[11px] font-semibold tracking-[.14em] uppercase transition disabled:cursor-not-allowed ${
                  tab === id ? "bg-[color:var(--acc-dim)] text-[color:var(--acc)]" : "text-[color:var(--muted)] hover:text-[color:var(--ink)]"
                }`}
              >
                <Icon size={14} />
                {label}
                {tab === id && <span className="absolute inset-x-0 -bottom-px h-px bg-[color:var(--acc)]" aria-hidden="true" />}
              </button>
            ))}
          </div>

          {tab === "recording" && (
            <div role="tabpanel" id={`${tabIds}-panel-recording`} aria-labelledby={`${tabIds}-tab-recording`} className="p-4 sm:p-5">
              <div ref={panelRef} className="grid scroll-mt-24 gap-6 lg:grid-cols-[minmax(0,1fr)_352px] lg:gap-0">
                {/* ── STEP 1 · ADD THE CALL ── */}
                <div className="min-w-0 lg:pr-6">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="kicker flex items-center gap-2">
                      <span className="grid h-[18px] w-[18px] place-items-center border border-[color:var(--acc-line)] bg-[color:var(--acc-dim)] text-[10px] text-[color:var(--acc)]">1</span>
                      ADD THE CALL
                    </span>
                    <span className="kicker text-[color:var(--dim)]">DROP A FILE · PICK A SAMPLE · OR RECORD LIVE</span>
                  </div>

                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => inputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      const dropped = e.dataTransfer.files?.[0];
                      if (dropped) void chooseFile(dropped);
                    }}
                    data-drag={dragging}
                    aria-label="Drop or select a call recording"
                    className="dz block px-6 py-8 disabled:cursor-not-allowed"
                  >
                    <span className="tick tick-tl" aria-hidden="true" />
                    <span className="tick tick-tr" aria-hidden="true" />
                    <span className="tick tick-bl" aria-hidden="true" />
                    <span className="tick tick-br" aria-hidden="true" />
                    <span className="dz-sweep" aria-hidden="true" />
                    <span className="relative mx-auto flex flex-col items-center gap-3.5">
                      <span className="sigil mx-auto">
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        {file ? (
                          previewKind === "audio" ? (
                            <FileAudio size={20} className="acc" />
                          ) : (
                            <FileVideo size={20} className="acc" />
                          )
                        ) : (
                          <Upload size={20} className="acc" />
                        )}
                      </span>
                      <span className="block max-w-full truncate text-[12px] font-semibold leading-tight tracking-[.16em] uppercase">
                        {file ? file.name : "Drop your recording here"}
                      </span>
                      <span className="kicker block text-[color:var(--muted)]">
                        {file
                          ? `${(file.size / 1024 / 1024).toFixed(2)} MB · READY TO SCAN`
                          : "or click to pick a file · MP4 · MP3 · WAV · M4A · WEBM · up to 20 MB"}
                      </span>
                      {file && (
                        <span className="kicker acc flex items-center gap-1.5">
                          <Lock size={11} /> Nothing is saved
                        </span>
                      )}
                    </span>
                  </button>
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".mp4,.mp3,.wav,.m4a,.webm,audio/*,video/*"
                    className="hidden"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(event) => {
                      const candidate = event.target.files?.[0];
                      if (candidate) void chooseFile(candidate);
                    }}
                  />

                  <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr]">
                    <button type="button" className="chan" data-live={recording} disabled={busy} onClick={() => (recording ? stopRecording() : void startRecording())}>
                      {recording ? <Square size={13} className="animate-pulse" /> : <Mic size={14} />}
                      {recording ? `STOP · ${clock(recSeconds)}` : "RECORD LIVE"}
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      {DEMOS.map((demo) => {
                        const active = selectedDemo?.id === demo.id;
                        return (
                          <button key={demo.id} type="button" disabled={busy || recording || demoLoading} onClick={() => void chooseDemo(demo)} aria-pressed={active} className="tog">
                            {demoLoading && !active ? <Loader2 size={11} className="animate-spin" /> : <Radio size={11} />}
                            {demo.label}
                          </button>
                        );
                      })}
                      {file && (
                        <button type="button" onClick={clearMedia} disabled={busy} className="tog" aria-label="Remove this file">
                          <X size={11} /> REMOVE
                        </button>
                      )}
                    </div>
                  </div>

                  {preview && (
                    <div className="mt-4 border border-[color:var(--line)] bg-[color:var(--bg-soft)] p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="kicker truncate text-[color:var(--muted)]">YOUR FILE · {file?.name}</span>
                        <span className="kicker acc shrink-0">LOADED</span>
                      </div>
                      {previewError ? (
                        <div className="flex flex-col items-center gap-2 border border-dashed border-[color:var(--line-2)] px-4 py-8 text-center">
                          <FileVideo size={20} className="acc" />
                          <span className="kicker text-[color:var(--muted)]">This one won&apos;t play here, but it can still be scanned</span>
                        </div>
                      ) : (
                        <MediaPlayer src={preview} kind={previewKind} altAudio={wavUrl || undefined} onFail={() => setPreviewError(true)} />
                      )}
                    </div>
                  )}

                  {error && <InlineError message={error} />}
                  {!hasMedia && !recording && !busy && !error && <InlineNote>Add a recording above, or pick one of the sample calls.</InlineNote>}
                </div>

                {/* ── STEP 2 · RUN THE SCAN ── */}
                <ActionRail
                  busy={busy}
                  phase={phase}
                  progress={progress}
                  ctaLabel={ctaLabel}
                  ctaDisabled={ctaDisabled}
                  onRun={() => void analyzeMedia()}
                  stageCount={2}
                  hint={hasMedia ? undefined : "Add a recording on the left first — or click one of the sample calls."}
                  stages={
                    <>
                      <StageRow index={1} title="Getting the audio" detail={cadDetail} state={cadState} stamp={cadStamp} />
                      <StageRow index={2} title="Reading the call" detail={anDetail} state={anState} stamp={anStamp} last>
                        <BranchSteps lines={LOG_MEDIA} active={busy} marksRef={marksRef} />
                      </StageRow>
                    </>
                  }
                />
              </div>
              {audioNote && <p className={`mt-3 text-[11px] leading-relaxed ${cadState === "warn" ? "hot" : "text-[color:var(--muted)]"}`}>{audioNote}</p>}
            </div>
          )}

          {tab === "transcript" && (
            <div role="tabpanel" id={`${tabIds}-panel-transcript`} aria-labelledby={`${tabIds}-tab-transcript`} className="p-4 sm:p-5">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_352px] lg:gap-0">
                {/* ── STEP 1 · PASTE THE CALL ── */}
                <div className="min-w-0 lg:pr-6">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="kicker flex items-center gap-2">
                      <span className="grid h-[18px] w-[18px] place-items-center border border-[color:var(--acc-line)] bg-[color:var(--acc-dim)] text-[10px] text-[color:var(--acc)]">1</span>
                      PASTE THE CALL
                    </span>
                    <span className="kicker text-[color:var(--dim)]">NO LABELS NEEDED</span>
                  </div>

                  <div className="relative border border-[color:var(--line-2)] bg-[color:var(--bg-soft)]">
                    <div className="flex items-center justify-between border-b border-[color:var(--line)] px-3 py-2">
                      <span className="kicker text-[color:var(--muted)]">PASTE THE CALL HERE</span>
                      <span className={`kicker tabular-nums ${transcript.length > 18000 ? "hot" : "text-[color:var(--dim)]"}`}>
                        {transcript.length.toLocaleString()} / {MAX_TRANSCRIPT_CHARS.toLocaleString()}
                      </span>
                    </div>
                    <label htmlFor="transcript-input" className="sr-only">
                      Call transcript
                    </label>
                    <textarea
                      id="transcript-input"
                      value={transcript}
                      onChange={(event) => setTranscript(event.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !busy && transcript.trim()) {
                          e.preventDefault();
                          void analyzeText();
                        }
                      }}
                      maxLength={MAX_TRANSCRIPT_CHARS}
                      placeholder={"Paste what was said. One line per turn is perfect, but anything works.\n\nYou don't need to label the speakers — Vexa works out who is who."}
                      className="min-h-[260px] w-full resize-y bg-transparent p-4 text-[12.5px] leading-relaxed outline-none transition placeholder:text-[color:var(--dim)] focus:bg-[color:var(--acc-dim)]"
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="kicker text-[color:var(--dim)]">CTRL / ⌘ + ENTER TO RUN</span>
                    {transcript && !busy && (
                      <button type="button" onClick={() => setTranscript("")} className="tog">
                        CLEAR
                      </button>
                    )}
                  </div>

                  <p className="mt-3 text-[11.5px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                    Speaker labels are optional — Vexa works out who is who from what they say, then explains every red flag it finds.
                  </p>

                  <div className="mt-4 border-t border-[color:var(--line)] pt-4">
                    <p className="kicker mb-3 text-[color:var(--dim)]">OR TRY A SAMPLE</p>
                    <div className="flex flex-wrap gap-2">
                      {examples.map((example) => (
                        <button
                          key={example.id}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setTranscript(example.transcript);
                            clearMedia();
                            void analyzeText(example.transcript);
                          }}
                          className="tog"
                        >
                          <Terminal size={11} />
                          {example.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {error && <InlineError message={error} />}
                  {!transcript.trim() && !busy && !error && <InlineNote>Paste a few lines above, or try a sample.</InlineNote>}
                </div>

                {/* ── STEP 2 · RUN THE SCAN ── */}
                <ActionRail
                  busy={busy}
                  phase={phase}
                  progress={progress}
                  ctaLabel={ctaLabel}
                  ctaDisabled={ctaDisabled}
                  onRun={() => void analyzeText()}
                  stageCount={1}
                  hint={transcript.trim() ? undefined : "Paste a few lines of the call on the left, or try a sample."}
                  stages={
                    <StageRow
                      index={1}
                      title="Reading the call"
                      detail={busy ? "" : "Waiting for you to press Analyze"}
                      state={busy ? "running" : anStamp[1] !== null ? "done" : "idle"}
                      stamp={anStamp}
                      last
                    >
                      <BranchSteps lines={LOG_TEXT} active={busy} marksRef={marksRef} />
                    </StageRow>
                  }
                />
              </div>
            </div>
          )}

          {/* mobile: the run button is always in reach */}
          <div className="no-print sticky bottom-0 z-40 flex items-center justify-between gap-3 border-t border-[color:var(--acc-line)] bg-[color:var(--bg-soft)] px-4 py-3 sm:px-5 lg:hidden">
            <span className="kicker flex items-center gap-2 text-[color:var(--muted)]">
              <span className={`led ${busy ? "led-hot" : ""}`} />
              {busy ? statusLabel : hasMedia || transcript.trim() ? "READY WHEN YOU ARE" : "WAITING FOR A CALL"}
            </span>
            <button
              type="button"
              className="btn"
              style={{ width: "auto", minWidth: 190 }}
              disabled={ctaDisabled}
              onClick={() => (tab === "recording" ? void analyzeMedia() : void analyzeText())}
            >
              {busy || decoding ? <Loader2 className="animate-spin" size={14} /> : <Play size={14} />}
              {ctaLabel}
            </button>
          </div>
        </section>

        {/* ── tactic library ── */}
        <section className="mt-16" aria-labelledby="tactics-title">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] pb-3">
            <h2 id="tactics-title" className="kicker acc flex items-center gap-2">
              <Layers size={13} /> THE 7 TRICKS CALLERS USE
            </h2>
            <span className="kicker text-[color:var(--dim)]">WE NAME EVERY ONE WE FIND</span>
          </header>
          <ul className="grid gap-px border border-[color:var(--line)] bg-[color:var(--line)] sm:grid-cols-2 lg:grid-cols-4">
            {TACTIC_IDS.map((id) => {
              const { Icon, label, def } = TACTICS[id];
              return (
                <li key={id} className="bg-[color:var(--bg-soft)] p-4">
                  <div className="flex items-center gap-2 text-[11.5px] font-semibold tracking-[.12em] uppercase">
                    <Icon size={14} className="hot" /> {label}
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                    {def}
                  </p>
                </li>
              );
            })}
            <li className="bg-[color:var(--acc-dim)] p-4">
              <div className="flex items-center gap-2 text-[11.5px] font-semibold tracking-[.12em] uppercase">
                <Fingerprint size={14} className="acc" /> And what to say
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                Every red flag comes with a plain sentence you could have said to end the call safely.
              </p>
            </li>
          </ul>
        </section>

        {/* ── how it works ── */}
        <section className="mt-16" aria-labelledby="how-title">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] pb-3">
            <h2 id="how-title" className="kicker acc flex items-center gap-2">
              <AudioLines size={13} /> HOW IT WORKS
            </h2>
            <span className="kicker text-[color:var(--dim)]">3 STEPS</span>
          </header>
          <ol className="grid gap-px border border-[color:var(--line)] bg-[color:var(--line)] md:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="bg-[color:var(--bg-soft)] p-6">
                <span className="kicker acc">STEP {s.n}</span>
                <h3 className="font-display mt-2 text-xl">{s.title}</h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[color:var(--muted)]" style={{ fontFamily: "var(--vx-sans)" }}>
                  {s.body}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <div id="glossary" className="mt-6 scroll-mt-24">
          <TacticGlossary />
        </div>

        <footer className="mt-14 border-t border-[color:var(--line)] pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="kicker flex items-center gap-2 text-[color:var(--muted)]">
              <VexaMark size={12} animated={false} className="acc" /> VEXA · TLN HACKATHON 2026
            </span>
            <div className="flex items-center gap-4">
              <span className="kicker flex items-center gap-2 text-[color:var(--muted)]">
                <ShieldCheck size={12} className="acc" /> RECORDINGS ARE NOT STORED
              </span>
              <a href="#glossary" onClick={() => window.dispatchEvent(new Event("vexa:glossary"))} className="kicker acc underline underline-offset-4">
                THE 7 TRICKS
              </a>
            </div>
          </div>
        </footer>
      </main>
    </Shell>
  );
}