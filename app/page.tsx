// app/page.tsx
"use client";

/**
 * Vexa — Threat Analysis Console
 *
 * Fully self-contained page. Everything the UI needs lives in this file:
 * types, tactic metadata, the three cached examples, client-side audio analysis,
 * an offline heuristic fallback, the design-system CSS, and every component.
 *
 * The only things it talks to are the two server routes:
 *   POST /api/analyze        { transcript, audioSummary? }
 *   POST /api/analyze-media  multipart "file"  |  { demoId, live }
 *
 * Responses are normalized defensively, so small differences in the server's
 * JSON shape will not crash the report screen.
 */

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
  Sparkles,
  Square,
  Sun,
  Upload,
  UserX,
  X,
  type LucideIcon,
} from "lucide-react";

/* ════════════════════════════════════════════════════════════════════════
   TYPES
   ════════════════════════════════════════════════════════════════════════ */

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

type Segment = {
  text: string;
  tactic: Tactic;
  explanation: string;
  counterAdvice: string;
  /** seconds into the recording, when the server provides it */
  start?: number;
};

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

type Report = Analysis & {
  fileName?: string;
  mode?: "ai" | "fallback" | "cached";
  processingMs?: number;
  cached?: boolean;
};

type Demo = { id: string; label: string; file: string };
type Tab = "recording" | "transcript";
type Phase = "idle" | "uploading" | "analyzing";
type Kind = "audio" | "video";
type ExampleItem = { id: string; label: string; transcript: string; result: Analysis };

/* ════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════════════════ */

const DEMOS: Demo[] = [
  { id: "grandparent", label: "Grandparent Scam", file: "grandparent.mp4" },
  { id: "tech", label: "Tech Support Scam", file: "tech-support.mp4" },
  { id: "irs", label: "IRS Imposter Scam", file: "government.mp4" },
];

const MAX_BYTES = 20 * 1024 * 1024;
const DIRECT_UPLOAD_LIMIT = 4 * 1024 * 1024;
const MAX_RECORD_SECONDS = 120;
const MAX_TRANSCRIPT_CHARS = 20000;
const ALLOWED_EXT = ["mp4", "mp3", "wav", "m4a", "webm"];
const MIN_ANALYSIS_MS = 2200;

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

type TacticMeta = {
  label: string;
  short: string;
  Icon: LucideIcon;
  def: string;
  explain: string;
  counter: string;
};

const TACTICS: Record<TacticId, TacticMeta> = {
  urgency: {
    label: "Urgency",
    short: "URGENCY",
    Icon: Clock,
    def: "Manufactures a deadline so you act before you can think or verify.",
    explain: "Creates artificial time pressure so you skip verification.",
    counter: "I don't make decisions under pressure. I'll verify this myself and call you back.",
  },
  authority_impersonation: {
    label: "False Authority",
    short: "AUTHORITY",
    Icon: ShieldAlert,
    def: "Poses as a government agency, bank, company or lawyer to borrow trust.",
    explain: "Claims an official role to borrow credibility it hasn't earned.",
    counter: "Give me your name and a case number. I'll hang up and call the official number myself.",
  },
  isolation: {
    label: "Isolation",
    short: "ISOLATION",
    Icon: UserX,
    def: "Cuts you off from the people who would spot the scam.",
    explain: "Tries to keep you away from anyone who could challenge the story.",
    counter: "I talk big decisions over with family. If this is legitimate, that won't be a problem.",
  },
  threat: {
    label: "Threat",
    short: "THREAT",
    Icon: AlertTriangle,
    def: "Uses fear of arrest, fines, account loss or harm to force compliance.",
    explain: "Uses fear of consequences to override your judgment.",
    counter: "Real agencies don't threaten arrest over the phone. I'm ending this call and checking directly.",
  },
  too_good_to_be_true: {
    label: "Too Good To Be True",
    short: "TOO GOOD",
    Icon: Gift,
    def: "Dangles a prize, refund or guaranteed return to lower your guard.",
    explain: "Offers an unrealistic reward to lower your guard.",
    counter: "I didn't enter anything, and legitimate offers never need upfront fees. No thank you.",
  },
  payment_request: {
    label: "Payment Request",
    short: "PAYMENT",
    Icon: CreditCard,
    def: "Demands money through untraceable channels: gift cards, crypto, wires.",
    explain: "Requests money through channels that are hard to trace or reverse.",
    counter: "I won't pay by gift card, crypto or wire. Send an official invoice by mail.",
  },
  personal_info_request: {
    label: "Info Request",
    short: "INFO REQ",
    Icon: KeyRound,
    def: "Fishes for IDs, passwords, one-time codes or remote access to your device.",
    explain: "Tries to collect identity details, codes or device access.",
    counter: "I never share personal details on an inbound call. I'll contact you through official channels.",
  },
};

/* ════════════════════════════════════════════════════════════════════════
   SMALL HELPERS
   ════════════════════════════════════════════════════════════════════════ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
const riskColor = (s: number) => (s > 60 ? "#F97316" : s < 25 ? "#22C55E" : "#3B82F6");

const modeOf = (d: Report): NonNullable<Report["mode"]> =>
  d.cached ? "cached" : d.inputMode === "fallback" || d.fallbackReason ? "fallback" : (d.mode ?? "ai");

const reasonText = (reason: string) =>
  REASON_LABEL[reason] ??
  (reason.startsWith("http_") ? `the AI service returned an error (${reason.slice(5)})` : reason);

/** Turns any reasonable server JSON into a fully-populated Report. */
function normalizeReport(raw: unknown): Report {
  const r = isRecord(raw) ? raw : {};
  const rawSegments = Array.isArray(r.segments) ? r.segments : [];
  const segments: Segment[] = [];
  rawSegments.forEach((item) => {
    if (!isRecord(item)) return;
    const text = asStr(item.text).trim();
    if (!text) return;
    const tactic: Tactic = isTactic(item.tactic) ? item.tactic : "none";
    segments.push({
      text,
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
  if (sum === 0) counts = countTactics(segments);

  const modes = ["ai", "fallback", "cached"] as const;
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
    mode: modes.find((m) => m === r.mode),
    cached: r.cached === true,
    processingMs: asNum(r.processingMs),
  };
}

/* ════════════════════════════════════════════════════════════════════════
   OFFLINE HEURISTIC ENGINE (used only if the server route is unreachable)
   ════════════════════════════════════════════════════════════════════════ */

const HEURISTIC_PATTERNS: Record<TacticId, RegExp> = {
  urgency:
    /\b(right now|immediately|urgent(?:ly)?|today|within (?:the )?(?:hour|\d+)|minutes?|last chance|expires?|deadline|before it'?s too late|act now|asap|hurry|quickly|no time)\b/gi,
  authority_impersonation:
    /\b(irs|cra|revenue agency|social security|fbi|police|officer|badge|microsoft|apple support|amazon|fraud department|security team|government|federal|agent|attorney|lawyer|technician|windows support|department)\b/gi,
  isolation:
    /\b(don'?t tell|do not tell|keep (?:this|it) (?:a )?secret|between us|don'?t (?:hang up|call anyone|discuss)|do not (?:hang up|speak to anyone|discuss)|stay on the line|gag order|confidential)\b/gi,
  threat:
    /\b(arrest(?:ed)?|warrant|lawsuit|sued|jail|prison|deport(?:ed|ation)?|frozen|suspended|seize[ds]?|legal action|criminal|penalt(?:y|ies)|fines?|hackers?|compromised|virus|infected|charges)\b/gi,
  too_good_to_be_true:
    /\b(you(?:'ve| have)? won|winner|prize|lottery|jackpot|guaranteed|free|refund|risk[- ]free|double your|inheritance|selected|waive|lifetime)\b/gi,
  payment_request:
    /\b(gift cards?|wire|bitcoin|crypto(?:currency)?|western union|money transfer|zelle|e-?transfer|pay(?:ment)?|send (?:me )?money|cash|bail|fee|deposit|google play|itunes|escrow)\b/gi,
  personal_info_request:
    /\b(social (?:security|insurance)|ssn|password|passcode|pin|one[- ]time (?:code|password)|verification code|card number|account number|date of birth|routing number|remote access|anydesk|teamviewer|full name|last four)\b/gi,
};

const TACTIC_PRIORITY: readonly TacticId[] = [
  "payment_request",
  "personal_info_request",
  "threat",
  "isolation",
  "authority_impersonation",
  "urgency",
  "too_good_to_be_true",
];

const TACTIC_WEIGHT: Record<TacticId, number> = {
  payment_request: 20,
  personal_info_request: 16,
  threat: 14,
  isolation: 12,
  authority_impersonation: 10,
  urgency: 8,
  too_good_to_be_true: 8,
};

const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
  ["Grandparent/Family Emergency Scam", /\b(grandma|grandpa|grandson|granddaughter|grandmother|grandfather|it'?s me|bail|car accident|in jail)\b/gi],
  ["Tech Support Scam", /\b(microsoft|windows|virus|malware|remote access|anydesk|teamviewer|technician|your computer|ip address)\b/gi],
  ["Government Imposter Scam", /\b(irs|cra|revenue|social security|social insurance|warrant|taxes|tax|government|federal|customs|immigration)\b/gi],
  ["Romance Scam", /\b(sweetheart|darling|my love|romance|lonely|soulmate|never met)\b/gi],
  ["Prize/Lottery Scam", /\b(prize|lottery|winner|jackpot|sweepstakes|you(?:'ve| have)? won)\b/gi],
  ["Investment/Crypto Scam", /\b(invest(?:ment|ing)?|crypto|bitcoin|trading|returns|forex|portfolio)\b/gi],
  ["Bank/Financial Institution Imposter Scam", /\b(bank|fraud department|debit card|credit card|account (?:number|has been))\b/gi],
];

function splitTranscript(text: string): string[] {
  const out: string[] = [];
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      if (line.length > 220) {
        const parts = line.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
        (parts ?? [line]).forEach((p) => {
          const t = p.trim();
          if (t) out.push(t);
        });
      } else {
        out.push(line);
      }
    });
  return out.slice(0, 80);
}

function heuristicAnalyze(transcript: string, reason: string): Report {
  const lines = splitTranscript(transcript);
  const segments: Segment[] = lines.map((text) => {
    let best: TacticId | undefined;
    let bestScore = 0;
    for (const id of TACTIC_PRIORITY) {
      const score = (text.match(HEURISTIC_PATTERNS[id]) ?? []).length;
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    }
    if (!best) {
      return { text, tactic: "none", explanation: "No manipulation tactic detected in this line.", counterAdvice: "" };
    }
    const meta = TACTICS[best];
    return { text, tactic: best, explanation: meta.explain, counterAdvice: meta.counter };
  });

  const counts = countTactics(segments);
  const flagged = segments.filter((s) => s.tactic !== "none");
  const distinct = TACTIC_IDS.filter((id) => counts[id] > 0);

  let category = "Other/Unclear";
  let topHits = 0;
  CATEGORY_PATTERNS.forEach(([name, re]) => {
    const hits = (transcript.match(re) ?? []).length;
    if (hits > topHits) {
      topHits = hits;
      category = name;
    }
  });

  let score = distinct.reduce((acc, id) => acc + TACTIC_WEIGHT[id], 0);
  score += Math.round((flagged.length / Math.max(segments.length, 1)) * 30);
  const riskScore = flagged.length === 0 ? 8 : Math.round(clamp(score, 15, 98));

  const top = distinct
    .slice()
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 3)
    .map((id) => TACTICS[id].label.toLowerCase());
  const summary =
    flagged.length === 0
      ? "The offline engine found no clear manipulation tactics, but stay cautious with unexpected callers who ask for money or personal details."
      : `Simplified offline analysis: this call resembles a ${category.toLowerCase()} and leans on ${top.join(", ")} to pressure you.`;

  return {
    riskScore,
    category,
    summary,
    tacticCounts: counts,
    segments,
    inputMode: "fallback",
    fallbackReason: reason,
    mode: "fallback",
  };
}

/* ════════════════════════════════════════════════════════════════════════
   CACHED EXAMPLES  (instant reports, zero API dependency)
   ════════════════════════════════════════════════════════════════════════ */

const S = (text: string, tactic: TacticId, explanation: string, counterAdvice: string): Segment => ({
  text,
  tactic,
  explanation,
  counterAdvice,
});
const N = (text: string): Segment => ({
  text,
  tactic: "none",
  explanation: "No manipulation tactic detected in this line.",
  counterAdvice: "",
});

function buildExample(
  id: string,
  label: string,
  category: string,
  riskScore: number,
  summary: string,
  segments: Segment[]
): ExampleItem {
  return {
    id,
    label,
    transcript: segments.map((s) => s.text).join("\n"),
    result: { riskScore, category, summary, tacticCounts: countTactics(segments), segments },
  };
}

const EXAMPLES: ExampleItem[] = [
  buildExample(
    "grandparent",
    "Grandparent Scam",
    "Grandparent/Family Emergency Scam",
    94,
    "A caller pretending to be your grandchild, then a fake lawyer, pushes you to secretly pay bail with gift cards or crypto.",
    [
      S(
        "Caller: Grandma? Hi, it's me. Please don't hang up, I'm in really big trouble.",
        "urgency",
        "Opens with distress and no name, so you supply the identity while your emotions take over.",
        "Which grandchild is this? Tell me something only you would know."
      ),
      N("Grandma: David? Is that you? You sound different."),
      S(
        "Caller: I got into a car accident and I've been arrested. I'm at the police station right now and I only get one call.",
        "urgency",
        "Invents a crisis with a ticking clock so you act before you can verify anything.",
        "I'm hanging up to call David on his own number right now."
      ),
      S(
        "Caller: Please don't tell Mom or Dad. They'll be so disappointed. Just keep this between us.",
        "isolation",
        "Secrecy removes the family members who would question the story immediately.",
        "I don't keep secrets like this. I'm calling your parents."
      ),
      S(
        "Caller: My lawyer, Mr. Peters, is going to call you in a minute to explain everything.",
        "authority_impersonation",
        "Hands you to a fake professional to add credibility and keep you on the line.",
        "Have him put it in writing. I'm calling David's parents first."
      ),
      N("Grandma: Oh dear. How much do they need?"),
      S(
        "Lawyer: This is Attorney Peters. Bail is set at $8,500 and it must be posted within the hour, or he'll be held until Monday.",
        "urgency",
        "A hard deadline with a scary consequence, designed to prevent verification.",
        "I'll confirm with the court and the family before paying anything."
      ),
      S(
        "Lawyer: The court only accepts gift cards or a Bitcoin ATM deposit. A courier can also collect cash from your home.",
        "payment_request",
        "Untraceable payment methods are the hallmark of a scam. No court accepts gift cards.",
        "No court takes gift cards or crypto. I'm hanging up."
      ),
      S(
        "Lawyer: To process the transfer I'll need your full name, address and the last four digits of your bank card.",
        "personal_info_request",
        "Harvests identity and financial details for follow-up fraud, or to send a courier to your door.",
        "I don't give personal details to callers. Goodbye."
      ),
      N("Grandma: I think I should call his mother first."),
      S(
        "Lawyer: There's a gag order on this case. If you contact anyone, David could face additional charges.",
        "threat",
        "Fabricates legal consequences to enforce silence and compliance.",
        "There's no gag order on a grandmother. I'm calling his parents now."
      ),
    ]
  ),
  buildExample(
    "tech",
    "Tech Support Scam",
    "Tech Support Scam",
    92,
    "A fake Microsoft technician frightens you about a virus, takes remote control of your computer, then bills you in gift cards.",
    [
      S(
        "Caller: Hello, this is Mark from Microsoft Windows Support. We've detected a serious virus on your computer.",
        "authority_impersonation",
        "Claims to be a major tech company. Microsoft does not cold-call people about viruses.",
        "Microsoft doesn't call customers. I'm hanging up and contacting them myself."
      ),
      N("Victim: I didn't see any warning on my screen."),
      S(
        "Caller: Hackers have compromised your IP address and are stealing your banking passwords as we speak.",
        "threat",
        "Uses technical-sounding fear to make an imaginary danger feel immediate.",
        "If my bank passwords were being stolen, my bank would tell me. Goodbye."
      ),
      S(
        "Caller: You must act immediately, before your files are permanently deleted in the next 15 minutes.",
        "urgency",
        "An arbitrary countdown keeps you from stopping to think or ask someone else.",
        "I'll take my time and check with a technician I trust."
      ),
      S(
        "Caller: Please download AnyDesk from the link I'm sending so I can take remote access of your computer.",
        "personal_info_request",
        "Remote access gives the caller control of your device, files and saved logins.",
        "I'm not installing anything for a caller. Goodbye."
      ),
      N("Victim: Okay, it's installed. There's a nine-digit code on the screen."),
      S(
        "Caller: Read me that code, and please don't close any windows or restart your computer.",
        "personal_info_request",
        "The code is the key that lets the scammer into your machine.",
        "That code stays with me. Nobody legitimate needs it read aloud."
      ),
      S(
        "Caller: Good news, you qualify for our lifetime protection plan with a free upgrade and a refund on your last subscription.",
        "too_good_to_be_true",
        "A sudden reward softens the fear and sets up the payment request.",
        "I didn't ask for any plan or refund. No thank you."
      ),
      S(
        "Caller: Don't discuss this with your bank or family. Their networks may be infected too and could spread it.",
        "isolation",
        "Invents a reason to avoid the people and institutions who would stop the fraud.",
        "I'll be discussing this with my bank and family right now."
      ),
      S(
        "Caller: There's a one-time activation fee of $299. Buy Google Play gift cards and read me the numbers on the back.",
        "payment_request",
        "Gift card codes are untraceable and effectively irreversible once spent.",
        "No legitimate company is paid in gift cards. This call is over."
      ),
      N("Victim: That seems like a lot. I'm going to call Microsoft myself."),
    ]
  ),
  buildExample(
    "irs",
    "IRS Imposter Scam",
    "Government Imposter Scam",
    97,
    "A fake tax officer threatens arrest and demands your identity details and an immediate gift card or wire payment.",
    [
      S(
        "Caller: This is Officer James Carter, badge 4471, with the IRS Criminal Investigation Division.",
        "authority_impersonation",
        "A rank, a badge number and a division name are cheap props that borrow real institutional weight.",
        "Send me a letter. I'll verify through the official IRS number."
      ),
      S(
        "Caller: A lawsuit has been filed against you for tax fraud and a warrant has been issued for your arrest.",
        "threat",
        "Opens with arrest to trigger panic. Tax agencies notify you by mail first.",
        "The IRS starts with a mailed notice, not an arrest call. Goodbye."
      ),
      N("Victim: That can't be right. I filed my taxes on time."),
      S(
        "Caller: If this isn't resolved within 45 minutes, local police will be dispatched to your home.",
        "urgency",
        "A short countdown blocks you from checking the claim or asking anyone for advice.",
        "Then let them come. I'm verifying this with the IRS directly."
      ),
      S(
        "Caller: To verify your identity I need your full Social Security number and your date of birth.",
        "personal_info_request",
        "The scammer asks you to hand over exactly what an identity thief needs.",
        "I never give that to an inbound caller. Goodbye."
      ),
      S(
        "Caller: Do not hang up and do not speak to anyone, including your accountant, or it will be treated as obstruction.",
        "isolation",
        "Forbids outside advice and invents a crime to keep you compliant.",
        "Speaking to my accountant is my right. I'm calling them now."
      ),
      S(
        "Caller: Since you're cooperating, I can waive the additional fines and cut your balance in half.",
        "too_good_to_be_true",
        "A discount rewards obedience and makes the demand feel like a favor.",
        "Agencies don't negotiate over the phone. I'm hanging up."
      ),
      S(
        "Caller: The remaining $3,740 can be settled today with prepaid gift cards or a wire to a federal escrow account.",
        "payment_request",
        "No government agency collects taxes via gift cards or private wires.",
        "The government doesn't take gift cards. I'm reporting this call."
      ),
      N("Victim: The IRS sends letters by mail. I'm going to call the number on their website."),
      S(
        "Caller: If you hang up this call, the arrest goes ahead.",
        "threat",
        "A final threat aimed at stopping you from doing the one thing that ends the scam.",
        "Hanging up is exactly what I'm about to do."
      ),
    ]
  ),
];

/* ════════════════════════════════════════════════════════════════════════
   CLIENT-SIDE AUDIO ANALYSIS  (RMS energy, pauses, pace spikes, compact WAV)
   ════════════════════════════════════════════════════════════════════════ */

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

async function analyzeAudio(
  source: File
): Promise<{ telemetry: CadencePoint[]; summary: AudioSummary; compactWav: File | null }> {
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  const ctx = new Ctor();
  try {
    const raw = await source.arrayBuffer();
    const audio = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(raw, resolve, (e) => reject(e ?? new Error("decode failed")));
    });

    const sr = audio.sampleRate;
    const len = audio.length;
    const channels = audio.numberOfChannels;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
    }

    // 50 ms RMS frames
    const FRAME = 0.05;
    const frameLen = Math.max(1, Math.round(sr * FRAME));
    const nFrames = Math.floor(len / frameLen);
    const rms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let sum = 0;
      const off = f * frameLen;
      for (let j = 0; j < frameLen; j++) {
        const v = mono[off + j] ?? 0;
        sum += v * v;
      }
      rms[f] = Math.sqrt(sum / frameLen);
      if (f % 500 === 499) await sleep(0); // keep the UI responsive on long files
    }

    // Adaptive pause threshold: 0.02 for normal levels, lower for quiet recordings.
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const threshold = Math.min(0.02, Math.max(0.002, p90 * 0.15));

    // Pauses: quiet for > 0.5 s, bounded by speech on both sides
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

    // Pace spikes: onset density over rolling 2 s windows
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
    const std = density.length
      ? Math.sqrt(density.reduce((a, b) => a + (b - mean) * (b - mean), 0) / density.length)
      : 0;
    const spikeAt = Math.max(5, mean + 1.5 * std);
    const spikes: number[] = [];
    onsets.forEach((t, i) => {
      const last = spikes[spikes.length - 1];
      if ((density[i] ?? 0) >= spikeAt && (last === undefined || t - last >= 3) && spikes.length < 10) {
        spikes.push(Math.round(t * 10) / 10);
      }
    });

    // Telemetry for the chart (≤ ~300 points)
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

    const base = source.name.replace(/\.[^.]+$/, "") || "audio";
    const compactWav =
      source.size > DIRECT_UPLOAD_LIMIT ? encodeCompactWav(mono, sr, `${base}-compact.wav`) : null;

    return {
      telemetry,
      summary: {
        pauseCount: pauseDurations.length,
        longestPauseSec: Math.round(Math.max(0, ...pauseDurations) * 10) / 10,
        paceSpikeTimestamps: spikes,
      },
      compactWav,
    };
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   DESIGN SYSTEM CSS  (scoped under .vexa-root; no globals required)
   ════════════════════════════════════════════════════════════════════════ */

const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@700&display=swap");

.vexa-root{
  --vx-sans:var(--font-inter,"Inter"),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --vx-mono:var(--font-jetbrains-mono,"JetBrains Mono"),"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --vx-display:var(--font-space-grotesk,"Space Grotesk"),var(--vx-sans);
  --background:#F5F5F5;--foreground:#0A0A0B;--muted:rgba(10,10,11,.58);
  --line:rgba(0,0,0,.1);--card:#FFFFFF;--hover:rgba(0,0,0,.035);--grid:rgba(0,0,0,.055);
  position:relative;min-height:100vh;background:var(--background);color:var(--foreground);
  font-family:var(--vx-sans);-webkit-font-smoothing:antialiased;
}
html.dark .vexa-root{
  --background:#0A0A0B;--foreground:#F5F5F5;--muted:rgba(245,245,245,.56);
  --line:rgba(255,255,255,.1);--card:rgba(255,255,255,.02);--hover:rgba(255,255,255,.04);--grid:rgba(255,255,255,.06);
}
.vexa-root .font-mono,.vexa-root code,.vexa-root pre{font-family:var(--vx-mono)}
.vexa-root .font-display{font-family:var(--vx-display)}
.vexa-root .font-sans{font-family:var(--vx-sans)}
.vexa-root ::selection{background:rgba(59,130,246,.28)}
.vexa-root :focus-visible{outline:none;box-shadow:0 0 0 2px var(--background),0 0 0 4px #3B82F6}

.console-card{border:1px solid var(--line);border-radius:1rem;background:var(--card)}
html:not(.dark) .console-card{box-shadow:0 1px 2px rgba(0,0,0,.04),0 14px 30px -18px rgba(0,0,0,.14)}
.vx-hoverbg:hover{background:var(--hover)}
.vx-topbar{background:var(--background);background:color-mix(in srgb,var(--background) 86%,transparent);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}

.vx-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:
    radial-gradient(60% 45% at 50% 0%,rgba(59,130,246,.10),transparent 70%),
    repeating-linear-gradient(0deg,var(--grid) 0,var(--grid) 1px,transparent 1px,transparent 32px),
    repeating-linear-gradient(90deg,var(--grid) 0,var(--grid) 1px,transparent 1px,transparent 32px)}
.vx-content{position:relative;z-index:2}
.vx-beam{position:fixed;left:0;right:0;top:0;height:22vh;z-index:1;pointer-events:none;
  background:linear-gradient(to bottom,transparent,rgba(59,130,246,.05),transparent);
  animation:vx-beam 6s linear infinite}
@keyframes vx-beam{from{transform:translateY(-100%)}to{transform:translateY(calc(100vh + 100%))}}
.vx-caret{display:inline-block;width:6px;height:12px;margin-left:4px;vertical-align:-2px;background:#3B82F6;
  animation:vx-blink 1s steps(2,start) infinite}
@keyframes vx-blink{to{visibility:hidden}}

@media (prefers-reduced-motion:reduce){
  .vx-beam{display:none}
  .vx-caret,.vexa-root .animate-pulse{animation:none}
}
@media print{
  .no-print,.vx-grid,.vx-beam{display:none!important}
  html .vexa-root,html.dark .vexa-root{
    --background:#fff;--foreground:#000;--muted:rgba(0,0,0,.62);--line:rgba(0,0,0,.18);--card:#fff;
    -webkit-print-color-adjust:exact;print-color-adjust:exact}
  .vx-content{padding-top:0!important}
  .console-card{break-inside:avoid;box-shadow:none!important}
}
`;

/* ════════════════════════════════════════════════════════════════════════
   BRAND
   ════════════════════════════════════════════════════════════════════════ */

// One shared path: a rounded square with a V-shaped wedge cut into its top edge.
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
      <VexaMark size={24} />
      <span className="font-display text-xl font-bold tracking-tight">Vexa</span>
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
        stored = null; // storage blocked
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
      /* storage blocked: the theme still applies for this session */
    }
    setDark(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="vx-hoverbg rounded-full p-2 text-[color:var(--muted)] transition hover:text-[color:var(--foreground)]"
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   SHARED UI ATOMS
   ════════════════════════════════════════════════════════════════════════ */

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
    <header className="vx-topbar no-print fixed inset-x-0 top-0 z-50 h-16 border-b border-[color:var(--line)]">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <VexaLogo />
          <span className="hidden border-l border-[color:var(--line)] pl-3 font-mono text-xs tracking-wider text-[color:var(--muted)] sm:inline">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-2 font-mono text-[10px] tracking-widest text-[color:var(--muted)] md:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-500" /> ENGINE ONLINE
            <span className="opacity-40">|</span>
            <Lock size={11} /> NO DATA RETAINED
          </span>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-3 rounded-xl border border-orange-500/30 bg-orange-500/10 p-4 font-mono text-xs text-orange-500"
    >
      <AlertCircle size={16} className="mt-0.5 shrink-0" />
      <span className="leading-relaxed">{message}</span>
    </div>
  );
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-blue-500/25 bg-blue-500/[0.06] p-3 font-mono text-[11px] leading-relaxed text-blue-500">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function TacticChip({ tactic }: { tactic: Tactic }) {
  const base =
    "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider";
  if (tactic === "none") {
    return (
      <span className={`${base} border-green-500/30 bg-green-500/10 text-green-500`}>
        <CircleCheck size={12} /> Clear
      </span>
    );
  }
  const { Icon, label } = TACTICS[tactic];
  return (
    <span className={`${base} border-orange-500/40 bg-orange-500/10 text-orange-500`}>
      <Icon size={12} /> {label}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   REPORT COMPONENTS
   ════════════════════════════════════════════════════════════════════════ */

function ClassificationStamp({ category, risk }: { category: string; risk: number }) {
  const reduce = useReducedMotion();
  const hot = risk > 60;
  return (
    <motion.div
      initial={reduce ? false : { scale: 0.8, rotate: -15, opacity: 0 }}
      animate={{ scale: 1, rotate: -4, opacity: 1 }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 200, damping: 15 }}
      className={`inline-block max-w-full border-2 px-5 py-3 font-mono uppercase ${
        hot ? "border-orange-500 text-orange-500" : "border-blue-500 text-blue-500"
      }`}
      style={{ borderRadius: 6 }}
    >
      <div className="text-[10px] tracking-[0.25em] opacity-80">Vexa forensic classification</div>
      <div className="mt-0.5 break-words text-base font-bold tracking-wider sm:text-xl">CLASSIFIED: {category}</div>
      <div className="mt-1 text-[10px] tracking-[0.25em] opacity-80">
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
      <div className="mb-4 font-mono text-xs tracking-wider text-[color:var(--muted)]">RISK SCORE</div>
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
                  x2={70 + Math.cos(a) * (i % 10 === 0 ? 67 : 65)}
                  y2={70 + Math.sin(a) * (i % 10 === 0 ? 67 : 65)}
                  stroke="var(--line)"
                  strokeWidth={i % 10 === 0 ? 1.6 : 1}
                />
              );
            })}
            <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" strokeWidth="9" />
            <circle
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={color}
              strokeWidth="9"
              strokeLinecap="butt"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - val / 100)}
            />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-5xl font-semibold tabular-nums" style={{ color }} aria-hidden="true">
            {String(Math.round(val)).padStart(2, "0")}
          </span>
          <span className="mt-1 font-mono text-[10px] tracking-[0.25em] text-[color:var(--muted)]">/ 100</span>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-2 font-mono text-xs font-semibold tracking-widest" style={{ color }}>
        {score < 25 ? <CircleCheck size={14} /> : <AlertTriangle size={14} />}
        {riskLevel(score)}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        Risk score {score} out of 100. Threat level {riskLevel(score)}.
      </p>
    </div>
  );
}

const LIST_VARIANTS: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.15 } } };
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

function SegmentReveal({ segments, onSeek }: { segments: Segment[]; onSeek?: (t: number) => void }) {
  const reduce = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const flaggedCount = segments.filter((s) => s.tactic !== "none").length;
  const rows = segments
    .map((seg, index) => ({ seg, index }))
    .filter((r) => filter === "all" || r.seg.tactic !== "none");
  const allOpen = flaggedCount > 0 && segments.every((s, i) => s.tactic === "none" || open[i]);

  function toggleAll() {
    if (allOpen) {
      setOpen({});
      return;
    }
    const next: Record<number, boolean> = {};
    segments.forEach((s, i) => {
      if (s.tactic !== "none") next[i] = true;
    });
    setOpen(next);
  }

  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 font-mono text-[11px] font-semibold transition ${
      active
        ? "border-blue-500 bg-blue-500/10 text-blue-500"
        : "vx-hoverbg border-[color:var(--line)] text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
    }`;

  return (
    <div>
      <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Filter segments" className="flex gap-2">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className={pill(filter === "all")}>
            All ({segments.length})
          </button>
          <button
            type="button"
            aria-pressed={filter === "flagged"}
            onClick={() => setFilter("flagged")}
            className={pill(filter === "flagged")}
          >
            Flagged ({flaggedCount})
          </button>
        </div>
        {flaggedCount > 0 && (
          <button type="button" onClick={toggleAll} className={pill(false)}>
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="console-card flex items-center gap-3 p-5 font-mono text-xs text-green-500">
          <CircleCheck size={16} /> No manipulation tactics were flagged in this call.
        </div>
      ) : (
        <motion.ol
          key={filter}
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
                variants={reduce ? undefined : ITEM_VARIANTS}
                className={`console-card relative grid grid-cols-[3rem_1fr] gap-x-3 p-4 ${flagged ? "" : "opacity-80"}`}
              >
                {flagged && <span className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-orange-500" aria-hidden="true" />}
                <div className="pt-0.5 font-mono text-[11px] leading-tight text-[color:var(--muted)]">
                  <div>{String(index + 1).padStart(2, "0")}</div>
                  {seg.start !== undefined && <div className="mt-1 opacity-80">{clock(seg.start)}</div>}
                </div>

                <div className="min-w-0">
                  {flagged ? (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => setOpen((o) => ({ ...o, [index]: !o[index] }))}
                      className="flex w-full flex-col gap-2 rounded-lg text-left sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                    >
                      <span className="text-sm leading-relaxed">{seg.text}</span>
                      <TacticChip tactic={seg.tactic} />
                    </button>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <span className="text-sm leading-relaxed">{seg.text}</span>
                      <TacticChip tactic="none" />
                    </div>
                  )}

                  <AnimatePresence initial={false}>
                    {flagged && isOpen && (
                      <motion.div
                        id={panelId}
                        initial={reduce ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
                        transition={{ duration: reduce ? 0 : 0.25, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div className="space-y-3 pt-4">
                          {seg.explanation && (
                            <div>
                              <div className="font-mono text-[10px] tracking-widest text-[color:var(--muted)]">WHY IT IS FLAGGED</div>
                              <p className="mt-1 text-sm leading-relaxed text-[color:var(--muted)]">{seg.explanation}</p>
                            </div>
                          )}
                          {seg.counterAdvice && (
                            <div className="border-l-2 border-orange-500 pl-3">
                              <div className="font-mono text-[10px] tracking-widest text-orange-500">WHAT YOU COULD HAVE SAID</div>
                              <p className="mt-1 text-sm leading-relaxed">{seg.counterAdvice}</p>
                            </div>
                          )}
                          {onSeek && seg.start !== undefined && (
                            <button
                              type="button"
                              onClick={() => onSeek(seg.start ?? 0)}
                              className="no-print vx-hoverbg inline-flex items-center gap-1.5 rounded-full border border-[color:var(--line)] px-3 py-1 font-mono text-[11px] text-blue-500 transition"
                            >
                              <Play size={11} /> Play from {clock(seg.start)}
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
  const data = useMemo(
    () => TACTIC_IDS.map((id) => ({ tactic: TACTICS[id].short, count: counts[id] })),
    [counts]
  );
  const color = risk > 60 ? "#F97316" : "#3B82F6";
  return (
    <div className="console-card p-6">
      <div className="mb-2 font-mono text-xs tracking-wider text-[color:var(--muted)]">TACTIC RADAR</div>
      <div className="h-[270px] w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="66%" margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
            <PolarGrid stroke="rgba(59,130,246,0.28)" />
            <PolarAngleAxis
              dataKey="tactic"
              tick={{ fill: "var(--muted)", fontSize: 9, fontFamily: "var(--vx-mono)" }}
            />
            <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
            <Radar
              dataKey="count"
              stroke={color}
              fill={color}
              fillOpacity={0.3}
              strokeWidth={2}
              isAnimationActive={!reduce}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Tactic counts</caption>
        <tbody>
          {TACTIC_IDS.map((id) => (
            <tr key={id}>
              <th scope="row">{TACTICS[id].label}</th>
              <td>{counts[id]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CadenceChart({
  telemetry,
  summary,
  flaggedTimes,
}: {
  telemetry: CadencePoint[];
  summary?: AudioSummary;
  flaggedTimes: number[];
}) {
  const reduce = useReducedMotion();
  const gid = `cad${useId().replace(/:/g, "")}`;
  const data = telemetry.map((p) => ({ t: p.timestamp, energy: p.energy }));
  return (
    <div className="console-card p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs tracking-wider text-blue-500">{"// VOCAL CADENCE TELEMETRY"}</span>
        {summary && (
          <span className="font-mono text-[11px] text-[color:var(--muted)]">
            {summary.pauseCount} PAUSES · LONGEST {summary.longestPauseSec.toFixed(1)}s · {summary.paceSpikeTimestamps.length} PACE SPIKES
          </span>
        )}
      </div>
      <div className="h-[190px] w-full" role="img" aria-label="Chart of vocal energy over time">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#3B82F6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--line)" />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) => clock(Number(v))}
              tick={{ fill: "var(--muted)", fontSize: 10, fontFamily: "var(--vx-mono)" }}
              stroke="var(--line)"
            />
            <YAxis hide />
            <Tooltip
              cursor={{ stroke: "rgba(59,130,246,0.4)" }}
              contentStyle={{
                background: "var(--background)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                fontFamily: "var(--vx-mono)",
                fontSize: 11,
              }}
              labelFormatter={(l) => clock(Number(l))}
              formatter={(v) => [Number(v).toFixed(3), "energy"]}
            />
            <Area
              type="monotone"
              dataKey="energy"
              stroke="#3B82F6"
              strokeWidth={1.5}
              fill={`url(#${gid})`}
              isAnimationActive={!reduce}
            />
            {flaggedTimes.map((t, i) => (
              <ReferenceLine key={`${t}-${i}`} x={t} stroke="#F97316" strokeDasharray="3 3" />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 font-mono text-[10px] text-[color:var(--muted)]">
        Blue area = vocal energy (RMS). Dashed orange lines = moments where a manipulation tactic was flagged.
      </p>
    </div>
  );
}

const LOG_TEXT = [
  "$ vexa --analyze transcript",
  "Parsing transcript…",
  "Segmenting dialogue into evidence units…",
  "Cross-referencing tactic database…",
  "Scoring urgency, authority and isolation signals…",
  "Matching FTC/FBI scam categories…",
  "Compiling evidentiary dossier…",
];
const LOG_MEDIA = [
  "$ vexa --ingest evidence",
  "Verifying media container…",
  "Extracting audio track…",
  "Transcribing speech…",
  "Cross-referencing tactic database…",
  "Scoring vocal cadence against content…",
  "Matching FTC/FBI scam categories…",
  "Compiling evidentiary dossier…",
];

function LogBody({ lines, count, active }: { lines: string[]; count: number; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div
      ref={ref}
      className="max-h-40 overflow-y-auto rounded-xl border border-[color:var(--line)] p-3 font-mono text-[11px] leading-relaxed"
    >
      {lines.slice(0, count).map((line, i) => (
        <p key={line} className="text-[color:var(--muted)]">
          <span className="text-blue-500">›</span> {line}
          {active && i === count - 1 && <span className="vx-caret" aria-hidden="true" />}
        </p>
      ))}
    </div>
  );
}

function TerminalLog({
  isLoading,
  complete = false,
  mode,
}: {
  isLoading: boolean;
  complete?: boolean;
  mode: "media" | "text";
}) {
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
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 rounded-lg font-mono text-xs"
        >
          <span className="flex items-center gap-2 text-blue-500">
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
      <div className="mb-2 font-mono text-[10px] tracking-widest text-[color:var(--muted)]">SYSTEM LOG</div>
      <LogBody lines={lines} count={count} active />
    </div>
  );
}

function ScanMetadata({ report, mode, audio }: { report: Report; mode: "ai" | "fallback" | "cached"; audio: boolean }) {
  const flagged = report.segments.filter((s) => s.tactic !== "none").length;
  const modeLabel = mode === "ai" ? "AI · Gemini" : mode === "cached" ? "Cached · verified" : "Fallback · heuristic";
  const rows: Array<[string, string]> = [
    ["Category", report.category],
    ["Processing time", report.processingMs !== undefined ? `${(report.processingMs / 1000).toFixed(2)} s` : "—"],
    ["Segments analyzed", String(report.segments.length)],
    ["Segments flagged", String(flagged)],
    ["Input", audio ? "Audio / video" : "Transcript"],
    ["Analysis mode", modeLabel],
  ];
  return (
    <div className="console-card p-6">
      <div className="mb-3 font-mono text-xs tracking-wider text-[color:var(--muted)]">SCAN METADATA</div>
      <dl className="divide-y divide-[color:var(--line)] font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-2">
            <dt className="shrink-0 text-[color:var(--muted)]">{k.toUpperCase()}</dt>
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
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 font-mono text-xs"
      >
        <span className="tracking-wider text-[color:var(--muted)]">TACTIC GLOSSARY · 7 TACTICS</span>
        <ChevronDown size={15} className={`text-[color:var(--muted)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id={panelId} className="mt-3 space-y-3 border-t border-[color:var(--line)] px-2 pt-4">
          {TACTIC_IDS.map((id) => {
            const { Icon, label, def } = TACTICS[id];
            return (
              <li key={id} className="flex items-start gap-3">
                <Icon size={16} className="mt-0.5 shrink-0 text-orange-500" />
                <div>
                  <div className="font-mono text-xs font-semibold">{label}</div>
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
  "Government Imposter Scam":
    "Agencies never demand gift cards, crypto or wires. Hang up and reach the agency through the number on its official website.",
  "Grandparent/Family Emergency Scam":
    "Hang up and call your family member on a number you already have. Agree on a family code word for real emergencies.",
  "Tech Support Scam":
    "Legitimate companies don't cold-call about viruses. Never install software or grant remote access to a caller.",
  "Romance Scam": "Never send money to someone you haven't met in person. Reverse-search their photos and talk it over with a friend.",
  "Prize/Lottery Scam": "You can't win a contest you didn't enter, and real prizes never require upfront fees.",
  "Investment/Crypto Scam": "Guaranteed returns don't exist. Check the firm's registration with your securities regulator first.",
  "Bank/Financial Institution Imposter Scam":
    "Hang up and call the number printed on your card. Banks never ask for full PINs or one-time codes.",
};

function InsightsPanel({ report }: { report: Report }) {
  const total = report.segments.length;
  const flagged = report.segments.filter((s) => s.tactic !== "none").length;
  const firstIdx = report.segments.findIndex((s) => s.tactic !== "none");
  const active = TACTIC_IDS.filter((id) => report.tacticCounts[id] > 0).sort(
    (a, b) => report.tacticCounts[b] - report.tacticCounts[a]
  );
  const dominant = active[0];
  const maxCount = dominant ? report.tacticCounts[dominant] : 1;
  const clear = report.riskScore < 25;

  const actions: string[] = clear
    ? ["Low risk detected. Still verify unexpected callers independently before sharing personal information."]
    : [
        CATEGORY_ACTION[report.category] ?? "Hang up and verify the caller through an official number you look up yourself.",
        "Never share codes, PINs, passwords or remote access with someone who called you.",
        "Already paid or shared details? Contact your bank right away and change affected passwords.",
        "Report it to the Canadian Anti-Fraud Centre (antifraudcentre.ca) or, in the US, the FTC (reportfraud.ftc.gov).",
      ];

  const tiles: Array<{ k: string; v: React.ReactNode }> = [
    { k: "FLAGGED LINES", v: `${flagged} / ${total}` },
    {
      k: "DOMINANT TACTIC",
      v: dominant ? (
        <span className="flex items-center gap-1.5">
          {(() => {
            const { Icon } = TACTICS[dominant];
            return <Icon size={14} className="shrink-0 text-orange-500" />;
          })()}
          <span className="truncate">{TACTICS[dominant].label}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-green-500">
          <CircleCheck size={14} /> None
        </span>
      ),
    },
    { k: "FIRST RED FLAG", v: firstIdx >= 0 ? `Line ${firstIdx + 1}` : "—" },
    { k: "TACTIC VARIETY", v: `${active.length} / 7` },
  ];

  return (
    <div className="console-card p-6">
      <span className="font-mono text-xs tracking-wider text-blue-500">{"// KEY INSIGHTS"}</span>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="min-w-0 rounded-xl border border-[color:var(--line)] p-3">
            <div className="font-mono text-[10px] tracking-widest text-[color:var(--muted)]">{t.k}</div>
            <div className="mt-1.5 font-mono text-sm font-semibold">{t.v}</div>
          </div>
        ))}
      </div>

      {active.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="Tactic frequency">
          {active.map((id) => {
            const { Icon, label } = TACTICS[id];
            const n = report.tacticCounts[id];
            return (
              <li key={id} className="flex items-center gap-3 font-mono text-xs">
                <Icon size={14} className="shrink-0 text-orange-500" />
                <span className="w-36 shrink-0 truncate">{label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--line)]">
                  <span className="block h-full rounded-full bg-orange-500" style={{ width: `${(n / maxCount) * 100}%` }} />
                </span>
                <span className="w-5 text-right font-semibold">{n}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 border-t border-[color:var(--line)] pt-4">
        <div className="mb-2 font-mono text-[10px] tracking-widest text-[color:var(--muted)]">
          {clear ? "ASSESSMENT" : "RECOMMENDED ACTIONS"}
        </div>
        <ul className="space-y-2 text-sm leading-relaxed">
          {actions.map((a) => (
            <li key={a} className="flex items-start gap-2.5">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${clear ? "bg-green-500" : "bg-blue-500"}`} />
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
  transcript,
  cadence,
  audioSummary,
  audioNote,
  previewUrl,
  previewKind,
  fromMedia,
  onReset,
}: {
  report: Report;
  transcript: string;
  cadence: CadencePoint[];
  audioSummary?: AudioSummary;
  audioNote: string;
  previewUrl: string;
  previewKind: Kind;
  fromMedia: boolean;
  onReset: () => void;
}) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playerError, setPlayerError] = useState(false);

  const mode = report.mode ?? "ai";
  const engineLabel =
    mode === "cached" ? "Pre-verified Telemetry" : mode === "fallback" ? "Offline Heuristic Engine" : "Gemini Multimodal";
  const transcriptText =
    transcript ||
    (report.segments.length ? report.segments.map((s) => s.text).join("\n") : "") ||
    "Extracted dialogue recorded.";

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
    const blob = new Blob(
      [JSON.stringify({ generatedAt: new Date().toISOString(), ...report, transcript: transcriptText }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vexa-dossier-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const showPlayer = fromMedia && Boolean(previewUrl) && !playerError;
  const pill =
    "vx-hoverbg flex items-center gap-1.5 rounded-full border border-[color:var(--line)] px-3 py-1.5 text-[color:var(--muted)] transition hover:border-blue-500/40 hover:text-[color:var(--foreground)]";

  return (
    <Shell beam>
      <TopBar label="EVIDENTIARY DOSSIER" />

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="no-print mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--line)] pb-4 font-mono text-xs">
          <button type="button" onClick={onReset} className={pill}>
            <ArrowLeft size={14} /> New Inspection
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={download} className={pill}>
              <Download size={13} /> JSON
            </button>
            <button type="button" onClick={() => window.print()} className={pill}>
              <Printer size={13} /> Print / PDF
            </button>
            <span>
              <span className="text-[color:var(--muted)]">ENGINE: </span>
              <span className="font-semibold uppercase text-blue-500">{engineLabel}</span>
            </span>
          </div>
        </div>

        {/* Mobile: single column in spec order via `order-*`. Desktop: [main | sticky rail]. */}
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[1fr_380px] lg:items-start">
          <section className="contents lg:block lg:min-w-0 lg:space-y-6">
            <div className="order-1 lg:order-none">
              <ClassificationStamp category={report.category} risk={report.riskScore} />
            </div>

            <div className="console-card order-3 p-6 lg:order-none">
              <span className="font-mono text-xs tracking-wider text-blue-500">{"// FORENSIC ASSESSMENT"}</span>
              <p className="mt-2 font-sans text-lg font-semibold leading-snug sm:text-xl">{report.summary}</p>
              {report.fileName && (
                <p className="mt-3 font-mono text-[11px] text-[color:var(--muted)]">EXHIBIT: {report.fileName}</p>
              )}
            </div>

            {report.fallbackReason && (
              <div className="order-4 lg:order-none">
                <InlineError
                  message={`Simplified analysis — ${reasonText(report.fallbackReason)}. Results come from the local rule-based engine and may be less accurate than the AI analysis.`}
                />
              </div>
            )}

            {showPlayer && (
              <div className="console-card no-print order-4 p-6 lg:order-none">
                <div className="mb-3 font-mono text-xs tracking-wider text-[color:var(--muted)]">EVIDENCE PLAYBACK</div>
                {previewKind === "audio" ? (
                  <audio
                    ref={(el) => {
                      mediaRef.current = el;
                    }}
                    src={previewUrl}
                    controls
                    onError={() => setPlayerError(true)}
                    className="w-full"
                  />
                ) : (
                  <video
                    ref={(el) => {
                      mediaRef.current = el;
                    }}
                    src={previewUrl}
                    controls
                    playsInline
                    onError={() => setPlayerError(true)}
                    className="max-h-72 w-full rounded-xl border border-[color:var(--line)] bg-black"
                  />
                )}
                <p className="mt-2 font-mono text-[10px] text-[color:var(--muted)]">
                  Expand a flagged line and press &ldquo;Play from&rdquo; to jump to that moment.
                </p>
              </div>
            )}

            <div className="order-5 lg:order-none">
              <InsightsPanel report={report} />
            </div>

            <div className="order-6 lg:order-none">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs tracking-wider text-blue-500">{"// EVIDENCE TIMELINE"}</span>
                <span className="font-mono text-xs text-[color:var(--muted)]">{report.segments.length} SEGMENTS</span>
              </div>
              <SegmentReveal segments={report.segments} onSeek={showPlayer ? seek : undefined} />
            </div>

            <div className="console-card order-7 p-6 lg:order-none">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-xs tracking-wider text-[color:var(--muted)]">DECODED TRANSCRIPT LOG</span>
                <span className="font-mono text-[10px] text-[color:var(--muted)]">CHRONOLOGICAL</span>
              </div>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[color:var(--line)] pt-3 font-mono text-xs leading-relaxed opacity-80">
                {transcriptText}
              </pre>
            </div>

            {fromMedia && (cadence.length > 0 || audioNote) && (
              <div className="order-8 lg:order-none">
                {cadence.length > 0 && (
                  <CadenceChart telemetry={cadence} summary={audioSummary} flaggedTimes={flaggedTimes} />
                )}
                {audioNote && <p className="mt-3 font-mono text-xs text-[color:var(--muted)]">{audioNote}</p>}
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

/* ════════════════════════════════════════════════════════════════════════
   PAGE
   ════════════════════════════════════════════════════════════════════════ */

class RequestError extends Error {}

const HERO_CHIPS = ["7 tactic classes", "Line-by-line evidence", "Audio cadence telemetry"];

export default function Page() {
  const [tab, setTab] = useState<Tab>("recording");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [previewKind, setPreviewKind] = useState<Kind>("video");
  const [previewError, setPreviewError] = useState(false);
  const [selectedDemo, setSelectedDemo] = useState<Demo | null>(null);
  const [liveDemo, setLiveDemo] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [reportTranscript, setReportTranscript] = useState("");
  const [reportFromMedia, setReportFromMedia] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [cadence, setCadence] = useState<CadencePoint[]>([]);
  const [audioSummary, setAudioSummary] = useState<AudioSummary | undefined>();
  const [audioNote, setAudioNote] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const compactRef = useRef<File | null>(null);
  const loadToken = useRef(0);
  const previewRef = useRef("");
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chooseFileRef = useRef<(f: File) => Promise<void>>(async () => undefined);
  const tabIds = useId().replace(/:/g, "");

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    return () => {
      if (previewRef.current.startsWith("blob:")) URL.revokeObjectURL(previewRef.current);
      xhrRef.current?.abort();
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const clearMedia = useCallback(() => {
    loadToken.current += 1;
    if (previewRef.current.startsWith("blob:")) URL.revokeObjectURL(previewRef.current);
    setFile(null);
    setPreview("");
    setPreviewError(false);
    setSelectedDemo(null);
    setCadence([]);
    setAudioSummary(undefined);
    setAudioNote("");
    setDecoding(false);
    setProgress(0);
    compactRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  function showReport(next: Report, text: string, fromMedia = false) {
    setReport(next);
    setReportTranscript(text);
    setReportFromMedia(fromMedia);
  }

  async function runCadence(source: File, token: number) {
    setDecoding(true);
    try {
      const decoded = await analyzeAudio(source);
      if (token !== loadToken.current) return;
      setCadence(decoded.telemetry);
      setAudioSummary(decoded.summary);
      compactRef.current = decoded.compactWav;
      if (decoded.telemetry.length === 0) {
        setAudioNote("Acoustic cadence is unavailable for this container; content analysis remains fully active.");
      }
    } catch {
      if (token === loadToken.current) setAudioNote("Acoustic cadence skipped; content analysis remains active.");
    } finally {
      if (token === loadToken.current) setDecoding(false);
    }
  }

  async function chooseFile(candidate: File) {
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
    setPreviewKind(kindOf(candidate));
    setPreview(URL.createObjectURL(candidate));
    await runCadence(candidate, token);
  }
  chooseFileRef.current = chooseFile;

  function chooseDemo(demo: Demo) {
    setError("");
    clearMedia();
    const token = loadToken.current;
    setSelectedDemo(demo);
    setPreviewKind("video");
    const url = `/demo/${demo.file}`;
    setPreview(url);
    const example = EXAMPLES.find((item) => item.id === demo.id);
    if (example) setTranscript(example.transcript);

    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size < 50000 || blob.type.includes("html") || token !== loadToken.current) return;
        await runCadence(new File([blob], demo.file, { type: "video/mp4" }), token);
      } catch {
        /* the preview UI reports a missing file */
      }
    })();
  }

  /* ---------- Microphone recording ---------- */
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

  /* ---------- Analysis ---------- */
  async function analyzeText() {
    if (!transcript.trim()) {
      setError("Paste a call transcript into the console before analyzing.");
      return;
    }
    setBusy(true);
    setPhase("analyzing");
    setError("");
    const started = Date.now();
    try {
      let data: Report | undefined;
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript, audioSummary }),
        });
        const json: unknown = await response.json().catch(() => null);
        if (response.ok && isRecord(json)) {
          data = normalizeReport(json);
        } else if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429) {
          throw new RequestError(errorMessage(json, "Analysis request failed."));
        } else {
          data = heuristicAnalyze(transcript, `http_${response.status}`);
        }
      } catch (caught) {
        if (caught instanceof RequestError) throw caught;
        data = heuristicAnalyze(transcript, "network");
      }
      const elapsed = Date.now() - started;
      if (elapsed < MIN_ANALYSIS_MS) await sleep(MIN_ANALYSIS_MS - elapsed);
      showReport({ ...data, mode: modeOf(data), processingMs: Date.now() - started }, transcript, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Text analysis failed.");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  function uploadWithProgress(media: File): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", "/api/analyze-media");
      xhr.timeout = 120000;
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
          reject(
            new Error(
              xhr.status === 413
                ? "The file is too large for the server. Try a shorter clip."
                : "The forensic server returned an unreadable response."
            )
          );
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
    setBusy(true);
    setError("");
    setProgress(0);
    setPhase(selectedDemo ? "analyzing" : "uploading");
    const started = Date.now();
    try {
      let data: Report;
      if (selectedDemo) {
        const response = await fetch("/api/analyze-media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ demoId: selectedDemo.id, live: liveDemo }),
        });
        const json: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorMessage(json, "Demonstration analysis failed."));
        data = normalizeReport(json);
      } else if (file) {
        const compact = compactRef.current;
        const useCompact = file.size > DIRECT_UPLOAD_LIMIT && compact !== null && compact.size < file.size;
        if (file.size > DIRECT_UPLOAD_LIMIT && !useCompact) {
          throw new Error(
            "This file is too large to upload directly and its audio couldn't be compressed in your browser. Try a shorter clip or a .wav/.mp3 file."
          );
        }
        const json = await uploadWithProgress(useCompact && compact ? compact : file);
        data = normalizeReport(json);
        data.fileName = file.name;
      } else {
        throw new Error("Select or attach an evidentiary media file first.");
      }
      const elapsed = Date.now() - started;
      if (elapsed < MIN_ANALYSIS_MS) await sleep(MIN_ANALYSIS_MS - elapsed);
      const example = selectedDemo ? EXAMPLES.find((e) => e.id === selectedDemo.id) : undefined;
      showReport(
        { ...data, inputMode: data.inputMode ?? "media", mode: modeOf(data), processingMs: Date.now() - started },
        example?.transcript ?? "",
        true
      );
    } catch (caught) {
      const matched = selectedDemo ? (EXAMPLES.find((e) => e.id === selectedDemo.id) ?? EXAMPLES[0]) : undefined;
      if (selectedDemo && matched) {
        // Demo videos always resolve: fall back to the verified, pre-computed report.
        await sleep(800);
        showReport(
          {
            ...matched.result,
            inputMode: "media",
            fileName: selectedDemo.file,
            mode: "cached",
            cached: true,
            processingMs: Date.now() - started,
          },
          matched.transcript,
          true
        );
      } else {
        setError(caught instanceof Error ? caught.message : "Media analysis failed.");
      }
    } finally {
      setBusy(false);
      setPhase("idle");
      xhrRef.current = null;
    }
  }

  function reset() {
    setReport(null);
    setReportTranscript("");
    setReportFromMedia(false);
    setTranscript("");
    setError("");
    clearMedia();
  }

  if (report) {
    return (
      <ReportView
        report={report}
        transcript={reportTranscript}
        cadence={reportFromMedia ? cadence : []}
        audioSummary={reportFromMedia ? audioSummary : undefined}
        audioNote={reportFromMedia ? audioNote : ""}
        previewUrl={preview}
        previewKind={previewKind}
        fromMedia={reportFromMedia}
        onReset={reset}
      />
    );
  }

  const hasMedia = Boolean(file || selectedDemo);
  const statusLabel =
    phase === "uploading" ? `Uploading evidence… ${progress}%` : phase === "analyzing" ? "Analyzing call…" : "";

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
        {/* Hero */}
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              <p className="font-mono text-xs uppercase tracking-wide text-blue-500">{"// THREAT ANALYSIS CONSOLE"}</p>
            </div>
            <h1 className="font-display text-6xl font-bold leading-[0.9] tracking-tight sm:text-7xl">Vexa</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-[color:var(--muted)]">
              Upload a call recording or paste a transcript. See exactly which manipulation tactic is used, line by line.
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {HERO_CHIPS.map((chip) => (
                <li
                  key={chip}
                  className="flex items-center gap-2 rounded-full border border-[color:var(--line)] px-3 py-1 font-mono text-[11px] text-[color:var(--muted)]"
                >
                  <span className="h-1 w-1 rounded-full bg-blue-500" />
                  {chip}
                </li>
              ))}
            </ul>
          </div>
          <VexaMark size={112} className="hidden shrink-0 sm:block" />
        </div>

        {/* Input card */}
        <section className="console-card mt-10 p-6">
          <div
            role="tablist"
            aria-label="Input type"
            className="mb-6 grid grid-cols-2 gap-1 rounded-full border border-[color:var(--line)] p-1"
          >
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
                className={`flex items-center justify-center gap-2 rounded-full px-4 py-2.5 font-mono text-xs font-semibold tracking-wide transition disabled:cursor-not-allowed ${
                  tab === id ? "bg-blue-600 text-white" : "text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
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
                  className={`flex items-center justify-center gap-4 rounded-2xl border border-dashed p-7 text-center transition disabled:opacity-50 ${
                    dragging
                      ? "border-blue-500 bg-blue-500/10"
                      : "vx-hoverbg border-[color:var(--line)] hover:border-blue-500/40"
                  }`}
                >
                  <Upload size={22} className="shrink-0 text-blue-500" />
                  <div className="min-w-0 text-left font-mono text-xs">
                    <span className="block truncate font-semibold">
                      {file
                        ? `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
                        : "Drop a call recording, or click to upload"}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[color:var(--muted)]">
                      .mp4 · .webm · .mp3 · .wav · .m4a — max 20 MB
                    </span>
                  </div>
                </button>

                {recording ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    aria-label={`Stop recording, ${clock(recSeconds)} elapsed`}
                    className="flex items-center justify-center gap-2 rounded-2xl border border-orange-500/50 bg-orange-500/10 px-6 py-4 font-mono text-xs font-semibold text-orange-500"
                  >
                    <Square size={14} className="animate-pulse" /> Stop · {clock(recSeconds)}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void startRecording()}
                    className="flex items-center justify-center gap-2 rounded-2xl border border-[color:var(--line)] px-6 py-4 font-mono text-xs font-semibold transition hover:border-blue-500/40 hover:text-blue-500 disabled:opacity-50"
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

              <div className="mt-6 border-t border-[color:var(--line)] pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-mono text-xs text-[color:var(--muted)]">Try an example:</p>
                  <span className="font-mono text-[10px] text-[color:var(--muted)]">Staged — not real recordings</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {DEMOS.map((demo) => {
                    const active = selectedDemo?.id === demo.id;
                    return (
                      <button
                        key={demo.id}
                        type="button"
                        disabled={busy || recording}
                        onClick={() => chooseDemo(demo)}
                        aria-pressed={active}
                        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs transition disabled:opacity-50 ${
                          active
                            ? "border-blue-500 bg-blue-500/10 text-blue-500"
                            : "vx-hoverbg border-[color:var(--line)] hover:border-blue-500/40"
                        }`}
                      >
                        <FileVideo size={13} className="text-blue-500" />
                        {demo.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {preview && (
                <div className="mt-5 rounded-2xl border border-[color:var(--line)] p-4">
                  <div className="mb-2 flex items-center justify-between font-mono text-xs">
                    <span className="max-w-[80%] truncate font-semibold">{selectedDemo?.file ?? file?.name}</span>
                    <button
                      type="button"
                      onClick={clearMedia}
                      disabled={busy}
                      aria-label="Remove media"
                      className="rounded p-1 text-[color:var(--muted)] transition hover:text-[color:var(--foreground)] disabled:opacity-40"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  {previewError ? (
                    <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-[color:var(--line)] px-4 py-8 text-center font-mono text-[11px] leading-relaxed text-[color:var(--muted)]">
                      <FileVideo size={22} />
                      {selectedDemo ? (
                        <>
                          <span>
                            Video preview unavailable — <code>/public/demo/{selectedDemo.file}</code> is missing.
                          </span>
                          <span className="text-blue-500">Analysis still runs from the verified scenario script.</span>
                        </>
                      ) : (
                        <span>Your browser can&apos;t preview this file, but it can still be analyzed.</span>
                      )}
                    </div>
                  ) : previewKind === "audio" ? (
                    <audio
                      key={preview}
                      src={preview}
                      controls
                      preload="metadata"
                      onError={() => setPreviewError(true)}
                      className="mt-2 w-full"
                    />
                  ) : (
                    <video
                      key={preview}
                      src={preview}
                      controls
                      playsInline
                      preload="metadata"
                      onLoadedMetadata={() => setPreviewError(false)}
                      onError={() => setPreviewError(true)}
                      className="mt-2 max-h-64 w-full rounded-xl border border-[color:var(--line)] bg-black"
                    />
                  )}

                  {decoding && (
                    <p className="mt-2 flex items-center gap-2 font-mono text-[11px] text-[color:var(--muted)]" role="status">
                      <Loader2 size={12} className="animate-spin" /> Extracting acoustic cadence…
                    </p>
                  )}
                  {!decoding && cadence.length > 0 && (
                    <p className="mt-2 font-mono text-[11px] text-blue-500">
                      ✓ Cadence telemetry ready{audioSummary ? ` · ${audioSummary.pauseCount} pauses detected` : ""}
                    </p>
                  )}
                  {audioNote && <p className="mt-2 font-mono text-[11px] text-[color:var(--muted)]">{audioNote}</p>}
                </div>
              )}

              {selectedDemo && (
                <>
                  <details className="mt-3 rounded-2xl border border-[color:var(--line)] p-4 font-mono text-[11px] text-[color:var(--muted)]">
                    <summary className="cursor-pointer rounded font-semibold text-[color:var(--foreground)]">
                      Make your own test recording — read this script aloud
                    </summary>
                    <p className="mt-3 leading-relaxed">
                      Use <strong>Record</strong> above (or your phone), read both roles, aim for 30–60 s, then analyze it
                      to exercise the full real pipeline.
                    </p>
                    <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">{transcript}</pre>
                  </details>
                  <label className="mt-3 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-[color:var(--muted)]">
                    <input
                      type="checkbox"
                      checked={liveDemo}
                      onChange={(e) => setLiveDemo(e.target.checked)}
                      className="accent-blue-500"
                    />
                    Run live Gemini on this demo video (default: instant verified report)
                  </label>
                </>
              )}

              {busy && phase === "uploading" && (
                <div className="mt-4">
                  <div className="mb-1 flex justify-between font-mono text-[11px] text-[color:var(--muted)]">
                    <span>INGESTION PROGRESS</span>
                    <span>{progress}%</span>
                  </div>
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--line)]"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-label="Upload progress"
                  >
                    <div className="h-full bg-blue-500 transition-all duration-150" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              {error && <InlineError message={error} />}

              <button
                type="button"
                disabled={busy || decoding || recording || !hasMedia}
                onClick={() => void analyzeMedia()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3.5 font-mono text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-[color:var(--line)] disabled:text-[color:var(--muted)]"
              >
                {busy || decoding ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}
                {busy ? statusLabel : decoding ? "Preparing audio…" : "Analyze Call"}
              </button>
              {!hasMedia && !recording && !busy && (
                <InlineNote>Attach or record a call — or pick an example — to begin.</InlineNote>
              )}
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
                  placeholder="Paste a call transcript here — speaker labels are optional, Vexa infers who is speaking."
                  className="min-h-[220px] w-full resize-y rounded-2xl border border-[color:var(--line)] bg-transparent p-4 pb-8 font-mono text-xs leading-relaxed outline-none transition placeholder:text-[color:var(--muted)] focus:border-blue-500/60 sm:text-sm"
                />
                <span
                  className={`pointer-events-none absolute bottom-3 right-4 font-mono text-xs ${
                    transcript.length > 18000 ? "text-orange-500" : "text-[color:var(--muted)]"
                  }`}
                >
                  {transcript.length.toLocaleString()} / {MAX_TRANSCRIPT_CHARS.toLocaleString()}
                </span>
              </div>

              <div className="mt-6 border-t border-[color:var(--line)] pt-5">
                <p className="mb-3 font-mono text-xs text-[color:var(--muted)]">Try an example:</p>
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setTranscript(example.transcript);
                        clearMedia();
                        showReport(
                          { ...example.result, inputMode: "transcript", mode: "cached", cached: true, processingMs: 0 },
                          example.transcript,
                          false
                        );
                      }}
                      className="vx-hoverbg flex items-center gap-1.5 rounded-full border border-[color:var(--line)] px-3.5 py-1.5 font-mono text-xs transition hover:border-blue-500/40 disabled:opacity-40"
                    >
                      <Sparkles size={13} className="text-blue-500" />
                      {example.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && <InlineError message={error} />}

              <button
                type="button"
                disabled={busy || !transcript.trim()}
                onClick={() => void analyzeText()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3.5 font-mono text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-[color:var(--line)] disabled:text-[color:var(--muted)]"
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <ShieldAlert size={15} />}
                {busy ? statusLabel || "Analyzing…" : "Analyze Call"}
              </button>
              {!transcript.trim() && !busy && (
                <InlineNote>Paste a transcript above — or pick an example — to begin.</InlineNote>
              )}
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

        <footer className="mt-12 border-t border-[color:var(--line)] pt-6 font-mono text-[11px] leading-relaxed text-[color:var(--muted)]">
          AI disclosure — analysis is produced by Google Gemini with a rule-based offline fallback. Scores are decision
          support, not proof; recordings are not stored.{" "}
          <a
            href="#glossary"
            onClick={() => window.dispatchEvent(new Event("vexa:glossary"))}
            className="rounded text-blue-500 underline underline-offset-2"
          >
            Tactic glossary
          </a>
          . Built for the TLN Cybersecurity Challenge 2026.
        </footer>
      </main>
    </Shell>
  );
}