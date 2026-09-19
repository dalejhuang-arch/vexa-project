// lib/heuristicFallback.ts — offline engine. Gemini is the accurate path; this keeps the app useful without it.
import type { Analysis, Category, Segment, Speaker, Tactic, Verdict } from "./schema";
import { tactics } from "./schema";
import { splitTurns } from "./transcript";

type Signal = [RegExp, number];

const CALLER_LABEL = /^\s*(caller|scammer|agent|officer|rep(?:resentative)?|operator|them|suspect|fraudster)\s*:\s*/i;
const RECIPIENT_LABEL = /^\s*(you|victim|recipient|me|user|target|customer|grandma|grandpa|grandmother|grandfather)\s*:\s*/i;
const ANY_LABEL = /^\s*[A-Za-z][A-Za-z .'-]{0,24}:\s+/;

const SIGNALS: Record<Tactic, Signal[]> = {
  payment_request: [
    [/\bgift ?cards?\b/i, 5],
    [/\b(bitcoin|crypto(?:currency)?|western union|moneygram|zelle|cash ?app|venmo|paypal|wire (?:transfer|the|money)|money order|itunes|steam card)\b/i, 4],
    [/\$\s?\d[\d,]*/, 3],
    [/\b\d[\d,.]*\s?(?:dollars|usd|bucks)\b/i, 3],
    [/\b(?:verification|processing|release|administrative|reconciliation) (?:payment|fee|adjustment|deposit)\b/i, 4],
    [/\b(?:bail|bond|guarantor|retainer|deposit|settlement)\b/i, 2],
    [/\b(?:pay|payment|payments|fees?|send (?:the )?(?:money|funds)|transfer the funds)\b/i, 1],
    [/\b(?:returned|refunded|reimbursed) (?:upon|after|once)\b/i, 2],
    [/\b(?:receiving funds|making a payment|using your bank account)\b/i, 2],
  ],
  personal_info_request: [
    [/\b(?:verification|security|one-?time|confirmation|access) (?:code|pin)\b/i, 5],
    [/\b(?:ssn|social security number)\b/i, 5],
    [/\b(?:card|account|routing) number\b/i, 4],
    [/\b(?:cvv|password|passcode|pin number|date of birth|mother'?s maiden)\b/i, 4],
    [/\b(?:remote access|anydesk|teamviewer|ultraviewer|screen ?share)\b/i, 5],
    [/\b(?:install|download)\b/i, 2],
    [/\bverify (?:that )?(?:i'?m|i am|you are|your (?:identity|account|credentials|name|address))\b/i, 2],
    [/\b(?:confirm|verify)\b.{0,40}\b(?:account holder|identity|address)\b/i, 2],
  ],
  threat: [
    [/\b(?:arrest(?:ed|s)?|warrant|jail|prison|incarcerat\w*|criminal|prosecut\w*|indict\w*|felony|charges?)\b/i, 4],
    [/\b(?:lawsuit|legal action|penalt(?:y|ies)|fines?|seiz\w+|garnish\w*|deport\w*)\b/i, 3],
    [/\b(?:unless you|or else|you (?:do not|don'?t) have a choice|no choice|consequences?)\b/i, 4],
    [/\b(?:frozen|suspended|locked (?:out|permanently)|compromised|hacked|infected|malware|virus|trojan)\b/i, 3],
    [/\b(?:escalat\w+|pending release|under (?:administrative )?(?:review|investigation)|irregularit\w+|flagged|disputed)\b/i, 2],
    [/\b(?:legal (?:status|matter|liaison|action)|fraud[- ]monitoring)\b/i, 1],
  ],
  isolation: [
    [/\b(?:do not|don'?t|never) (?:disconnect|hang up|end the call|tell|share this|discuss|mention|contact|call)\b/i, 4],
    [/\b(?:remain|stay) on the (?:line|phone|call)\b/i, 4],
    [/\b(?:keep (?:this|it) (?:confidential|secret|private|quiet|between us)|between us|nobody (?:needs to|can) know)\b/i, 4],
    [/\b(?:place|put) you on (?:a )?(?:brief |short )?hold\b/i, 2],
    [/\b(?:unsecured line|not (?:talk|speak) to anyone|without telling|mom or dad)\b/i, 3],
    [/\bconfidential\b/i, 2],
  ],
  urgency: [
    [/\b(?:immediately|right now|right away|at once|urgent(?:ly)?|asap|as soon as possible|hurry|act now|time[- ]sensitive|no time|before it'?s too late)\b/i, 4],
    [/\b(?:within|in the next) (?:the )?(?:hour|\d+ (?:minutes?|hours?)|24 hours|two hours|few minutes)\b/i, 4],
    [/\b(?:today|tonight|by (?:end of day|close of business|midnight)|before \d)\b/i, 2],
    [/\b(?:remain calm|stay calm|don'?t panic)\b/i, 3],
    [/\bat your computer\b/i, 2],
  ],
  authority_impersonation: [
    [/\b(?:my name is|this is)\b.{0,60}\b(?:from|with|calling)\b/i, 2],
    [/\bcalling (?:you )?from\b/i, 3],
    [/\b(?:i'?m|i am) (?:the |a |an )?(?:assigned |senior |lead |special |federal |licensed |certified )?(?:agent|officer|investigator|attorney|lawyer|liaison|representative|technician|specialist|manager|detective|analyst|supervisor|director)\b/i, 3],
    [/\b(?:division|department|bureau|agency|compliance|liaison|representative|officer|agent|investigator|attorney|lawyer|judge|court|badge|case (?:number|id)|irs|internal revenue|social security|medicare|microsoft|apple support|amazon|fraud (?:team|department)|security team|marshals?|police|fbi|federal)\b/i, 2],
    [/\b(?:interinstitutional|reconciliation|disbursement|authorization|determination|protocol|administrative|jurisdiction|regulatory)\b/i, 1],
    [/\b(?:not (?:authorized|permitted|able) to|for security reasons|per (?:our )?(?:policy|protocol))\b/i, 2],
  ],
  too_good_to_be_true: [
    [/\b(?:you(?:'ve| have)? (?:won|been selected)|winner|lottery|sweepstakes|prize|jackpot)\b/i, 5],
    [/\b(?:refund|reimburse\w*|grant|windfall|inheritance|unclaimed)\b/i, 2],
    [/\b(?:guaranteed|risk[- ]free|double your|no risk|limited (?:time )?offer)\b/i, 4],
    [/\b(?:returns?|profit|roi)\b.{0,30}\b(?:daily|weekly|monthly|%)\b/i, 3],
  ],
};

const PRIORITY: Tactic[] = [
  "payment_request",
  "threat",
  "isolation",
  "personal_info_request",
  "urgency",
  "authority_impersonation",
  "too_good_to_be_true",
];

const WEIGHT: Record<Tactic, number> = {
  payment_request: 28,
  personal_info_request: 20,
  threat: 18,
  isolation: 16,
  authority_impersonation: 14,
  too_good_to_be_true: 12,
  urgency: 10,
};

const EXPLAIN: Record<Tactic, { why: string; advice: string }> = {
  payment_request: {
    why: "The caller pushes for money through an unusual, unverifiable, or hard-to-reverse channel.",
    advice: "I won't send any money based on a phone call. I'll verify with the institution or person directly.",
  },
  personal_info_request: {
    why: "The caller seeks credentials, identifiers, or control of your device.",
    advice: "I never share codes or personal details with inbound callers, or install anything they ask for.",
  },
  threat: {
    why: "The caller invokes arrest, legal trouble, or loss to frighten you into compliance.",
    advice: "Real agencies don't threaten arrest by phone. I'm hanging up and calling the agency on its official number.",
  },
  isolation: {
    why: "The caller tries to keep you on the line or away from people who could spot the scam.",
    advice: "I'm hanging up to talk to my family first. Anything legitimate can wait ten minutes.",
  },
  urgency: {
    why: "The caller manufactures time pressure to short-circuit careful thinking.",
    advice: "I don't make decisions under a deadline. I'll call back on a number I look up myself.",
  },
  authority_impersonation: {
    why: "The caller borrows the credibility of an institution or official role, often with dense jargon.",
    advice: "Give me your name and department — I'll call the organization's public number to confirm.",
  },
  too_good_to_be_true: {
    why: "The caller dangles an unearned reward or guaranteed return to lower your guard.",
    advice: "I didn't enter anything, and real prizes never cost money. Please remove this number.",
  },
};

const MIN_SCORE = 3;

function detectTactic(body: string): Tactic | null {
  let best: Tactic | null = null;
  let bestScore = 0;
  for (const tactic of PRIORITY) {
    const score = SIGNALS[tactic].reduce((sum, [re, w]) => sum + (re.test(body) ? w : 0), 0);
    if (score >= MIN_SCORE && score > bestScore) {
      best = tactic;
      bestScore = score;
    }
  }
  return best;
}

/** Positive = caller-like, negative = recipient-like. */
function scoreCaller(text: string): number {
  const t = text.trim();
  let s = 0;
  if (t.length > 140) s += 2;
  if (t.length > 260) s += 1;
  if (t.length < 50) s -= 1.5;
  if (t.endsWith("?") && t.length < 100) s -= 2;
  if (/^(?:what|how|why|who|where|is|are|can|could|do|does|will|would)\b.*\?$/i.test(t) && t.length < 110) s -= 1.5;
  if (/^(?:oh|okay|ok|yes|yeah|no|hello\??|hi|um|uh|but|wait|i don'?t|i can'?t|i'?m not|i have|i think|is he|is my|how much)\b/i.test(t)) s -= 2;
  if (/\bmy (?:grandson|granddaughter|son|daughter|husband|wife|account|bank)\b/i.test(t) && t.length < 90) s -= 1;
  if (/\b(?:ma'?am|sir|mrs\.?|mr\.?|i need you to|i'?m calling from|you need to|please (?:do not|don'?t|remain|stay)|our (?:records|system|office)|in order to|i'?m going to|this is (?:not|a)\b)/i.test(t)) s += 2;
  if (/^(?:understood|good (?:morning|afternoon|evening)|i understand|essentially|your role|the procedure|the preliminary|i cannot|i can request|i'?m not authorized|however)\b/i.test(t)) s += 2;
  return s;
}

/** Two-state Viterbi with an alternation prior: conversations mostly alternate. */
function inferSpeakers(turns: string[], forced: Array<Speaker | null>): Speaker[] {
  const n = turns.length;
  if (n === 0) return [];
  const emis = turns.map((t, i) => (forced[i] === "caller" ? 12 : forced[i] === "recipient" ? -12 : scoreCaller(t)));
  const STAY = -1.1;

  let p0 = 0; // recipient
  let p1 = 0; // caller
  const back: Array<[0 | 1, 0 | 1]> = [];
  for (let i = 0; i < n; i++) {
    const e = emis[i]!;
    const from0 = Math.max(p0 + STAY, p1);
    const from0Idx: 0 | 1 = p0 + STAY >= p1 ? 0 : 1;
    const from1 = Math.max(p1 + STAY, p0);
    const from1Idx: 0 | 1 = p1 + STAY >= p0 ? 1 : 0;
    back.push([from0Idx, from1Idx]);
    p0 = from0 - e;
    p1 = from1 + e;
  }
  const out: Speaker[] = new Array(n).fill("unknown");
  let state: 0 | 1 = p1 >= p0 ? 1 : 0;
  for (let i = n - 1; i >= 0; i--) {
    const weak = Math.abs(emis[i]!) < 1 && forced[i] === null;
    out[i] = weak && n < 3 ? "unknown" : state === 1 ? "caller" : "recipient";
    state = back[i]![state];
  }
  return out;
}

const CATEGORY_RULES: Array<{ category: Category; signals: Signal[] }> = [
  {
    category: "Grandparent/Family Emergency Scam",
    signals: [
      [/\b(?:grandma|grandpa|grandmother|grandfather|grandson|granddaughter|nana|papa)\b/i, 3],
      [/\b(?:bail|guarantor|pending release)\b/i, 2],
      [/\b(?:accident|hospital|jail|arrested|car crash|family contact)\b/i, 1],
      [/\bmom or dad\b|\bdisappointed\b|\bit'?s me\b/i, 1],
    ],
  },
  {
    category: "Government Imposter Scam",
    signals: [
      [/\b(?:irs|internal revenue|social security|ssa|treasury|medicare)\b/i, 3],
      [/\b(?:marshals?|federal|customs|immigration)\b/i, 2],
      [/\bwarrant\b|\bback taxes\b|\btax(?:es)? owed\b/i, 2],
    ],
  },
  {
    category: "Tech Support Scam",
    signals: [
      [/\b(?:microsoft|windows support|apple support)\b/i, 3],
      [/\b(?:malware|virus|trojan|infect(?:ed|ions?)|hacked)\b/i, 2],
      [/\b(?:anydesk|teamviewer|remote access|support tool|eventvwr)\b/i, 3],
    ],
  },
  {
    category: "Bank/Financial Institution Imposter Scam",
    signals: [
      [/\b(?:bank|credit union|fraud (?:team|department)|debit card|credit card|financial)\b/i, 2],
      [/\baccount\b|\bsuspicious (?:activity|transaction)\b|\bcredentials\b/i, 1],
      [/\boverseas\b|\bwire transfer\b|\btransfer\b/i, 1],
    ],
  },
  { category: "Prize/Lottery Scam", signals: [[/\b(?:you(?:'ve| have)? won|winner|lottery|prize|sweepstakes)\b/i, 3]] },
  {
    category: "Investment/Crypto Scam",
    signals: [
      [/\b(?:guaranteed returns?|trading platform|invest(?:ment|ing)?|portfolio)\b/i, 2],
      [/\b(?:bitcoin|crypto(?:currency)?)\b/i, 1],
    ],
  },
  { category: "Romance Scam", signals: [[/\b(?:soulmate|my darling|love you|deployed|stationed overseas)\b/i, 2]] },
];

function detectCategory(text: string): Category {
  let best: Category = "Other/Unclear";
  let bestScore = 0;
  for (const { category, signals } of CATEGORY_RULES) {
    const score = signals.reduce((sum, [re, w]) => sum + (re.test(text) ? w : 0), 0);
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : "Other/Unclear";
}

export function heuristicFallback(transcript: string): Analysis {
  const trimmed = transcript.trim();
  const turns = splitTurns(trimmed);
  const lines = turns.length > 0 ? turns : [trimmed || "(empty transcript)"];

  const forced: Array<Speaker | null> = lines.map((l) =>
    CALLER_LABEL.test(l) ? "caller" : RECIPIENT_LABEL.test(l) ? "recipient" : null
  );
  const speakers = inferSpeakers(lines, forced);

  const flaggedTactics: Array<Tactic | null> = lines.map((line, i) => {
    if (speakers[i] === "recipient") return null;
    return detectTactic(line.replace(ANY_LABEL, ""));
  });

  const tacticCounts = Object.fromEntries(
    tactics.map((t) => [t, flaggedTactics.filter((f) => f === t).length])
  ) as Analysis["tacticCounts"];

  const flagged = flaggedTactics.filter(Boolean).length;
  const present = tactics.filter((t) => tacticCounts[t] > 0);

  let score = present.reduce((sum, t) => sum + WEIGHT[t], 0);
  score += Math.min(14, Math.max(0, flagged - present.length) * 3);
  const pressure = tacticCounts.threat + tacticCounts.isolation + tacticCounts.urgency > 0;
  if (tacticCounts.payment_request > 0 && (pressure || tacticCounts.authority_impersonation > 0)) score += 12;
  if (tacticCounts.personal_info_request > 0 && tacticCounts.authority_impersonation > 0) score += 8;
  if (present.length === 1 && (present[0] === "authority_impersonation" || present[0] === "urgency")) {
    score = Math.min(score, 24); // one weak signal alone is not a scam
  }
  if (present.length === 0) score = 4;
  const riskScore = Math.max(3, Math.min(98, Math.round(score)));

  const verdict: Verdict = riskScore >= 65 ? "likely_scam" : riskScore >= 30 ? "suspicious" : "likely_legitimate";
  const scamContext = verdict !== "likely_legitimate";
  const category = scamContext ? detectCategory(trimmed) : "Other/Unclear";

  const segments: Segment[] = lines.map((raw, i) => {
    const text = raw.replace(CALLER_LABEL, "").replace(RECIPIENT_LABEL, "").trim() || raw;
    const speaker = speakers[i] ?? "unknown";
    const tactic = flaggedTactics[i];
    if (tactic) {
      return { text, speaker, tactic, explanation: EXPLAIN[tactic].why, counterAdvice: EXPLAIN[tactic].advice };
    }
    if (speaker === "recipient") {
      return {
        text,
        speaker,
        tactic: "none",
        explanation: "Recipient turn — asking questions or responding is exactly the right instinct.",
        counterAdvice: "Keep asking questions, and verify through a number you look up yourself.",
      };
    }
    return {
      text,
      speaker,
      tactic: "none",
      explanation: scamContext
        ? "Context-building line: no primary tactic on its own, but it advances the pretext."
        : "Dialogue turn without coercion signatures.",
      counterAdvice: "Verify unexpected requests independently.",
    };
  });

  const names = present.map((t) => t.replace(/_/g, " ")).join(", ");
  const summary =
    verdict === "likely_scam"
      ? `Offline scan found ${present.length} coercion vectors (${names}) in a pattern typical of ${category === "Other/Unclear" ? "a phone scam" : `a ${category.toLowerCase()}`} — treat it as fraud and disengage.`
      : verdict === "suspicious"
      ? `Offline scan flagged ${flagged} line${flagged === 1 ? "" : "s"} (${names}) — not conclusive, but verify independently before acting.`
      : "No coercive pattern detected — this reads like an ordinary conversation.";

  return { riskScore, category, verdict, summary, tacticCounts, inputMode: "fallback", segments };
}