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
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Clock,
  CreditCard,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Gift,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Mic,
  Moon,
  Play,
  Printer,
  ShieldAlert,
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

/* ═══════════════════════════ CONSTANTS ═══════════════════════════ */

const DEMOS: Demo[] = [
  { id: "utility", label: "Utility Rebate Scam (FTC)", file: "utility-rebate.mp3" },
  { id: "fbi", label: "Debt Arrest Threat (FBI)", file: "fbi-imposter.mp4" },
];

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_RECORD_SECONDS = 120;
const MAX_TRANSCRIPT_CHARS = 20000;
const ALLOWED_EXT = ["mp4", "mp3", "wav", "m4a", "webm"];

const REASON_LABEL: Record<string, string> = {
  http_404: "the analysis endpoint is unavailable",
  http_429: "the AI service is rate-limited (quota reached)",
  timeout: "the AI service timed out",
  auth: "the API key is missing or was rejected",
  http_500: "the AI service had a server error",
  http_502: "the AI service is temporarily unavailable",
  http_503: "the AI service is temporarily unavailable",
  schema_invalid: "the AI response failed validation",
  network: "a network error occurred",
  forced: "fallback mode was forced by configuration",
};

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
  urgency: { label: "Urgency", short: "URGENCY", Icon: Clock, def: "Manufactures a deadline so you act before you can think or verify." },
  authority_impersonation: { label: "False Authority", short: "AUTHORITY", Icon: ShieldAlert, def: "Poses as a government agency, bank, company or lawyer to borrow trust." },
  isolation: { label: "Isolation", short: "ISOLATION", Icon: UserX, def: "Cuts you off from the people who would spot the scam." },
  threat: { label: "Threat", short: "THREAT", Icon: AlertTriangle, def: "Uses fear of arrest, fines, account loss or harm to force compliance." },
  too_good_to_be_true: { label: "Too Good To Be True", short: "TOO GOOD", Icon: Gift, def: "Dangles a prize, refund or guaranteed return to lower your guard." },
  payment_request: { label: "Payment Request", short: "PAYMENT", Icon: CreditCard, def: "Demands money through untraceable channels: gift cards, crypto, wires." },
  personal_info_request: { label: "Info Request", short: "INFO REQ", Icon: KeyRound, def: "Fishes for IDs, passwords, one-time codes or remote access to your device." },
};

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
const riskColor = (s: number) => (s > 60 ? "var(--hot)" : s < 25 ? "var(--ok)" : "var(--acc)");
const speakerLabel = (s: Speaker) => (s === "caller" ? "CALLER" : s === "victim" ? "VICTIM" : "UNKNOWN");

const modeOf = (d: Report): "ai" | "fallback" => (d.inputMode === "fallback" || d.fallbackReason ? "fallback" : (d.mode ?? "ai"));
const reasonText = (reason: string) =>
  REASON_LABEL[reason] ?? (reason.startsWith("http_") ? `the AI service returned an error (${reason.slice(5)})` : reason);

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
    category: asStr(r.category, "Other/Unclear"),
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    throw new Error("server audio extraction unreachable");
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
  if (extracted) note = "Your browser can't decode this file's audio codec, so the audio was extracted server-side (ffmpeg) for playback and cadence.";
  if (m.peak < 0.001) note = "The audio track decoded but is silent. There is no audible speech in this file.";
  const compact = !extracted && source.size > 4 * 1024 * 1024 ? encodeCompactWav(mono, sr, `${base}-compact.wav`) : null;
  return { telemetry: m.telemetry, summary: m.summary, uploadWav: extracted ?? compact, playbackWav: extracted, note };
}

/* ═══════════════════════════ STYLES ═══════════════════════════ */

const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Silkscreen:wght@400;700&display=swap");

.vexa-root{
  --vx-mono:var(--font-jetbrains-mono,"JetBrains Mono"),"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --vx-display:"Silkscreen","Press Start 2P",var(--vx-mono);
  --background:#E3EAE5;--foreground:#0A120D;--muted:rgba(10,18,13,.64);--line:rgba(10,18,13,.30);
  --card:#F3F8F4;--hover:rgba(0,120,80,.09);--grid:rgba(0,90,60,.11);
  --acc:#007A55;--acc-dim:rgba(0,122,85,.13);--hot:#C4271B;--hot-dim:rgba(196,39,27,.12);--ok:#1E7A2C;--ok-dim:rgba(30,122,44,.12);
  position:relative;min-height:100vh;background:var(--background);color:var(--foreground);
  font-family:var(--vx-mono);-webkit-font-smoothing:none;
}
html.dark .vexa-root{
  --background:#040705;--foreground:#D6FFE6;--muted:rgba(214,255,230,.56);--line:rgba(0,255,150,.24);
  --card:rgba(0,255,150,.03);--hover:rgba(0,255,150,.08);--grid:rgba(0,255,150,.06);
  --acc:#00FF9C;--acc-dim:rgba(0,255,156,.11);--hot:#FF4D3D;--hot-dim:rgba(255,77,61,.13);--ok:#8CFF5A;--ok-dim:rgba(140,255,90,.11);
}
.vexa-root *{border-radius:0!important}
.vexa-root .font-display,.vexa-root .px{font-family:var(--vx-display);text-transform:uppercase;letter-spacing:.09em;font-weight:400}
.vexa-root ::selection{background:var(--acc);color:#001a0d}
.vexa-root :focus-visible{outline:2px solid var(--acc);outline-offset:2px}

.acc{color:var(--acc)} .hot{color:var(--hot)} .ok{color:var(--ok)}
.box-acc{border:2px solid var(--acc);background:var(--acc-dim);color:var(--acc)}
.box-hot{border:2px solid var(--hot);background:var(--hot-dim);color:var(--hot)}
.box-ok{border:2px solid var(--ok);background:var(--ok-dim);color:var(--ok)}
.console-card{border:2px solid var(--line);background:var(--card);box-shadow:5px 5px 0 var(--acc-dim)}
.vx-hoverbg:hover{background:var(--hover)}
.btn{display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;border:2px solid var(--acc);
  background:var(--acc);color:#02160c;box-shadow:4px 4px 0 var(--acc-dim);font-family:var(--vx-display);
  text-transform:uppercase;letter-spacing:.1em;font-size:12px;padding:.9rem 1.25rem;transition:transform .08s}
.btn:hover:not(:disabled){transform:translate(-2px,-2px);box-shadow:6px 6px 0 var(--acc-dim)}
.btn:disabled{cursor:not-allowed;background:transparent;color:var(--muted);border-color:var(--line);box-shadow:none}
.tog{border:2px solid var(--line);padding:.3rem .7rem;font-family:var(--vx-display);font-size:10px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--muted);transition:background .08s}
.tog:hover{background:var(--hover);color:var(--foreground)}
.tog[aria-pressed="true"]{border-color:var(--acc);background:var(--acc);color:#02160c}
.vx-topbar{background:var(--background);border-bottom:2px solid var(--line)}
.vx-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:repeating-linear-gradient(0deg,var(--grid) 0,var(--grid) 1px,transparent 1px,transparent 32px),
  repeating-linear-gradient(90deg,var(--grid) 0,var(--grid) 1px,transparent 1px,transparent 32px)}
.vx-content{position:relative;z-index:2}
.vx-beam{position:fixed;left:0;right:0;top:0;height:2px;z-index:1;pointer-events:none;background:var(--acc);opacity:.18;
  animation:vx-beam 7s linear infinite}
@keyframes vx-beam{from{transform:translateY(0)}to{transform:translateY(100vh)}}
.vx-caret{display:inline-block;width:8px;height:12px;margin-left:4px;vertical-align:-2px;background:var(--acc);animation:vx-blink 1s steps(2,start) infinite}
@keyframes vx-blink{to{visibility:hidden}}
.vx-cell{width:14px;height:14px;border:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){.vx-beam{display:none}.vx-caret,.vexa-root .animate-pulse{animation:none}}
@media print{
  .no-print,.vx-grid,.vx-beam{display:none!important}
  html .vexa-root,html.dark .vexa-root{--background:#fff;--foreground:#000;--muted:rgba(0,0,0,.62);--line:rgba(0,0,0,.3);--card:#fff;
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .vx-content{padding-top:0!important}
  .console-card{break-inside:avoid;box-shadow:none!important}
}
`;

/* ═══════════════════════════ BRAND + ATOMS ═══════════════════════════ */

const MARK_PATH = "M8 2H9L16 19L23 2H24A6 6 0 0 1 30 8V24A6 6 0 0 1 24 30H8A6 6 0 0 1 2 24V8A6 6 0 0 1 8 2Z";

function VexaMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" className={className}>
      <path d={MARK_PATH} />
    </svg>
  );
}

function VexaLogo() {
  return (
    <div className="flex items-center gap-2.5">
      <VexaMark size={24} className="acc" />
      <span className="font-display px text-xl">Vexa</span>
    </div>
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
      className="vx-hoverbg border-2 border-[color:var(--line)] p-2 text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function Shell({ children, beam = false }: { children: React.ReactNode; beam?: boolean }) {
  return (
    <div className="vexa-root">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="vx-grid" aria-hidden="true" />
      {beam && <div className="vx-beam" aria-hidden="true" />}
      <div className="vx-content min-h-screen pt-16">{children}</div>
    </div>
  );
}

function TopBar({ label }: { label: string }) {
  return (
    <header className="vx-topbar no-print fixed inset-x-0 top-0 z-50 h-16">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <VexaLogo />
          <span className="px hidden border-l-2 border-[color:var(--line)] pl-3 text-[10px] text-[color:var(--muted)] sm:inline">{label}</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="px hidden items-center gap-2 text-[9px] text-[color:var(--muted)] md:flex">
            <span className="h-2 w-2 bg-[color:var(--acc)]" /> ENGINE ONLINE
            <span className="opacity-40">|</span>
            <Lock size={11} /> EPHEMERAL · NO STORAGE
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div role="alert" className="box-hot mt-4 flex items-start gap-3 p-4 text-xs">
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span className="leading-relaxed">{message}</span>
    </div>
  );
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="box-acc mt-3 flex items-start gap-2.5 p-3 text-[11px] leading-relaxed">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function TacticChip({ tactic }: { tactic: Tactic }) {
  const base = "px inline-flex shrink-0 items-center gap-1.5 self-start px-2 py-1 text-[9px]";
  if (tactic === "none")
    return (
      <span className={`${base} box-ok`}>
        <CircleCheck size={11} /> Clear
      </span>
    );
  const { Icon, label } = TACTICS[tactic];
  return (
    <span className={`${base} box-hot`}>
      <Icon size={11} /> {label}
    </span>
  );
}

function SpeakerBadge({ speaker }: { speaker: Speaker }) {
  const cls = speaker === "caller" ? "box-hot" : speaker === "victim" ? "box-acc" : "border-2 border-[color:var(--line)] text-[color:var(--muted)]";
  return <span className={`px inline-block w-[4.6rem] shrink-0 px-1.5 py-1 text-center text-[9px] ${cls}`}>{speakerLabel(speaker)}</span>;
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
function StageRow({ index, title, detail, state, stamp }: { index: number; title: string; detail: string; state: StageState; stamp: Stamp }) {
  const secs = useElapsed(stamp[0], stamp[1]);
  const tone = state === "done" ? "box-ok" : state === "warn" ? "box-hot" : state === "running" ? "box-acc" : "border-2 border-[color:var(--line)] text-[color:var(--muted)]";
  return (
    <div className={`flex items-center justify-between gap-3 p-3 ${tone}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="px flex h-7 w-7 shrink-0 items-center justify-center border-2 border-current text-[11px]">
          {state === "running" ? <Loader2 size={13} className="animate-spin" /> : index}
        </span>
        <div className="min-w-0">
          <div className="px truncate text-[10px]">{title}</div>
          <div className="mt-0.5 truncate text-[10px] opacity-80">{detail}</div>
        </div>
      </div>
      <span className="px shrink-0 text-base tabular-nums" aria-label="elapsed seconds">
        {stamp[0] === null ? "--.--" : secs.toFixed(2)}
        <span className="text-[10px]">s</span>
      </span>
    </div>
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
        className={`max-h-72 w-full border-2 border-[color:var(--line)] bg-black ${className}`}
      />
      {altAudio && (
        <>
          <audio ref={aRef} src={altAudio} preload="auto" />
          <p className="acc mt-2 text-[10px]">Video is muted because its own audio codec is unsupported here. The extracted audio track plays in sync.</p>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════ REPORT COMPONENTS ═══════════════════════════ */

function ClassificationStamp({ category, risk }: { category: string; risk: number }) {
  const reduce = useReducedMotion();
  const hot = risk > 60;
  return (
    <motion.div
      initial={reduce ? false : { scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.25 }}
      className={`inline-block max-w-full px-5 py-3 uppercase ${hot ? "box-hot" : "box-acc"}`}
    >
      <div className="px text-[9px] tracking-[0.25em] opacity-80">Vexa forensic classification</div>
      <div className="px mt-1 break-words text-sm sm:text-lg">CLASSIFIED: {category}</div>
      <div className="px mt-1 text-[9px] tracking-[0.25em] opacity-80">
        Threat level {riskLevel(risk)} · Risk {risk}/100
      </div>
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
      <div className="px mb-4 text-[10px] text-[color:var(--muted)]">Risk score</div>
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
                  stroke="var(--line)"
                  strokeWidth={i % 10 === 0 ? 2 : 1}
                />
              );
            })}
            <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" strokeWidth="9" />
            <circle cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="9" strokeLinecap="butt" strokeDasharray={C} strokeDashoffset={C * (1 - val / 100)} />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="px text-5xl tabular-nums" style={{ color }} aria-hidden="true">
            {String(Math.round(val)).padStart(2, "0")}
          </span>
          <span className="px mt-1 text-[9px] text-[color:var(--muted)]">/ 100</span>
        </div>
      </div>
      <div className="px mt-4 flex items-center justify-center gap-2 text-xs" style={{ color }}>
        {score < 25 ? <CircleCheck size={14} /> : <AlertTriangle size={14} />}
        {riskLevel(score)}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        Risk score {score} out of 100. Threat level {riskLevel(score)}.
      </p>
    </div>
  );
}

const LIST_VARIANTS: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
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
              All lines ({segments.length})
            </button>
            <button type="button" className="tog" aria-pressed={scope === "flagged"} onClick={() => setScope("flagged")}>
              All flagged ({flaggedCount})
            </button>
          </div>
          <span className="h-5 w-0.5 bg-[color:var(--line)]" aria-hidden="true" />
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
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="box-ok flex items-center gap-3 p-5 text-xs">
          <CircleCheck size={16} /> No {scope === "flagged" ? "flagged " : ""}lines match this filter{who !== "any" ? ` for ${who.toUpperCase()}` : ""}.
        </div>
      ) : (
        <motion.ol
          key={`${scope}-${who}`}
          variants={reduce ? undefined : LIST_VARIANTS}
          initial={reduce ? false : "hidden"}
          animate={reduce ? undefined : "show"}
          className="space-y-2"
        >
          {rows.map(({ seg, index }) => {
            const flagged = seg.tactic !== "none";
            const isOpen = Boolean(open[index]);
            const panelId = `${uid}-panel-${index}`;
            return (
              <motion.li
                key={index}
                id={`line-${index}`}
                variants={reduce ? undefined : ITEM_VARIANTS}
                className={`console-card relative grid scroll-mt-24 grid-cols-[2.6rem_1fr] gap-x-3 p-3 ${flagged ? "" : "opacity-85"}`}
              >
                {flagged && <span className="absolute inset-y-0 left-0 w-1 bg-[color:var(--hot)]" aria-hidden="true" />}
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
                        <span className="text-sm leading-relaxed">{seg.text}</span>
                        <TacticChip tactic={seg.tactic} />
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <span className="text-sm leading-relaxed">{seg.text}</span>
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
                              <div className="px text-[9px] text-[color:var(--muted)]">Why it is flagged</div>
                              <p className="mt-1 text-sm leading-relaxed text-[color:var(--muted)]">{seg.explanation}</p>
                            </div>
                          )}
                          {seg.counterAdvice && (
                            <div className="border-l-4 border-[color:var(--hot)] pl-3">
                              <div className="px hot text-[9px]">What you could have said</div>
                              <p className="mt-1 text-sm leading-relaxed">{seg.counterAdvice}</p>
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
      <div className="px mb-2 text-[10px] text-[color:var(--muted)]">Tactic radar</div>
      <div className="h-[270px] w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="66%" margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
            <PolarGrid stroke="var(--line)" />
            <PolarAngleAxis dataKey="tactic" tick={{ fill: "var(--muted)", fontSize: 9, fontFamily: "var(--vx-mono)" }} />
            <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
            <Radar dataKey="count" stroke={color} fill={color} fillOpacity={0.28} strokeWidth={2} isAnimationActive={!reduce} />
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
        <span className="px acc text-[10px]">{"// Vocal cadence telemetry"}</span>
        {summary && (
          <span className="text-[11px] text-[color:var(--muted)]">
            {summary.pauseCount} PAUSES · LONGEST {summary.longestPauseSec.toFixed(1)}s · {summary.paceSpikeTimestamps.length} PACE SPIKES
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
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => clock(Number(v))} tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--vx-mono)" }} stroke="var(--line)" />
            <YAxis hide />
            <Tooltip
              cursor={{ stroke: "var(--acc)" }}
              contentStyle={{ background: "var(--background)", border: "2px solid var(--line)", borderRadius: 0, fontFamily: "var(--vx-mono)", fontSize: 11 }}
              labelFormatter={(l) => clock(Number(l))}
              formatter={(v) => [Number(v).toFixed(3), "energy"]}
            />
            <Area type="stepAfter" dataKey="energy" stroke="var(--acc)" strokeWidth={1.5} fill={`url(#${gid})`} isAnimationActive={!reduce} />
            {flaggedTimes.map((t, i) => (
              <ReferenceLine key={`${t}-${i}`} x={t} stroke="var(--hot)" strokeDasharray="3 3" />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-[10px] text-[color:var(--muted)]">Green = vocal energy (RMS). Dashed red = moments where a manipulation tactic was flagged.</p>
    </div>
  );
}

const LOG_TEXT = [
  "$ vexa --analyze transcript",
  "Parsing transcript…",
  "Segmenting turns; inferring CALLER / VICTIM from context…",
  "Cross-referencing tactic database…",
  "Scoring urgency, authority and isolation signals…",
  "Matching FTC/FBI scam categories…",
  "Compiling evidentiary dossier…",
];
const LOG_MEDIA = [
  "$ vexa --ingest evidence",
  "Verifying media container…",
  "Extracting audio track…",
  "Transcribing every utterance…",
  "Diarizing voices: CALLER / VICTIM…",
  "Cross-referencing tactic database…",
  "Scoring each turn in conversation context…",
  "Compiling evidentiary dossier…",
];

function LogBody({ lines, count, active }: { lines: string[]; count: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div ref={ref} className="max-h-40 overflow-y-auto border-2 border-[color:var(--line)] p-3 text-[11px] leading-relaxed">
      {lines.slice(0, count).map((line, i) => (
        <p key={line} className="text-[color:var(--muted)]">
          <span className="acc">&gt;</span> {line}
          {active && i === count - 1 && <span className="vx-caret" aria-hidden="true" />}
        </p>
      ))}
    </div>
  );
}

function TerminalLog({ isLoading, complete = false, mode }: { isLoading: boolean; complete?: boolean; mode: "media" | "text" }) {
  const reduce = useReducedMotion();
  const lines = mode === "media" ? LOG_MEDIA : LOG_TEXT;
  const [count, setCount] = useState(1);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isLoading) return;
    if (reduce) {
      setCount(lines.length);
      return;
    }
    setCount(1);
    const id = setInterval(() => setCount((c) => Math.min(c + 1, lines.length)), 650);
    return () => clearInterval(id);
  }, [isLoading, lines, reduce]);

  if (complete) {
    return (
      <div className="console-card p-4">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-xs">
          <span className="px acc flex items-center gap-2 text-[10px]">
            <CircleCheck size={14} /> Scan complete — {open ? "hide" : "view"} log
          </span>
          <ChevronDown size={14} className={`text-[color:var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="mt-3">
            <LogBody lines={lines} count={lines.length} active={false} />
          </div>
        )}
      </div>
    );
  }
  if (!isLoading) return null;
  return (
    <div className="console-card p-4" aria-live="off">
      <div className="px mb-2 text-[9px] text-[color:var(--muted)]">System log</div>
      <LogBody lines={lines} count={count} active />
    </div>
  );
}

function ScanMetadata({ report, mode, audio }: { report: Report; mode: "ai" | "fallback"; audio: boolean }) {
  const flagged = report.segments.filter((s) => s.tactic !== "none").length;
  const callers = report.segments.filter((s) => s.speaker === "caller").length;
  const victims = report.segments.filter((s) => s.speaker === "victim").length;
  const rows: Array<[string, string]> = [
    ["Category", report.category],
    ["Processing time", report.processingMs !== undefined ? `${(report.processingMs / 1000).toFixed(2)} s` : "—"],
    ["Segments analyzed", String(report.segments.length)],
    ["Segments flagged", String(flagged)],
    ["Caller / Victim", `${callers} / ${victims}`],
    ["Input", audio ? "Audio / video" : "Transcript"],
    ["Analysis mode", mode === "ai" ? "AI · Gemini" : "Fallback · heuristic"],
  ];
  return (
    <div className="console-card p-6">
      <div className="px mb-3 text-[10px] text-[color:var(--muted)]">Scan metadata</div>
      <dl className="divide-y-2 divide-[color:var(--line)] text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-2">
            <dt className="px shrink-0 text-[9px] text-[color:var(--muted)]">{k}</dt>
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
    <div className="console-card p-4">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-2 px-2 py-1 text-xs">
        <span className="px text-[10px] text-[color:var(--muted)]">Tactic glossary · 7 tactics</span>
        <ChevronDown size={15} className={`text-[color:var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id={panelId} className="mt-3 space-y-3 border-t-2 border-[color:var(--line)] px-2 pt-4">
          {TACTIC_IDS.map((id) => {
            const { Icon, label, def } = TACTICS[id];
            return (
              <li key={id} className="flex items-start gap-3">
                <Icon size={16} className="hot mt-0.5 shrink-0" />
                <div>
                  <div className="px text-[10px]">{label}</div>
                  <p className="mt-0.5 text-sm leading-relaxed text-[color:var(--muted)]">{def}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const CATEGORY_ACTION: Record<string, string> = {
  "Government Imposter Scam": "Agencies never demand gift cards, crypto or wires. Hang up and reach the agency through the number on its official website.",
  "Grandparent/Family Emergency Scam": "Hang up and call your family member on a number you already have. Agree on a family code word for real emergencies.",
  "Tech Support Scam": "Legitimate companies don't cold-call about viruses. Never install software or grant remote access to a caller.",
  "Romance Scam": "Never send money to someone you haven't met in person. Reverse-search their photos and talk it over with a friend.",
  "Prize/Lottery Scam": "You can't win a contest you didn't enter, and real prizes or rebates never require credential verification over the phone.",
  "Investment/Crypto Scam": "Guaranteed returns don't exist. Check the firm's registration with your securities regulator first.",
  "Bank/Financial Institution Imposter Scam": "Hang up and call the number printed on your card. Banks never ask for full PINs or one-time codes.",
};

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
  const trend = flagged === 0 ? "NONE" : secondHalf > firstHalf ? "ESCALATING" : secondHalf < firstHalf ? "FADING" : "STEADY";
  const pressure = callers.length ? Math.round((callers.filter((s) => s.tactic !== "none").length / callers.length) * 100) : 0;

  const actions: string[] = clear
    ? ["Low risk detected. Still verify unexpected callers independently before sharing personal information."]
    : [
        CATEGORY_ACTION[report.category] ?? "Hang up and verify the caller through an official number you look up yourself.",
        "Never share codes, PINs, passwords or remote access with someone who called you.",
        "Already paid or shared details? Contact your bank right away and change affected passwords.",
        "Report it to the Canadian Anti-Fraud Centre (antifraudcentre.ca) or, in the US, the FTC (reportfraud.ftc.gov).",
      ];

  const tiles: Array<{ k: string; v: React.ReactNode }> = [
    { k: "Flagged lines", v: `${flagged} / ${total}` },
    {
      k: "Dominant tactic",
      v: dominant ? (
        <span className="flex items-center gap-1.5">
          {(() => {
            const { Icon } = TACTICS[dominant];
            return <Icon size={14} className="hot shrink-0" />;
          })()}
          <span className="truncate">{TACTICS[dominant].label}</span>
        </span>
      ) : (
        <span className="ok flex items-center gap-1.5">
          <CircleCheck size={14} /> None
        </span>
      ),
    },
    { k: "First red flag", v: firstIdx >= 0 ? `Line ${firstIdx + 1}${segs[firstIdx]?.start !== undefined ? ` · ${clock(segs[firstIdx]?.start ?? 0)}` : ""}` : "—" },
    { k: "Tactic variety", v: `${active.length} / 7` },
    { k: "Caller lines", v: String(callers.length) },
    { k: "Victim lines", v: String(victims.length) },
    { k: "Caller pressure", v: `${pressure}%` },
    { k: "Trend", v: trend },
  ];

  return (
    <div className="console-card p-6">
      <span className="px acc text-[10px]">{"// Key insights"}</span>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="min-w-0 border-2 border-[color:var(--line)] p-3">
            <div className="px text-[9px] text-[color:var(--muted)]">{t.k}</div>
            <div className="mt-1.5 text-sm font-semibold">{t.v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5">
        <div className="px mb-2 flex justify-between text-[9px] text-[color:var(--muted)]">
          <span>Talk share (words)</span>
          <span>
            CALLER {talkPct}% · VICTIM {100 - talkPct}%
          </span>
        </div>
        <div className="flex h-3 w-full border-2 border-[color:var(--line)]" role="img" aria-label={`Caller ${talkPct} percent, victim ${100 - talkPct} percent of words`}>
          <div className="h-full bg-[color:var(--hot)]" style={{ width: `${talkPct}%` }} />
          <div className="h-full bg-[color:var(--acc)]" style={{ width: `${100 - talkPct}%` }} />
        </div>
      </div>

      <div className="mt-5">
        <div className="px mb-2 text-[9px] text-[color:var(--muted)]">Pressure map · one cell per line (click to jump)</div>
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
        <p className="mt-2 text-[10px] text-[color:var(--muted)]">Red = flagged caller line · Green fill = victim reply · Hollow = neutral caller line.</p>
      </div>

      {active.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="Tactic frequency">
          {active.map((id) => {
            const { Icon, label } = TACTICS[id];
            const n = report.tacticCounts[id];
            return (
              <li key={id} className="flex items-center gap-3 text-xs">
                <Icon size={14} className="hot shrink-0" />
                <span className="w-36 shrink-0 truncate">{label}</span>
                <span className="h-2 flex-1 border border-[color:var(--line)]">
                  <span className="block h-full bg-[color:var(--hot)]" style={{ width: `${(n / maxCount) * 100}%` }} />
                </span>
                <span className="w-5 text-right font-semibold">{n}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 border-t-2 border-[color:var(--line)] pt-4">
        <div className="px mb-2 text-[9px] text-[color:var(--muted)]">{clear ? "Assessment" : "Recommended actions"}</div>
        <ul className="space-y-2 text-sm leading-relaxed">
          {actions.map((a) => (
            <li key={a} className="flex items-start gap-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 ${clear ? "bg-[color:var(--ok)]" : "bg-[color:var(--acc)]"}`} />
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
  onReset: () => void;
}) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playerError, setPlayerError] = useState(false);
  const mode = modeOf(report);
  const engineLabel = mode === "fallback" ? "Offline Heuristic Engine" : fromMedia ? "Gemini Multimodal" : "Gemini";
  const transcriptText = transcriptOf(report.segments) || "No dialogue recorded.";

  const flaggedTimes: number[] = [];
  report.segments.forEach((s) => {
    if (s.tactic !== "none" && s.start !== undefined) flaggedTimes.push(s.start);
  });

  function seek(t: number) {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = t;
    void el.play().catch(() => undefined);
  }
  function download() {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), ...report, transcript: transcriptText }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vexa-dossier-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const showPlayer = fromMedia && Boolean(previewUrl) && !playerError;
  const pill = "tog flex items-center gap-1.5";

  return (
    <Shell beam>
      <TopBar label="EVIDENTIARY DOSSIER" />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="no-print mb-8 flex flex-wrap items-center justify-between gap-3 border-b-2 border-[color:var(--line)] pb-4 text-xs">
          <button type="button" onClick={onReset} className={pill}>
            <ArrowLeft size={13} /> New inspection
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={download} className={pill}>
              <Download size={12} /> JSON
            </button>
            <button type="button" onClick={() => window.print()} className={pill}>
              <Printer size={12} /> Print / PDF
            </button>
            <span className="px text-[10px]">
              <span className="text-[color:var(--muted)]">Engine: </span>
              <span className="acc">{engineLabel}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_380px] lg:items-start">
          <section className="contents lg:block lg:min-w-0 lg:space-y-6">
            <div className="order-1 lg:order-none">
              <ClassificationStamp category={report.category} risk={report.riskScore} />
            </div>
            <div className="console-card order-3 p-6 lg:order-none">
              <span className="px acc text-[10px]">{"// Forensic assessment"}</span>
              <p className="mt-2 text-lg font-semibold leading-snug sm:text-xl">{report.summary}</p>
              {report.fileName && <p className="mt-3 text-[11px] text-[color:var(--muted)]">EXHIBIT: {report.fileName}</p>}
            </div>
            {report.fallbackReason && (
              <div className="order-4 lg:order-none">
                <InlineError message={`Simplified analysis — ${reasonText(report.fallbackReason)}. Results come from the local rule-based engine and may be less accurate than the AI analysis.`} />
              </div>
            )}
            {showPlayer && (
              <div className="console-card no-print order-4 p-6 lg:order-none">
                <div className="px mb-3 text-[10px] text-[color:var(--muted)]">Evidence playback</div>
                <MediaPlayer src={previewUrl} kind={previewKind} altAudio={playbackWavUrl || undefined} mediaRef={mediaRef} onFail={() => setPlayerError(true)} />
                <p className="mt-2 text-[10px] text-[color:var(--muted)]">Expand a flagged line and press “Play from” to jump to that moment.</p>
              </div>
            )}
            <div className="order-5 lg:order-none">
              <InsightsPanel report={report} />
            </div>
            <div className="order-6 lg:order-none">
              <div className="mb-4 flex items-center justify-between">
                <span className="px acc text-[10px]">{"// Evidence timeline"}</span>
                <span className="px text-[10px] text-[color:var(--muted)]">{report.segments.length} segments</span>
              </div>
              <SegmentReveal segments={report.segments} onSeek={showPlayer ? seek : undefined} />
            </div>
            <div className="console-card order-7 p-6 lg:order-none">
              <div className="mb-3 flex items-center justify-between">
                <span className="px text-[10px] text-[color:var(--muted)]">Decoded transcript log</span>
                <span className="px text-[9px] text-[color:var(--muted)]">Chronological</span>
              </div>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t-2 border-[color:var(--line)] pt-3 text-xs leading-relaxed opacity-90">{transcriptText}</pre>
            </div>
            {fromMedia && (cadence.length > 0 || audioNote) && (
              <div className="order-8 lg:order-none">
                {cadence.length > 0 && <CadenceChart telemetry={cadence} summary={audioSummary} flaggedTimes={flaggedTimes} />}
                {audioNote && <p className="mt-3 text-xs text-[color:var(--muted)]">{audioNote}</p>}
              </div>
            )}
          </section>

          <aside className="contents lg:sticky lg:top-20 lg:block lg:space-y-6 lg:self-start">
            <div className="order-2 lg:order-none">
              <RiskGauge score={report.riskScore} />
            </div>
            <div className="order-9 lg:order-none">
              <TacticRadar counts={report.tacticCounts} risk={report.riskScore} />
            </div>
            <div className="order-10 lg:order-none">
              <ScanMetadata report={report} mode={mode} audio={fromMedia || Boolean(report.mediaType)} />
            </div>
            <div className="order-11 lg:order-none">
              <TerminalLog isLoading={false} complete mode={fromMedia ? "media" : "text"} />
            </div>
            <div id="glossary" className="order-12 scroll-mt-24 lg:order-none">
              <TacticGlossary />
            </div>
          </aside>
        </div>
      </main>
    </Shell>
  );
}

/* ═══════════════════════════ PAGE ═══════════════════════════ */

const HERO_CHIPS = ["7 tactic classes", "CALLER / VICTIM per line", "Audio cadence telemetry"];

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
  const chooseFileRef = useRef<(f: File, d?: Demo) => Promise<void>>(async () => undefined);
  const tabIds = useId().replace(/:/g, "");

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

  // Nudge the page down so the preview and both processing stages are in view.
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
        const why = e instanceof Error ? e.message : "unknown error";
        setAudioNote(`Audio track unavailable: ${why}. Speech analysis still runs on the server.`);
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
      setError("Unsupported file type. Use .mp4, .mp3, .wav, .m4a or .webm.");
      return;
    }
    if (candidate.size === 0) {
      setError("That file is empty.");
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setError("Media file exceeds the 20 MB size limit.");
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

  // Demos are real files run through the exact same pipeline as an upload. Nothing is pre-baked.
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
      setError(`Demo file not found. Place ${demo.file} in /public/demo/ and reload.`);
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
      setError("Microphone recording isn't supported in this browser.");
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
      setError("Microphone access was denied or is unavailable.");
    }
  }

  async function analyzeText(override?: string) {
    const text = (override ?? transcript).trim();
    if (!text) {
      setError("Paste a call transcript into the console before analyzing.");
      return;
    }
    setBusy(true);
    setPhase("analyzing");
    setError("");
    setAnStamp([performance.now(), null]);
    const started = Date.now();
    try {
      let data: Report;
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: text, audioSummary }),
        });
        const json: unknown = await response.json().catch(() => null);
        if (response.ok && isRecord(json)) data = normalizeReport(json);
        else if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429)
          throw new Error(errorMessage(json, "Analysis request failed."));
        else data = normalizeReport({ ...heuristicFallback(text), fallbackReason: `http_${response.status}` });
      } catch (caught) {
        if (caught instanceof Error && caught.message !== "Failed to fetch" && !(caught instanceof TypeError)) throw caught;
        data = normalizeReport({ ...heuristicFallback(text), fallbackReason: "network" });
      }
      showReport({ ...data, mode: modeOf(data), processingMs: Date.now() - started }, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Text analysis failed.");
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
          reject(new Error(xhr.status === 413 ? "The file is too large for the server. Try a shorter clip." : "The forensic server returned an unreadable response."));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(errorMessage(data, `Media analysis failed (${xhr.status}).`)));
      };
      xhr.onerror = () => reject(new Error("Network connection failed during upload."));
      xhr.ontimeout = () => reject(new Error("The analysis timed out. Try a shorter clip."));
      xhr.onabort = () => reject(new Error("Upload cancelled."));
      const body = new FormData();
      body.append("file", media, media.name);
      xhr.send(body);
    });
  }

  async function analyzeMedia() {
    if (!file) {
      setError("Select or attach an evidentiary media file first.");
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
      const json = await uploadWithProgress(toUpload);
      const data = normalizeReport(json);
      data.fileName = file.name;
      if (data.segments.length === 0) throw new Error("The analysis returned no dialogue.");
      showReport({ ...data, inputMode: data.inputMode ?? "media", mode: modeOf(data), processingMs: Date.now() - started }, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Media analysis failed.");
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
        onReset={reset}
      />
    );
  }

  const hasMedia = Boolean(file);
  const statusLabel = phase === "uploading" ? `Uploading evidence… ${progress}%` : phase === "analyzing" ? "Analyzing call…" : "";
  const cadState: StageState = decoding ? "running" : cadStamp[1] !== null ? (cadence.length > 0 ? "done" : "warn") : "idle";
  const anState: StageState = busy ? "running" : anStamp[1] !== null ? "done" : "idle";
  const cadDetail = decoding
    ? "Decoding audio, measuring pauses and pace…"
    : cadState === "done"
    ? `${audioSummary?.pauseCount ?? 0} pauses · ${audioSummary?.paceSpikeTimestamps.length ?? 0} pace spikes`
    : cadState === "warn"
    ? "Cadence unavailable (see note)"
    : "Waiting for media";
  const anDetail = busy
    ? phase === "uploading"
      ? `Uploading ${progress}%`
      : "Transcribing, labeling CALLER / VICTIM, classifying tactics…"
    : "Press Analyze to start";

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (busy || recording) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setTab((t) => (t === "recording" ? "transcript" : "recording"));
      setError("");
    }
  }

  return (
    <Shell>
      <TopBar label="THREAT ANALYSIS CONSOLE" />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse bg-[color:var(--acc)]" />
              <p className="px acc text-[10px]">{"// Threat analysis console"}</p>
            </div>
            <h1 className="font-display px text-6xl leading-[0.9] sm:text-7xl">Vexa</h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-[color:var(--muted)]">
              Upload a call recording or paste a transcript. Every line is attributed to CALLER or VICTIM and matched to the manipulation tactic in use.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {HERO_CHIPS.map((chip) => (
                <li key={chip} className="px flex items-center gap-2 border-2 border-[color:var(--line)] px-3 py-1 text-[9px] text-[color:var(--muted)]">
                  <span className="h-1.5 w-1.5 bg-[color:var(--acc)]" />
                  {chip}
                </li>
              ))}
            </ul>
          </div>
          <VexaMark size={112} className="acc hidden shrink-0 sm:block" />
        </div>

        <section className="console-card mt-10 p-6">
          <div role="tablist" aria-label="Input type" className="mb-6 grid grid-cols-2 gap-1 border-2 border-[color:var(--line)] p-1">
            {(
              [
                ["recording", "Recording", FileAudio],
                ["transcript", "Transcript", FileText],
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
                disabled={busy || recording}
                onKeyDown={onTabKey}
                onClick={() => {
                  setTab(id);
                  setError("");
                }}
                className={`px flex items-center justify-center gap-2 px-4 py-2.5 text-[11px] transition disabled:cursor-not-allowed ${
                  tab === id ? "bg-[color:var(--acc)] text-[#02160c]" : "text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {tab === "recording" && (
            <div role="tabpanel" id={`${tabIds}-panel-recording`} aria-labelledby={`${tabIds}-tab-recording`}>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <button
                  type="button"
                  disabled={busy || recording}
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
                  className={`flex items-center justify-center gap-4 border-2 border-dashed p-7 text-center transition disabled:opacity-50 ${
                    dragging ? "border-[color:var(--acc)] bg-[color:var(--acc-dim)]" : "vx-hoverbg border-[color:var(--line)] hover:border-[color:var(--acc)]"
                  }`}
                >
                  <Upload size={22} className="acc shrink-0" />
                  <div className="min-w-0 text-left text-xs">
                    <span className="block truncate font-semibold">
                      {file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)` : "Drop a call recording, or click to upload"}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[color:var(--muted)]">.mp4 · .webm · .mp3 · .wav · .m4a — max 20 MB</span>
                  </div>
                </button>

                {recording ? (
                  <button type="button" onClick={stopRecording} aria-label={`Stop recording, ${clock(recSeconds)} elapsed`} className="box-hot px flex items-center justify-center gap-2 px-6 py-4 text-[11px]">
                    <Square size={14} className="animate-pulse" /> Stop · {clock(recSeconds)}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void startRecording()}
                    className="px vx-hoverbg flex items-center justify-center gap-2 border-2 border-[color:var(--line)] px-6 py-4 text-[11px] transition hover:border-[color:var(--acc)] disabled:opacity-50"
                  >
                    <Mic size={15} /> Record
                  </button>
                )}
              </div>
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

              <div className="mt-6 border-t-2 border-[color:var(--line)] pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="px text-[10px] text-[color:var(--muted)]">Load a sample recording:</p>
                  <span className="text-[10px] text-[color:var(--muted)]">Analyzed live, same pipeline as uploads</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {DEMOS.map((demo) => {
                    const active = selectedDemo?.id === demo.id;
                    return (
                      <button key={demo.id} type="button" disabled={busy || recording || demoLoading} onClick={() => void chooseDemo(demo)} aria-pressed={active} className="tog flex items-center gap-1.5 disabled:opacity-50">
                        {demoLoading && !active ? <Loader2 size={12} className="animate-spin" /> : <FileVideo size={12} />}
                        {demo.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {(preview || decoding || cadStamp[0] !== null) && (
                <div ref={panelRef} className="mt-5 scroll-mt-24 space-y-3">
                  {preview && (
                    <div className="border-2 border-[color:var(--line)] p-4">
                      <div className="mb-2 flex items-center justify-between text-xs">
                        <span className="max-w-[80%] truncate font-semibold">{file?.name}</span>
                        <button type="button" onClick={clearMedia} disabled={busy} aria-label="Remove media" className="p-1 text-[color:var(--muted)] transition hover:text-[color:var(--foreground)] disabled:opacity-40">
                          <X size={15} />
                        </button>
                      </div>
                      {previewError ? (
                        <div className="mt-2 flex flex-col items-center gap-2 border-2 border-dashed border-[color:var(--line)] px-4 py-8 text-center text-[11px] leading-relaxed text-[color:var(--muted)]">
                          <FileVideo size={22} />
                          <span>Your browser can&apos;t preview this file{wavUrl ? "" : ""}, but it can still be analyzed.</span>
                        </div>
                      ) : (
                        <MediaPlayer src={preview} kind={previewKind} altAudio={wavUrl || undefined} onFail={() => setPreviewError(true)} className="mt-2" />
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <StageRow index={1} title="Audio extraction + cadence" detail={cadDetail} state={cadState} stamp={cadStamp} />
                    <StageRow index={2} title="Forensic analysis" detail={anDetail} state={anState} stamp={anStamp} />
                  </div>
                  {audioNote && <p className={`text-[11px] ${cadState === "warn" ? "hot" : "text-[color:var(--muted)]"}`}>{audioNote}</p>}
                </div>
              )}

              {busy && phase === "uploading" && (
                <div className="mt-4">
                  <div className="px mb-1 flex justify-between text-[10px] text-[color:var(--muted)]">
                    <span>Ingestion progress</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2.5 w-full border-2 border-[color:var(--line)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Upload progress">
                    <div className="h-full bg-[color:var(--acc)] transition-all duration-150" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              {error && <InlineError message={error} />}

              <button type="button" className="btn mt-6" disabled={busy || decoding || recording || !hasMedia} onClick={() => void analyzeMedia()}>
                {busy || decoding ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}
                {busy ? statusLabel : decoding ? "Preparing audio…" : "Analyze call"}
              </button>
              {!hasMedia && !recording && !busy && <InlineNote>Attach or record a call, or load a sample recording, to begin.</InlineNote>}
            </div>
          )}

          {tab === "transcript" && (
            <div role="tabpanel" id={`${tabIds}-panel-transcript`} aria-labelledby={`${tabIds}-tab-transcript`}>
              <div className="relative">
                <label htmlFor="transcript-input" className="sr-only">
                  Call transcript
                </label>
                <textarea
                  id="transcript-input"
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  maxLength={MAX_TRANSCRIPT_CHARS}
                  placeholder="Paste a call transcript here. Speaker labels are optional; Vexa infers who is CALLER and who is VICTIM."
                  className="min-h-[220px] w-full resize-y border-2 border-[color:var(--line)] bg-transparent p-4 pb-8 text-xs leading-relaxed outline-none transition placeholder:text-[color:var(--muted)] focus:border-[color:var(--acc)] sm:text-sm"
                />
                <span className={`pointer-events-none absolute bottom-3 right-4 text-xs ${transcript.length > 18000 ? "hot" : "text-[color:var(--muted)]"}`}>
                  {transcript.length.toLocaleString()} / {MAX_TRANSCRIPT_CHARS.toLocaleString()}
                </span>
              </div>

              <div className="mt-6 border-t-2 border-[color:var(--line)] pt-5">
                <p className="px mb-3 text-[10px] text-[color:var(--muted)]">Run a sample transcript:</p>
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
                      className="tog flex items-center gap-1.5 disabled:opacity-40"
                    >
                      <Terminal size={12} />
                      {example.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && <InlineError message={error} />}

              <button type="button" className="btn mt-6" disabled={busy || !transcript.trim()} onClick={() => void analyzeText()}>
                {busy ? <Loader2 className="animate-spin" size={15} /> : <ShieldAlert size={15} />}
                {busy ? statusLabel || "Analyzing…" : "Analyze call"}
              </button>
              {busy && (
                <div className="mt-3">
                  <StageRow index={1} title="Forensic analysis" detail="Labeling CALLER / VICTIM, classifying tactics…" state="running" stamp={anStamp} />
                </div>
              )}
              {!transcript.trim() && !busy && <InlineNote>Paste a transcript above, or run a sample, to begin.</InlineNote>}
            </div>
          )}

          {busy && (
            <div className="mt-6">
              <TerminalLog isLoading mode={tab === "recording" ? "media" : "text"} />
            </div>
          )}
        </section>

        <div id="glossary" className="mt-6 scroll-mt-24">
          <TacticGlossary />
        </div>

        <footer className="mt-12 border-t-2 border-[color:var(--line)] pt-6 text-[11px] leading-relaxed text-[color:var(--muted)]">
          AI disclosure — analysis is produced by Google Gemini with a rule-based offline fallback. Scores are decision support, not proof; recordings are not stored.{" "}
          <a href="#glossary" onClick={() => window.dispatchEvent(new Event("vexa:glossary"))} className="acc underline underline-offset-2">
            Tactic glossary
          </a>
          . Built for the TLN Cybersecurity Challenge 2026.
        </footer>
      </main>
    </Shell>
  );
}