"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Play } from "lucide-react";
import type { Segment } from "@/lib/schema";
import { TACTIC_META } from "@/lib/tacticMeta";

type Filter = "all" | "flagged" | "caller" | "recipient";
const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["flagged", "Flagged"],
  ["caller", "Caller"],
  ["recipient", "Recipient"],
];

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SegmentReveal({
  segments,
  onSeek,
}: {
  segments: Segment[];
  onSeek?: (seconds: number) => void;
}) {
  const reduce = useReducedMotion();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<number>>(new Set());

  const rows = useMemo(
    () =>
      segments
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment }) =>
          filter === "all"
            ? true
            : filter === "flagged"
            ? segment.tactic !== "none"
            : segment.speaker === filter
        ),
    [segments, filter]
  );

  const stagger = Math.min(0.15, 1.8 / Math.max(rows.length, 1));

  function toggle(i: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter segments">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
            className={`rounded-full border px-3 py-1 font-mono text-[11px] transition ${
              filter === id
                ? "border-blue-500 bg-blue-500/10 text-blue-500"
                : "border-[var(--line)] text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <motion.ol
        key={filter}
        initial={reduce ? false : "hidden"}
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: reduce ? 0 : stagger } } }}
        className="space-y-2"
      >
        {rows.length === 0 && (
          <li className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center font-mono text-xs text-[var(--muted)]">
            No segments match this filter.
          </li>
        )}
        {rows.map(({ segment, index }) => {
          const meta = TACTIC_META[segment.tactic];
          const Icon = meta.icon;
          const flagged = segment.tactic !== "none";
          const expanded = open.has(index);
          const isRecipient = segment.speaker === "recipient";

          const content = (
            <>
              <span className="w-12 shrink-0 pt-0.5 font-mono text-[11px] text-[var(--muted)]">
                {String(index + 1).padStart(2, "0")}
                {segment.timestamp !== undefined && (
                  <span className="block text-[10px] opacity-70">{fmt(segment.timestamp)}</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                {segment.speaker && segment.speaker !== "unknown" && (
                  <span
                    className={`mb-1 inline-block rounded px-1.5 py-0.5 font-mono text-[9px] tracking-widest ${
                      isRecipient ? "bg-blue-500/10 text-blue-500" : "bg-[var(--line)] text-[var(--muted)]"
                    }`}
                  >
                    {segment.speaker.toUpperCase()}
                  </span>
                )}
                <span className={`block text-sm leading-relaxed ${isRecipient ? "text-[var(--muted)]" : ""}`}>
                  {segment.text}
                </span>
              </span>
              <span
                className={`ml-2 flex shrink-0 items-center gap-1.5 self-start rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-wide ${
                  flagged
                    ? "border-orange-500/40 bg-orange-500/10 text-orange-500"
                    : isRecipient
                    ? "border-transparent text-transparent"
                    : "border-emerald-500/30 text-emerald-500"
                }`}
              >
                {(flagged || !isRecipient) && <Icon size={12} />}
                {flagged ? meta.label.toUpperCase() : isRecipient ? "" : "CLEAR"}
                {flagged && (
                  <ChevronDown size={12} className={`transition ${expanded ? "rotate-180" : ""}`} />
                )}
              </span>
            </>
          );

          return (
            <motion.li
              key={index}
              variants={{
                hidden: { opacity: 0, y: 8 },
                show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
              }}
              className={`rounded-xl border ${
                flagged
                  ? "border-orange-500/30 bg-orange-500/[0.04]"
                  : "border-[var(--line)] bg-black/[0.02] dark:bg-white/[0.02]"
              }`}
            >
              {flagged ? (
                <button
                  type="button"
                  onClick={() => toggle(index)}
                  aria-expanded={expanded}
                  className="flex w-full items-start gap-3 p-3.5 text-left"
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-start gap-3 p-3.5">{content}</div>
              )}

              <AnimatePresence initial={false}>
                {flagged && expanded && (
                  <motion.div
                    initial={reduce ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <div className="mx-3.5 mb-3.5 space-y-3 border-l-2 border-orange-500 pl-4">
                      <div>
                        <p className="font-mono text-[10px] tracking-widest text-orange-500">
                          // PSYCHOLOGICAL VECTOR
                        </p>
                        <p className="mt-1 text-sm text-[var(--muted)]">{segment.explanation}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[10px] tracking-widest text-blue-500">
                          // WHAT YOU COULD HAVE SAID
                        </p>
                        <p className="mt-1 text-sm">&ldquo;{segment.counterAdvice}&rdquo;</p>
                      </div>
                      {onSeek && segment.timestamp !== undefined && (
                        <button
                          type="button"
                          onClick={() => onSeek(segment.timestamp!)}
                          className="no-print flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1 font-mono text-[11px] text-[var(--muted)] transition hover:border-blue-500/40 hover:text-blue-500"
                        >
                          <Play size={11} /> Play from {fmt(segment.timestamp)}
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.li>
          );
        })}
      </motion.ol>
    </div>
  );
}

export default SegmentReveal;