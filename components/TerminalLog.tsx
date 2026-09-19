"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, CircleCheck, Loader2 } from "lucide-react";

const MEDIA_STEPS = [
  "Ingesting media container…",
  "Demuxing audio stream…",
  "Transcribing speech to text…",
  "Inferring speakers (caller vs recipient)…",
  "Segmenting dialogue by turn…",
  "Cross-referencing tactic database (7 vectors)…",
  "Matching FTC / FBI / CAFC scam typologies…",
  "Scoring coercion escalation…",
  "Compiling evidentiary dossier…",
];
const TEXT_STEPS = [
  "Parsing transcript…",
  "Inferring speakers from conversation flow…",
  "Cross-referencing tactic database (7 vectors)…",
  "Matching FTC / FBI / CAFC scam typologies…",
  "Scoring coercion escalation…",
  "Compiling evidentiary dossier…",
];

type Props = { isLoading: boolean; mode: "media" | "text"; complete?: boolean };

const BARS = 36;

export function TerminalLog({ isLoading, mode, complete = false }: Props) {
  const reduce = useReducedMotion();
  const steps = mode === "media" ? MEDIA_STEPS : TEXT_STEPS;
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!isLoading) return;
    setStep(0);
    setElapsed(0);
    const started = Date.now();
    const stepTimer = setInterval(
      () => setStep((s) => Math.min(s + 1, steps.length - 1)),
      mode === "media" ? 1500 : 800
    );
    const clock = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => {
      clearInterval(stepTimer);
      clearInterval(clock);
    };
  }, [isLoading, mode, steps.length]);

  const pct = Math.round(((step + 1) / steps.length) * 92);
  const state = isLoading ? "scanning" : complete ? "complete" : "standby";

  if (state === "complete") {
    return (
      <div className="console-card overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left"
        >
          <span className="flex items-center gap-2 font-mono text-xs tracking-wider text-emerald-500">
            <CircleCheck size={14} /> SCAN COMPLETE — {open ? "HIDE" : "VIEW"} LOG
          </span>
          <ChevronDown size={15} className={`text-[var(--muted)] transition ${open ? "rotate-180" : ""}`} />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.ul
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="space-y-1.5 overflow-hidden border-t border-[var(--line)] px-5 py-4 font-mono text-[11px] text-[var(--muted)]"
            >
              {steps.map((s) => (
                <li key={s} className="flex gap-2">
                  <span className="text-emerald-500">✓</span> {s}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="console-card relative overflow-hidden" aria-live="polite">
      {state === "scanning" && !reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 z-10 w-1/3 bg-gradient-to-r from-transparent via-blue-500/10 to-transparent"
          initial={{ x: "-100%" }}
          animate={{ x: "400%" }}
          transition={{ duration: 2.2, ease: "linear", repeat: Infinity }}
        />
      )}

      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
        <span className="flex items-center gap-2 font-mono text-xs tracking-wider">
          <span
            className={`h-2 w-2 rounded-full ${
              state === "scanning" ? "animate-pulse bg-blue-500" : "bg-[var(--muted)]/60"
            }`}
          />
          <span className={state === "scanning" ? "text-blue-500" : "text-[var(--muted)]"}>
            {state === "scanning" ? "SCAN IN PROGRESS" : "STANDBY — AWAITING EVIDENCE"}
          </span>
        </span>
        <span className="font-mono text-xs tabular-nums text-[var(--muted)]">
          {state === "scanning" ? `${(elapsed / 1000).toFixed(1)}s` : "00.0s"}
        </span>
      </div>

      {/* Waveform */}
      <div className="flex h-14 items-center gap-[3px] px-5 pt-3" aria-hidden>
        {Array.from({ length: BARS }).map((_, i) => {
          const base = (Math.sin(i * 1.7) + 1) / 2;
          return state === "scanning" && !reduce ? (
            <motion.span
              key={i}
              className="w-full origin-center rounded-full bg-blue-500/70"
              style={{ height: "100%" }}
              animate={{ scaleY: [0.15, 0.4 + base * 0.6, 0.2, 0.9 - base * 0.3, 0.15] }}
              transition={{ duration: 1.1 + (i % 5) * 0.14, repeat: Infinity, ease: "easeInOut", delay: i * 0.035 }}
            />
          ) : (
            <span
              key={i}
              className="w-full rounded-full bg-[var(--muted)]/30"
              style={{ height: `${12 + base * 32}%` }}
            />
          );
        })}
      </div>

      {/* Progress */}
      <div className="px-5 pt-3">
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
          <motion.div
            className="h-full bg-blue-500"
            animate={{ width: state === "scanning" ? `${pct}%` : "0%" }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
      </div>

      {/* Log lines */}
      <ul className="space-y-1.5 px-5 pb-5 pt-4 font-mono text-[11px]">
        {state === "scanning" ? (
          steps.slice(0, step + 1).map((line, i) => {
            const active = i === step;
            return (
              <motion.li
                key={line}
                initial={reduce ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className={`flex items-center gap-2 ${active ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}
              >
                {active ? (
                  <Loader2 size={11} className="animate-spin text-blue-500" />
                ) : (
                  <span className="text-emerald-500">✓</span>
                )}
                {line}
                {active && !reduce && (
                  <motion.span
                    aria-hidden
                    className="inline-block h-3 w-1.5 bg-blue-500"
                    animate={{ opacity: [1, 0, 1] }}
                    transition={{ duration: 0.9, repeat: Infinity }}
                  />
                )}
              </motion.li>
            );
          })
        ) : (
          <>
            <li className="text-[var(--muted)]">&gt; engine ready · 7 coercion vectors loaded</li>
            <li className="text-[var(--muted)]">&gt; drop a recording or paste a transcript to begin</li>
          </>
        )}
      </ul>
    </div>
  );
}

export default TerminalLog;