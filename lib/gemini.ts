// lib/gemini.ts
import { GoogleGenAI, Type } from "@google/genai";
import { getGeminiApiKey } from "./env";
import { categories, normalizeSpeaker, tactics, type Analysis, type AudioSummary, type Speaker, type TacticValue } from "./schema";
import { parseTurns, type Turn } from "./transcript";
import {
  TACTIC_COUNTER,
  TACTIC_EXPLAIN,
  buildSummary,
  countTactics,
  detectCategory,
  detectTactic,
  inferSpeakers,
  neutralNote,
  riskFloor,
  riskFromCounts,
  verdictOf,
} from "./heuristicFallback";

type FallbackReason = NonNullable<Analysis["fallbackReason"]>;

const PER_MODEL_TIMEOUT_MS = 24_000;
class GeminiTimeout extends Error {}
class SchemaError extends Error {}

export const responseSchema = {
  type: Type.OBJECT,
  properties: {
    riskScore: { type: Type.INTEGER },
    category: { type: Type.STRING },
    summary: { type: Type.STRING },
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          turn: { type: Type.INTEGER },
          speaker: { type: Type.STRING, enum: ["caller", "victim"] },
          tactic: { type: Type.STRING, enum: [...tactics, "none"] },
          explanation: { type: Type.STRING },
          counterAdvice: { type: Type.STRING },
        },
        required: ["turn", "speaker", "tactic", "explanation", "counterAdvice"],
      },
    },
  },
  required: ["riskScore", "category", "summary", "segments"],
};

function analystRules(authoritative: boolean): string {
  const hintRule = authoritative
    ? `Hint is CALLER / VICTIM when known (ground truth, never contradict it) or "?" when unknown.`
    : `Hint is CALLER / VICTIM / "?" taken from pasted text. Pasted labels are OFTEN WRONG or swapped. Decide the true speaker of every turn from the whole conversation; override the hint whenever context contradicts it.`;

  return `
MISSION AND ERROR POLICY
You protect elderly and vulnerable people from telephone fraud. A missed scam costs someone their savings; a false alarm costs nothing. Therefore: when evidence is ambiguous you score UP, never down. Under-scoring a real scam is the single worst failure you can make.

CRITICAL BIAS WARNING - READ TWICE
Fraud scripts are written to sound calm, polite, professional and helpful. Politeness is NOT evidence of legitimacy, it is the attack surface. Never reduce risk because the caller was courteous, spoke in corporate language, cited "policy", offered "protection", mentioned a well-known brand, or never raised their voice. Those are scam features, not exonerating facts.

STEP 1 - FRAME THE WHOLE CALL BEFORE YOU LABEL ANY TURN
Read every turn first, then answer internally:
(a) Did the caller phone the recipient uninvited?
(b) Does the caller claim to represent a bank, card network, "fraud" or "security" department, government agency, law enforcement, utility, delivery company, retailer or tech support?
(c) Does the call at ANY point move toward card numbers, account numbers, security codes, PINs, passwords, payments, a mailed form, a callback number, or a "press 1" hook?
If (a) and (b) are both true, this is an imposter scam unless the transcript itself proves the recipient initiated the contact. If (a) and (c) are both true, this is credential or payment harvesting. Decide this BEFORE writing any segment, and make every segment and the riskScore consistent with that decision.

STEP 2 - THE SCRIPT ARC (THIS IS WHERE MOST MISTAKES HAPPEN)
Scam calls are a rehearsed script. Label each turn by its ROLE IN THE SCRIPT, not by whether that one sentence sounds scary on its own:
1. Hook / greeting -> 2. Authority claim ("Fraud Watch division", "your electric utility") -> 3. Fake justification ("due to increased computer-related fraud we changed our policies") -> 4. Fear ("cardholders are held responsible") -> 5. Fake benefit ("we underwrite it right away", "free protection", "rebate check", "30% discount") -> 6. Setup ("you'll receive a package", "I'll be giving you a new security code", "there's a registration form") -> 7. THE ASK ("write down all your account numbers", "confirm your card with me", "which card will you be using", "press 1").
Every turn that advances this script is part of the attack and MUST carry a tactic. Do NOT mark a turn "none" just because the harmful request lands two or three turns later. The setup turns are the scam.

STEP 3 - ASK-SPLITTING (MANDATORY)
Social engineers split one request across several short turns so no single line looks damning. When a request for credentials is built over consecutive turns, EVERY turn in that chain is "personal_info_request" - the justification turn, the pivot turn, and the question turn alike. Worked example, all three are personal_info_request:
  "Today I will be giving you a new security code, okay?"
  "In order to give you a security code I just need to ensure you're the authorized cardholder, so if you can just confirm your card with me, okay?"
  "Which card are you going to be using, your Visa or your MasterCard?"
Never label any of those "none". Never label them merely "urgency" or "authority_impersonation" - the credential ask outranks both.

CATEGORY: write a specific 2-4 word label for the scam type (e.g. "Bank/Financial Institution Imposter Scam", "Tech Support Scam", "Government Imposter Scam", "Utility Rebate Scam"). Prefer these canonical names when they fit: ${categories.filter((c) => c !== "Other/Unclear").map((c) => `"${c}"`).join(", ")}. Never answer "Other/Unclear"; for a benign call use "Legitimate Call". Pick the category from the caller's CLAIMED IDENTITY plus the ask: a fake utility offering a rebate is a "Utility Rebate Scam", not a prize scam; a fake bank or card-security division is a "Bank/Financial Institution Imposter Scam".

INPUT: numbered turns "id | speaker hint | text". ${hintRule}
Ignore stray annotation words that leaked into the text (e.g. a bare "Clear", "Threat", "Urgency").
OUTPUT: EXACTLY one segment per input turn, same order, "turn" = the input id. NEVER skip, merge or add turns.

SPEAKERS - reason over the WHOLE conversation:
- CALLER placed the call: introduces themselves or an entity, cites policies, gives instructions, asks to confirm or verify accounts, uses scripted or corporate language.
- VICTIM received the call: answers ("Hello"), listens, clarifies, confirms identity, hesitates.
- A fully automated recording with no second voice is ALL caller turns. Zero victim turns is normal for a robocall and never reduces risk.

TACTICS (one dominant per CALLER turn, else "none"). Victim turns are ALWAYS "none".
- authority_impersonation: Claims to represent a bank, credit card company, "Fraud Watch", Visa/Mastercard security, government, law enforcement, utility, delivery service or tech support. ANY fake corporate division or cold caller claiming to protect your card/account is authority_impersonation. This also covers the fake-justification turns that prop up the claimed authority ("due to increased computer-related frauds we've made important changes to our policies", "it's standard procedure, we're telling all our customers").
- personal_info_request: CRITICAL: Social engineers rarely shout "give me your card." They use EUPHEMISMS to harvest details:
  * "confirm your card with me" / "verify the card you're holding"
  * "which card will you be using (Visa or Mastercard)?"
  * "write down all your account numbers" / "list your telephone cards, department store cards, any other cards in the household"
  * "verify your number / expiration / security code"
  * "I will give you a security code, but first confirm..."
  * "I just need to make sure you're the authorized cardholder"
  * Asking for passwords, PINs, CVV, OTP codes, card numbers, date of birth, SIN/SSN, or registration forms that collect account numbers.
  ANY turn asking to confirm, verify, select, read out, list or write down card/banking credentials MUST be tagged "personal_info_request" - including when it is phrased as the caller GIVING something (a code, a package, a form, protection) in exchange.
- payment_request: Demands for wire, crypto, gift cards, cash withdrawal, fee payment, or overpayment returns.
- urgency: Deadlines, "right now", "today", "before charges post", "we underwrite it right away".
- threat: Warnings of liability, arrest, frozen accounts, "cardholders are held responsible", lost funds.
- isolation: "Do not hang up", "keep this confidential", coaching stories for family/bank tellers.
- too_good_to_be_true: Free protection, unearned refunds, guaranteed rebates, discounts you never applied for, prizes, "you'll be receiving a rebate check".

WHEN "none" IS ALLOWED (be strict)
"none" is ONLY for: every victim turn; a caller's bare greeting or name check with no claim attached ("Hello", "Good morning, Louis please"); and content-free filler ("All right.", "Uh-huh."). If a caller turn carries ANY claim, justification, promise, instruction, setup or question that advances the script, it gets a tactic. In a genuine scam call the large majority of caller turns are flagged, not one or two. If you have produced a long run of "none" on caller turns, re-read those turns - you have almost certainly missed the script.

PRIORITY RULE: When a turn combines tactics, harvesting credentials ("personal_info_request") or money ("payment_request") ALWAYS outranks authority or urgency.

CALL-LEVEL SCORING (riskScore is for the WHOLE CALL, not this turn)
Score the MOST dangerous element present anywhere in the call. Never average across turns. Never discount because:
  - the victim did not comply or the recording ends before they hand anything over (ATTEMPTED harvesting scores the same as successful harvesting);
  - the call is short or only a few turns long;
  - no money changed hands;
  - the caller was polite.
- 0-15: Verified legitimate call (recipient-initiated, known appointment reminder, normal service call with NO credential/payment asks).
- 16-39: Mildly unusual inquiry, no authority claim, no financial or personal credential requests.
- 40-69: Suspicious cold call using pressure or vague unverified claims, no credential or money ask.
- 70-84: HIGH THREAT: unsolicited caller impersonating a financial institution, card network, utility, government agency or tech company.
- 85-100: CRITICAL THREAT: any unsolicited call that attempts to harvest, confirm, verify or collect card numbers, account numbers, PINs or security codes, OR demands payment, OR uses a "press 1 / stay on the line / call this number" hook to collect an unearned rebate, refund or prize.
MANDATORY FLOORS - apply after you have labelled every turn:
  - any personal_info_request or payment_request anywhere -> riskScore at least 90
  - any authority_impersonation anywhere -> riskScore at least 75
  - threat or isolation present -> riskScore at least 80
  - unsolicited offer of money/rebate/prize/discount with a press-1 or callback hook -> riskScore at least 85
  - category naming a scam, imposter, phishing or fraud -> riskScore at least 80
A riskScore below 40 is a claim that this call is essentially safe to take at face value. Only ever say that when every single segment is "none".

counterAdvice: For flagged turns, provide one short, assertive sentence the victim could say (e.g., "I will hang up and call the fraud number on the back of my card."). Empty string for "none".
summary: ONE plain-language sentence naming the scam and how it attempted to manipulate the victim.

FINAL SELF-CHECK BEFORE YOU RETURN JSON - fix violations, do not explain them:
1. segments count equals the number of input turns, ids in order.
2. Every caller turn that makes a claim, promise, instruction or request has a tactic, not "none".
3. Every credential-adjacent turn (confirm/verify/write down/which card/security code/account numbers) is personal_info_request.
4. riskScore satisfies every mandatory floor above.
5. category is specific and matches the caller's claimed identity.
`;
}

export const ANALYST_RULES = analystRules(true);

const systemPrompt = (authoritative: boolean) => `You are a forensic phone-scam analyst for a cybersecurity threat-intelligence tool.
${analystRules(authoritative)}
Return ONLY JSON: {"riskScore":0,"category":"","summary":"","segments":[{"turn":1,"speaker":"caller","tactic":"none","explanation":"","counterAdvice":""}]}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new GeminiTimeout("Gemini request timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function classifyGeminiError(error: unknown): FallbackReason {
  if (error instanceof GeminiTimeout) return "timeout";
  if (error instanceof SchemaError) return "schema_invalid";
  const e = error as { status?: number; message?: string } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const msg = String(e?.message ?? error ?? "");
  if (msg.includes("GEMINI_API_KEY")) return "auth";
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) return "auth";
  if (status === 429 || /RESOURCE_EXHAUSTED|\b429\b|quota/i.test(msg)) return "http_429";
  if (status === 400) return "schema_invalid";
  if (status === 500) return "http_500";
  if (status === 502) return "http_502";
  if (status === 503 || /UNAVAILABLE|overloaded/i.test(msg)) return "http_503";
  return "network";
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const isTactic = (v: string): v is (typeof tactics)[number] => (tactics as readonly string[]).includes(v);

function toTactic(v: unknown): TacticValue {
  const k = str(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (isTactic(k)) return k;
  const alias: Record<string, TacticValue> = {
    authority: "authority_impersonation",
    impersonation: "authority_impersonation",
    payment: "payment_request",
    personal_info: "personal_info_request",
    info_request: "personal_info_request",
    card_request: "personal_info_request",
    credentials: "personal_info_request",
    too_good: "too_good_to_be_true",
    threats: "threat",
  };
  return alias[k] ?? "none";
}

function cleanCategory(v: string): string {
  const c = v.replace(/[\r\n]+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").slice(0, 48).trim();
  if (!c || /^other\/?unclear$/i.test(c) || /^unknown$/i.test(c)) return "";
  return c;
}

function finalize(raw: string | undefined, turns: Turn[], authoritative: boolean): Analysis {
  if (!raw) throw new SchemaError("Empty model response");
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
  } catch {
    throw new SchemaError("Model returned invalid JSON");
  }
  const obj: Rec = isRec(json) ? json : {};
  const rawSegs = Array.isArray(obj.segments) ? obj.segments : [];

  const byTurn = new Map<number, Rec>();
  rawSegs.forEach((s, i) => {
    if (!isRec(s)) return;
    const n = Number(s.turn);
    const id = Number.isInteger(n) && n >= 1 && n <= turns.length ? n : rawSegs.length === turns.length ? i + 1 : 0;
    if (id && !byTurn.has(id)) byTurn.set(id, s);
  });

  const guessed = inferSpeakers(turns);
  const segments = turns.map((t, i) => {
    const s = byTurn.get(i + 1);
    let speaker: Speaker = authoritative && t.speaker && t.speaker !== "unknown" ? t.speaker : normalizeSpeaker(s?.speaker);
    if (speaker === "unknown") speaker = t.speaker ?? guessed[i] ?? "unknown";

    let tactic: TacticValue = s ? toTactic(s.tactic) : detectTactic(t.text, speaker);

    // Contextual sanity check: if the caller asks to confirm/write card numbers, force personal_info_request
    if (speaker === "caller") {
      const lower = t.text.toLowerCase();
      if (
        /confirm your card|which card are you going to|write down all your account|security code|department store card/i.test(lower) &&
        tactic === "none"
      ) {
        tactic = "personal_info_request";
      }
    }

    if (speaker === "victim") tactic = "none";
    const explanation = tactic === "none" ? neutralNote(speaker) : str(s?.explanation).trim() || TACTIC_EXPLAIN[tactic];
    const counterAdvice = tactic === "none" ? "" : str(s?.counterAdvice).trim() || TACTIC_COUNTER[tactic];
    return { text: t.text, timestamp: t.start, speaker, tactic, explanation, counterAdvice };
  });

  const counts = countTactics(segments);
  const flagged = segments.filter((s) => s.tactic !== "none").length;

  let category = cleanCategory(str(obj.category));
  if (!category) {
    category = flagged > 0 ? detectCategory(segments.filter((s) => s.speaker !== "victim").map((s) => s.text).join(" ")) : "Legitimate Call";
  }

  const modelRisk = typeof obj.riskScore === "number" && Number.isFinite(obj.riskScore) ? obj.riskScore : riskFromCounts(counts, flagged, segments.length);
  let risk = Math.max(modelRisk, riskFloor(counts));

  // --- SAFETY GUARDRAILS ---
  // 1. If it's classified as an Imposter Scam or Phishing, it CANNOT be a low risk (floor at 75)
  if (/imposter|scam|phishing|extortion/i.test(category) && flagged > 0) {
    risk = Math.max(risk, 75);
  }

  // 2. If personal info or payment is requested, floor at 82
  if (counts.personal_info_request > 0 || counts.payment_request > 0) {
    risk = Math.max(risk, 82);
  }

  if (flagged === 0) risk = Math.min(risk, 20);
  risk = Math.max(0, Math.min(100, Math.round(risk)));

  return {
    riskScore: risk,
    category,
    verdict: verdictOf(risk),
    summary: str(obj.summary).trim() || buildSummary(category, counts, flagged),
    tacticCounts: counts,
    segments,
    inputMode: "transcript",
  };
}

type Step = { model: string; schema: boolean };
function ladder(): Step[] {
  const env = (process.env.GEMINI_MODELS ?? "").split(",").map((s) => s.trim().replace(/^models\//, "")).filter(Boolean);
  const uniq = Array.from(new Set([...env, "gemini-2.5-flash", "gemini-2.5-pro", "gemini-flash-latest"]));
  const steps: Step[] = uniq.map((model) => ({ model, schema: true }));
  steps.push({ model: uniq[0] ?? "gemini-2.5-flash", schema: false });
  return steps;
}

export type AnalyzeOpts = { authoritative?: boolean; audioSummary?: AudioSummary; budgetMs?: number };

export async function analyzeTurns(turns: Turn[], opts: AnalyzeOpts = {}): Promise<Analysis> {
  if (turns.length === 0) throw new SchemaError("No turns to analyze");
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  const authoritative = opts.authoritative ?? turns.every((t) => t.speaker && t.speaker !== "unknown");
  const lines = turns.map((t, i) => `${i + 1} | ${t.speaker && t.speaker !== "unknown" ? t.speaker.toUpperCase() : "?"} | ${t.text}`);
  const cadence = opts.audioSummary ? `\n\nVOCAL CADENCE SUMMARY: ${JSON.stringify(opts.audioSummary)}` : "";
  const contents = `TURNS (${turns.length}). Return exactly ${turns.length} segments.\n${lines.join("\n")}${cadence}`;
  const system = systemPrompt(authoritative);

  const started = Date.now();
  const budget = opts.budgetMs ?? 42_000;
  let lastError: unknown;

  for (const step of ladder()) {
    if (Date.now() - started > budget) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await withTimeout(
          ai.models.generateContent({
            model: step.model,
            contents,
            config: {
              systemInstruction: system,
              responseMimeType: "application/json",
              temperature: 0.1,
              maxOutputTokens: 16384,
              ...(step.schema ? { responseSchema } : {}),
            },
          }),
          PER_MODEL_TIMEOUT_MS
        );
        return finalize(result.text, turns, authoritative);
      } catch (err) {
        lastError = err;
        const reason = classifyGeminiError(err);
        if (reason === "auth") throw err;
        if ((reason === "http_500" || reason === "http_503" || reason === "schema_invalid") && attempt === 0) {
          await sleep(600);
          continue;
        }
        break;
      }
    }
  }
  throw lastError ?? new Error("All Gemini models failed.");
}

export async function analyzeWithGemini(transcript: string, audioSummary?: AudioSummary): Promise<Analysis> {
  const turns = parseTurns(transcript);
  return analyzeTurns(turns.length ? turns : [{ text: transcript.trim() }], { audioSummary, authoritative: false });
}