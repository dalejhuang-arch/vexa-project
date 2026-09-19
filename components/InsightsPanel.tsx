"use client";

import { useMemo } from "react";
import { AlertTriangle, CircleCheck, Eye, Phone } from "lucide-react";
import type { Analysis, Verdict } from "@/lib/schema";
import { tactics } from "@/lib/schema";
import { TACTIC_META } from "@/lib/tacticMeta";

export function deriveVerdict(a: Pick<Analysis, "riskScore" | "verdict">): Verdict {
  if (a.verdict) return a.verdict;
  return a.riskScore >= 65 ? "likely_scam" : a.riskScore >= 30 ? "suspicious" : "likely_legitimate";
}

const VERDICT_UI: Record<Verdict, { label: string; tone: string; Icon: typeof Eye; blurb: string }> = {
  likely_scam: {
    label: "LIKELY SCAM",
    tone: "border-orange-500/40 bg-orange-500/[0.07] text-orange-500",
    Icon: AlertTriangle,
    blurb: "Multiple coercion vectors combine in a pattern typical of fraud. Disengage.",
  },
  suspicious: {
    label: "SUSPICIOUS",
    tone: "border-blue-500/40 bg-blue-500/[0.07] text-blue-500",
    Icon: Eye,
    blurb: "Some pressure or verification asks are present. Confirm independently before acting.",
  },
  likely_legitimate: {
    label: "LIKELY LEGITIMATE",
    tone: "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-500",
    Icon: CircleCheck,
    blurb: "No coercive pattern found. Still verify any unexpected request for money or codes.",
  },
};

const CATEGORY_TIP: Partial<Record<Analysis["category"], string>> = {
  "Grandparent/Family Emergency Scam":
    "Hang up and call your grandchild or their parents on a number you already have. Agree on a family code word.",
  "Government Imposter Scam":
    "Government agencies don't demand payment or threaten arrest by phone. Look up the agency's number yourself.",
  "Tech Support Scam": "Legitimate tech companies never cold-call about viruses. Never grant remote access.",
  "Bank/Financial Institution Imposter Scam":
    "Call the number on the back of your card. Banks never ask you to move money to a 'safe account'.",
  "Prize/Lottery Scam": "You can't win a contest you didn't enter, and real prizes never require a fee.",
  "Investment/Crypto Scam": "Guaranteed returns don't exist. Verify any platform with your securities regulator.",
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-black/[0.02] p-4 dark:bg-white/[0.02]">
      <p className="font-mono text-[10px] tracking-widest text-[var(--muted)]">{label}</p>
      <p className="mt-1.5 font-mono text-xl font-bold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--muted)]">{sub}</p>}
    </div>
  );
}

export function InsightsPanel({ report }: { report: Analysis }) {
  const verdict = deriveVerdict(report);
  const ui = VERDICT_UI[verdict];

  const insights = useMemo(() => {
    const segs = report.segments;
    const flagged = segs.filter((s) => s.tactic !== "none");
    const distinct = tactics.filter((t) => report.tacticCounts[t] > 0);
    const dominant = [...distinct].sort((a, b) => report.tacticCounts[b] - report.tacticCounts[a])[0];
    const firstIdx = segs.findIndex((s) => s.tactic !== "none");

    const words = (s: string) => s.trim().split(/\s+/).length;
    const callerWords = segs.filter((s) => s.speaker === "caller").reduce((n, s) => n + words(s.text), 0);
    const recipientWords = segs.filter((s) => s.speaker === "recipient").reduce((n, s) => n + words(s.text), 0);
    const talkShare =
      callerWords + recipientWords > 0 ? Math.round((callerWords / (callerWords + recipientWords)) * 100) : null;

    let running = 0;
    const cumulative = segs.map((s) => (running += TACTIC_META[s.tactic].weight));

    const weights = segs.map((s) => TACTIC_META[s.tactic].weight).filter((w) => w > 0);
    const half = Math.floor(weights.length / 2);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const early = avg(weights.slice(0, Math.max(half, 1)));
    const late = avg(weights.slice(half));
    const escalation = weights.length < 3 ? "—" : late > early + 0.4 ? "RISING" : late < early - 0.4 ? "FALLING" : "STEADY";

    return { flagged, distinct, dominant, firstIdx, talkShare, cumulative, escalation };
  }, [report]);

  const W = 320;
  const H = 84;
  const max = Math.max(1, ...insights.cumulative);
  const n = insights.cumulative.length;
  const pts = insights.cumulative.map((v, i) => [
    n <= 1 ? W / 2 : (i / (n - 1)) * (W - 8) + 4,
    H - 6 - (v / max) * (H - 14),
  ]);

  const actions =
    verdict === "likely_legitimate"
      ? [
          "No action needed based on this conversation.",
          "Stay alert: legitimate callers never demand gift cards, crypto, wire transfers, or secrecy.",
        ]
      : [
          "End the call. Don't call back on any number the caller supplied.",
          CATEGORY_TIP[report.category] ?? "Verify independently using a number you look up yourself.",
          "Never pay with gift cards, crypto, wires, or cash couriers — including “refundable” deposits.",
          "If you already paid or shared codes: contact your bank immediately and change affected passwords.",
        ];

  return (
    <div className="space-y-6">
      <div className={`rounded-2xl border p-5 ${ui.tone}`} role="status">
        <div className="flex items-center gap-3">
          <ui.Icon size={20} />
          <span className="font-display text-3xl font-bold leading-none tracking-wide">{ui.label}</span>
          <span className="ml-auto font-mono text-xs opacity-80">RISK {report.riskScore}/100</span>
        </div>
        <p className="mt-2 text-sm text-[var(--foreground)]/80">{ui.blurb}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="FLAGGED LINES" value={`${insights.flagged.length}/${report.segments.length}`} />
        <Tile label="DISTINCT VECTORS" value={`${insights.distinct.length}/7`} />
        <Tile
          label="DOMINANT VECTOR"
          value={insights.dominant ? TACTIC_META[insights.dominant].label : "None"}
          sub={insights.dominant ? `${report.tacticCounts[insights.dominant]} line(s)` : undefined}
        />
        <Tile
          label="FIRST FLAG"
          value={insights.firstIdx >= 0 ? `#${insights.firstIdx + 1}` : "—"}
          sub={insights.firstIdx >= 0 ? "first coercive line" : "none found"}
        />
        <Tile label="ESCALATION" value={insights.escalation} sub="pressure over time" />
        <Tile label="CALLER TALK SHARE" value={insights.talkShare === null ? "—" : `${insights.talkShare}%`} sub="by word count" />
      </div>

      <div className="console-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs tracking-wider text-blue-500">// PRESSURE CURVE</span>
          <span className="font-mono text-[10px] text-[var(--muted)]">cumulative coercion · by line</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label="Cumulative pressure curve across the call">
          <line x1="0" x2={W} y1={H - 6} y2={H - 6} stroke="currentColor" opacity="0.15" />
          {pts.length > 1 && (
            <polyline
              points={pts.map((p) => p.join(",")).join(" ")}
              fill="none"
              stroke="#3B82F6"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          )}
          {report.segments.map((s, i) =>
            s.tactic !== "none" && pts[i] ? <circle key={i} cx={pts[i]![0]} cy={pts[i]![1]} r="3.5" fill="#F97316" /> : null
          )}
        </svg>
      </div>

      <div className="console-card p-5">
        <span className="font-mono text-xs tracking-wider text-blue-500">// TACTIC BREAKDOWN</span>
        <ul className="mt-4 space-y-2.5">
          {tactics.map((t) => {
            const count = report.tacticCounts[t];
            const meta = TACTIC_META[t];
            const Icon = meta.icon;
            const total = Math.max(1, insights.flagged.length);
            return (
              <li key={t} className="flex items-center gap-3">
                <Icon size={14} className={count > 0 ? "text-orange-500" : "text-[var(--muted)]/50"} />
                <span className="w-36 shrink-0 font-mono text-[11px] text-[var(--muted)]">{meta.label}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--line)]">
                  <span
                    className="block h-full rounded-full bg-orange-500"
                    style={{ width: `${(count / total) * 100}%` }}
                  />
                </span>
                <span className="w-5 text-right font-mono text-[11px] tabular-nums">{count}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="console-card p-5">
        <span className="font-mono text-xs tracking-wider text-blue-500">// RECOMMENDED ACTIONS</span>
        <ol className="mt-4 space-y-2.5 text-sm">
          {actions.map((a, i) => (
            <li key={i} className="flex gap-3">
              <span className="font-mono text-xs text-[var(--muted)]">{String(i + 1).padStart(2, "0")}</span>
              <span>{a}</span>
            </li>
          ))}
        </ol>
        {verdict !== "likely_legitimate" && (
          <div className="mt-5 flex gap-3 rounded-xl border border-[var(--line)] p-4 text-xs text-[var(--muted)]">
            <Phone size={15} className="mt-0.5 shrink-0 text-blue-500" />
            <p>
              <strong className="text-[var(--foreground)]">Report it:</strong> US — reportfraud.ftc.gov · FBI IC3 (ic3.gov).
              Canada — Canadian Anti-Fraud Centre, 1-888-495-8501. Reports help stop the next victim.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default InsightsPanel;