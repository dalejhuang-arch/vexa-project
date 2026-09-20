// lib/heuristicFallback.ts  (pure TS: safe on server AND in the browser)
import {
  categories,
  tactics,
  type Analysis,
  type Segment,
  type Speaker,
  type Tactic,
  type TacticValue,
  type Verdict,
} from "./schema";
import { parseTurns, type Turn } from "./transcript";

export const TACTIC_EXPLAIN: Record<Tactic, string> = {
  urgency: "Creates artificial time pressure so you skip verification.",
  authority_impersonation: "Claims an official role to borrow credibility it hasn't earned.",
  isolation: "Tries to keep you away from anyone who could challenge the story.",
  threat: "Uses fear of consequences to override your judgment.",
  too_good_to_be_true: "Offers an unrealistic reward to lower your guard.",
  payment_request: "Requests money through channels that are hard to trace or reverse.",
  personal_info_request: "Tries to collect identity details, codes or device access.",
};

export const TACTIC_COUNTER: Record<Tactic, string> = {
  urgency: "I don't make decisions under pressure. I'll verify this myself and call you back.",
  authority_impersonation: "Give me your name and a case number. I'll hang up and call the official number myself.",
  isolation: "I talk big decisions over with family. If this is legitimate, that won't be a problem.",
  threat: "Real agencies don't threaten arrest over the phone. I'm ending this call and checking directly.",
  too_good_to_be_true: "I didn't enter anything, and legitimate offers never need upfront fees. No thank you.",
  payment_request: "I won't pay by gift card, crypto or wire. Send an official invoice by mail.",
  personal_info_request: "I never share personal details or remote access on an inbound call. I'll contact you through official channels.",
};

const PATTERNS: Record<Tactic, RegExp> = {
  urgency:
    /\b(right now|immediately|urgent(?:ly)?|today|within (?:the )?(?:next )?(?:hour|\d+)|minutes?|last chance|expires?|deadline|before it'?s too late|act now|asap|hurry|quickly|no time|final notice|must be claimed|time is running out)\b/gi,
  authority_impersonation:
    /\b(irs|cra|revenue agency|social security|fbi|police|officer|investigator|badge|microsoft|apple support|amazon|fraud department|security team|government|federal|agent|attorney|lawyer|technician|windows support|department|commission|sheriff|court|case number|tech support|certified)\b/gi,
  isolation:
    /\b(don'?t tell|do not tell|keep (?:this|it) (?:a )?secret|between us|don'?t (?:hang up|call anyone|discuss|disconnect)|do not (?:hang up|speak to anyone|discuss|disconnect|touch)|stay on the line|remain on the line|gag order|confidential|don'?t talk to|do not let)\b/gi,
  threat:
    /\b(arrest(?:ed)?|warrant|lawsuit|sued|jail|prison|deport(?:ed|ation)?|frozen|suspended|seize[ds]?|legal action|criminal|penalt(?:y|ies)|fines?|hackers?|compromised|virus|infected|charges|prosecut\w*|police will|identity is being stolen)\b/gi,
  too_good_to_be_true:
    /\b(you(?:'ve| have)? won|winner|prize|lottery|jackpot|guaranteed|free|refund|rebate|risk[- ]free|double your|inheritance|selected|waive|lifetime|eligible to receive)\b/gi,
  payment_request:
    /\b(gift cards?|wire|bitcoin|crypto(?:currency)?|western union|money transfer|zelle|e-?transfer|pay(?:ment)?|send (?:me )?money|cash|bail|fee|deposit|down payment|google play|itunes|escrow|settle(?:ment)?|withdraw|scratch off|safety cards?)\b/gi,
  personal_info_request:
    /\b(social (?:security|insurance)|ssn|password|passcode|pin|one[- ]time (?:code|password)|verification code|card number|account number|meter number|date of birth|routing number|remote access|anydesk|teamviewer|ultraviewer|full name|last four|confirm your (?:address|identity)|username|read me the|who do you bank)\b/gi,
};

const PRIORITY: Tactic[] = [
  "payment_request",
  "personal_info_request",
  "threat",
  "isolation",
  "authority_impersonation",
  "urgency",
  "too_good_to_be_true",
];

const WEIGHT: Record<Tactic, number> = {
  payment_request: 20,
  personal_info_request: 16,
  threat: 14,
  isolation: 12,
  authority_impersonation: 10,
  urgency: 8,
  too_good_to_be_true: 8,
};

const NEGATED =
  /\b(?:we|i|they|(?:the )?\w+)\s+(?:will\s+)?(?:never|do not|don'?t|won'?t)\s+(?:ask|request|require|accept)[^.!?]*[.!?]?/gi;

export function detectTactic(text: string, speaker: Speaker): TacticValue {
  if (speaker === "victim") return "none";
  const clean = text.replace(NEGATED, " ");
  let best: Tactic | undefined;
  let bestScore = 0;
  for (const id of PRIORITY) {
    let score = (clean.match(PATTERNS[id]) ?? []).length;
    if (id === "payment_request" && /\$\s?\d/.test(clean) && /\b(pay|settle|balance|deposit|owe|owed|down payment)\b/i.test(clean)) score += 1;
    if (id === "urgency" && /\b(within|next|in)\s+(?:the\s+)?(?:next\s+)?\d+\s*(?:hours?|minutes?|days?)\b/i.test(clean)) score += 1;
    if (id === "personal_info_request" && /\bpress\s*\d\b/i.test(clean) && /\b(verify|claim|confirm|account|meter)\b/i.test(clean)) score += 1;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best ?? "none";
}

const VICTIM_CUE =
  /^(?:yes|yeah|yep|no|nope|okay|ok|um+|uh+|hello|hi|hey|what|who|why|how|when|where|wait|sorry|but|so|really|oh|huh|excuse me|i\s+(?:don'?t|do not|didn'?t|can'?t|cannot|am|was|have|haven'?t|will|just|think|thought|need|want|already)|my\s|am i|is (?:this|that|he|she|it)|are you|can you|could you|do i|does)\b/i;
const CALLER_CUE =
  /\b(?:this is|my name is|calling (?:from|about|regarding)|we (?:are|have|require|need|will|received|detected)|you (?:must|need to|have to|will|are (?:eligible|required|being)|owe|won|have been|were)|please (?:press|hold|listen|stay|remain|do not)|your (?:account|social|case|warrant|computer|file|card|meter|package)|press \d|do not (?:hang|disconnect|tell)|remain calm|for security purposes|be advised)\b/i;

/** Context-aware speaker inference for unlabeled transcripts. Explicit labels always win. */
export function inferSpeakers(turns: Turn[]): Speaker[] {
  const out: Speaker[] = [];
  turns.forEach((t, i) => {
    if (t.speaker && t.speaker !== "unknown") {
      out.push(t.speaker);
      return;
    }
    const words = t.text.split(/\s+/).length;
    let caller = 0;
    let victim = 0;
    if (VICTIM_CUE.test(t.text.trim())) victim += 2;
    if (/\?\s*$/.test(t.text) && words <= 14) victim += 1.5;
    if (words <= 6) victim += 1;
    if (CALLER_CUE.test(t.text)) caller += 2;
    if (words >= 25) caller += 1;
    if (/\$\s?\d|\d{3,}/.test(t.text)) caller += 1;
    const diff = caller - victim;
    const prev = out[i - 1];
    if (diff >= 1) out.push("caller");
    else if (diff <= -1) out.push("victim");
    else out.push(prev === "caller" ? "victim" : prev === "victim" ? "caller" : "caller");
  });
  return out;
}

const STRONG_TECH = /\b(ultraviewer|anydesk|teamviewer|remote access|pop-?up|cmd|command prompt|firewall|virus|malware|your computer|tech support|network is|secure your network)\b/gi;

const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
  ["Grandparent/Family Emergency Scam", /\b(grandma|grandpa|grandson|granddaughter|grandmother|grandfather|it'?s me|car accident|in jail|bail)\b/gi],
  ["Tech Support Scam", /\b(microsoft|windows|virus|malware|remote access|anydesk|teamviewer|ultraviewer|technician|your computer|ip address)\b/gi],
  ["Government Imposter Scam", /\b(irs|cra|revenue|social security|social insurance|warrant|taxes|government|federal|customs|immigration|investigator|fbi|court|arrest)\b/gi],
  ["Romance Scam", /\b(sweetheart|darling|my love|romance|lonely|soulmate|never met)\b/gi],
  ["Prize/Lottery Scam", /\b(prize|lottery|winner|jackpot|sweepstakes|you(?:'ve| have)? won|rebate|eligible to receive)\b/gi],
  ["Investment/Crypto Scam", /\b(invest(?:ment|ing)?|crypto|bitcoin|trading|returns|forex|portfolio)\b/gi],
  ["Bank/Financial Institution Imposter Scam", /\b(bank|fraud department|debit card|credit card|account (?:number|has been))\b/gi],
];

export function detectCategory(text: string): string {
  if ((text.match(STRONG_TECH) ?? []).length >= 2) return "Tech Support Scam";
  let best = "Other/Unclear";
  let top = 0;
  for (const [name, re] of CATEGORY_PATTERNS) {
    const hits = (text.match(re) ?? []).length;
    if (hits > top) {
      top = hits;
      best = name;
    }
  }
  return best === "Other/Unclear" ? "Suspicious Call" : best;
}

export function riskFromCounts(counts: Record<Tactic, number>, flagged: number, total: number): number {
  if (!flagged) return 6;
  const distinct = tactics.filter((t) => counts[t] > 0);
  let s = distinct.reduce((a, t) => a + WEIGHT[t], 0) + Math.round((flagged / Math.max(total, 1)) * 30);
  if (counts.payment_request && (counts.threat || counts.authority_impersonation || counts.isolation || counts.urgency)) s = Math.max(s, 80);
  return Math.max(15, Math.min(98, s));
}

/** Lower bound the LLM score may not fall below, given the tactics it found. */
export function riskFloor(counts: Record<Tactic, number>): number {
  const distinct = tactics.filter((t) => counts[t] > 0).length;
  const others = distinct - (counts.payment_request ? 1 : 0);
  if (counts.payment_request && others > 0) return 80;
  if (counts.payment_request) return 62;
  if (counts.threat && counts.authority_impersonation) return 72;
  if (distinct >= 3) return 58;
  if (distinct >= 2) return 40;
  return 0;
}

export function verdictOf(risk: number): Verdict {
  return risk >= 65 ? "likely_scam" : risk >= 30 ? "suspicious" : "likely_legitimate";
}

export function countTactics(segments: Array<{ tactic: TacticValue }>): Record<Tactic, number> {
  return Object.fromEntries(tactics.map((t) => [t, segments.filter((s) => s.tactic === t).length])) as Record<Tactic, number>;
}

export function neutralNote(speaker: Speaker): string {
  return speaker === "victim"
    ? "Recipient's reply. Recipients carry no coercive tactic."
    : "Context-setting line with no request, pressure or credential ask.";
}

export function buildSummary(category: string, counts: Record<Tactic, number>, flagged: number): string {
  if (!flagged) return "No clear manipulation tactics were found, but stay cautious with unexpected callers who ask for money or personal details.";
  const top = tactics
    .filter((t) => counts[t] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 3)
    .map((t) => t.replace(/_/g, " "));
  return `This call matches a ${category.toLowerCase()} and pressures the recipient with ${top.join(", ")}.`;
}

export function heuristicTurns(turns: Turn[]): Analysis {
  const speakers = inferSpeakers(turns);
  const segments: Segment[] = turns.map((t, i) => {
    const speaker = speakers[i] ?? "unknown";
    const tactic = detectTactic(t.text, speaker);
    return {
      text: t.text,
      timestamp: t.start,
      speaker,
      tactic,
      explanation: tactic === "none" ? neutralNote(speaker) : TACTIC_EXPLAIN[tactic],
      counterAdvice: tactic === "none" ? "" : TACTIC_COUNTER[tactic],
    };
  });
  const counts = countTactics(segments);
  const flagged = segments.filter((s) => s.tactic !== "none").length;
  const callerText = segments.filter((s) => s.speaker !== "victim").map((s) => s.text).join(" ");
  const category = detectCategory(callerText);
  const riskScore = riskFromCounts(counts, flagged, segments.length);
  return {
    riskScore,
    category,
    verdict: verdictOf(riskScore),
    summary: buildSummary(category, counts, flagged),
    tacticCounts: counts,
    segments,
    inputMode: "fallback",
  };
}

export function heuristicFallback(transcript: string): Analysis {
  const turns = parseTurns(transcript);
  return heuristicTurns(turns.length ? turns : [{ text: transcript.trim() || "(empty)" }]);
}

export { categories };