// lib/schema.ts
import { z } from "zod";

export const tactics = [
  "urgency",
  "authority_impersonation",
  "isolation",
  "threat",
  "too_good_to_be_true",
  "payment_request",
  "personal_info_request",
] as const;

export const categories = [
  "Government Imposter Scam",
  "Grandparent/Family Emergency Scam",
  "Tech Support Scam",
  "Romance Scam",
  "Prize/Lottery Scam",
  "Investment/Crypto Scam",
  "Bank/Financial Institution Imposter Scam",
  "Other/Unclear",
] as const;

export function normalizeSpeaker(v: unknown): "caller" | "victim" | "unknown" {
  const s = String(v ?? "").toLowerCase().trim();
  if (/^(caller|scammer|agent|operator|attacker|robocall|speaker ?a|a)$/.test(s)) return "caller";
  if (/^(victim|recipient|you|user|target|customer|receiver|speaker ?b|b)$/.test(s)) return "victim";
  return "unknown";
}

export const tacticSchema = z.enum([...tactics, "none"] as const);
export const speakerSchema = z.preprocess(normalizeSpeaker, z.enum(["caller", "victim", "unknown"]));
export const verdictSchema = z.enum(["likely_scam", "suspicious", "likely_legitimate"]);

export const audioSummarySchema = z.object({
  pauseCount: z.number().nonnegative(),
  longestPauseSec: z.number().nonnegative(),
  paceSpikeTimestamps: z.array(z.number().nonnegative()),
});

export const analyzeRequestSchema = z.object({
  transcript: z.string().trim().min(1, "Transcript cannot be empty").max(25_000),
  audioSummary: audioSummarySchema.optional(),
});

export const tacticCountsSchema = z.object({
  urgency: z.number().int().nonnegative().default(0),
  authority_impersonation: z.number().int().nonnegative().default(0),
  isolation: z.number().int().nonnegative().default(0),
  threat: z.number().int().nonnegative().default(0),
  too_good_to_be_true: z.number().int().nonnegative().default(0),
  payment_request: z.number().int().nonnegative().default(0),
  personal_info_request: z.number().int().nonnegative().default(0),
});

export const segmentSchema = z.object({
  text: z.string().min(1),
  timestamp: z.number().nonnegative().optional(),
  speaker: speakerSchema,
  tactic: tacticSchema,
  explanation: z.string().default("Neutral conversational turn."),
  counterAdvice: z.string().default(""),
});

export const analysisSchema = z.object({
  riskScore: z.number().int().min(0).max(100),
  category: z.enum(categories).catch("Other/Unclear"),
  verdict: verdictSchema.optional(),
  summary: z.string().min(1),
  tacticCounts: tacticCountsSchema.default({
    urgency: 0,
    authority_impersonation: 0,
    isolation: 0,
    threat: 0,
    too_good_to_be_true: 0,
    payment_request: 0,
    personal_info_request: 0,
  }),
  segments: z.array(segmentSchema).min(1),
  inputMode: z.enum(["transcript", "media", "fallback"]).default("transcript"),
  fallbackReason: z
    .enum(["timeout", "auth", "http_429", "http_500", "http_502", "http_503", "schema_invalid", "network", "forced"])
    .optional(),
});

export type Tactic = (typeof tactics)[number];
export type TacticValue = Tactic | "none";
export type Category = (typeof categories)[number];
export type Speaker = "caller" | "victim" | "unknown";
export type Verdict = z.infer<typeof verdictSchema>;
export type AudioSummary = z.infer<typeof audioSummarySchema>;
export type Segment = z.infer<typeof segmentSchema> & { tactic: TacticValue };
export type Analysis = Omit<z.infer<typeof analysisSchema>, "segments"> & { segments: Segment[] };