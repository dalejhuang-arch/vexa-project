// components/TranscriptInput.tsx
"use client";

import { FileAudio, LoaderCircle, Upload, X, ShieldCheck } from "lucide-react";
import { useRef } from "react";
import type { ChangeEvent } from "react";
import { ExampleButtons } from "./ExampleButtons";

interface Props {
  transcript: string;
  setTranscript: (value: string) => void;
  onExample: (id: string) => void;
  onAnalyze: () => void;
  busy: boolean;
  audioName?: string;
  onAudio: (file: File) => void;
  onClearAudio?: () => void;
}

export function TranscriptInput({
  transcript,
  setTranscript,
  onExample,
  onAnalyze,
  busy,
  audioName,
  onAudio,
  onClearAudio,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const count = transcript.length;

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      onAudio(file);
    }
  }

  return (
    <section className="console-card p-6" aria-label="Forensic input interface">
      <div className="flex items-center justify-between pb-3">
        <span className="font-mono text-xs tracking-wider text-blue-500">
          // TRANSCRIPT_EVIDENTIARY_BUFFER
        </span>
        <span className="font-mono text-xs text-[var(--muted)]">
          ENCRYPTION: LOCAL_MEMORY_ONLY
        </span>
      </div>

      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        maxLength={20000}
        placeholder="Paste an intercepted or suspicious call transcript here (or select an operational scenario below)..."
        aria-label="Call transcript buffer"
        className="min-h-[200px] w-full resize-y rounded-lg border border-[var(--line)] bg-black/20 p-4 font-mono text-sm leading-relaxed text-[var(--foreground)] outline-none transition focus:border-blue-500 placeholder:text-[var(--muted)]"
      />

      <div className="mt-2 flex items-center justify-between font-mono text-xs">
        <span className="text-[11px] text-[var(--muted)]">
          {transcript.trim() ? `${transcript.trim().split("\n").length} conversational turns detected` : "Awaiting input"}
        </span>
        <span className={count > 18000 ? "text-orange-500 font-bold" : "text-[var(--muted)]"}>
          {count.toLocaleString()} / 20,000 CHARS
        </span>
      </div>

      <div className="my-5 h-px bg-[var(--line)]" />

      <div className="mb-3 flex items-center gap-3 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
        <span>Load Operational Target Scenario:</span>
        <span className="h-px flex-1 bg-[var(--line)]" />
      </div>

      <ExampleButtons onSelect={onExample} />

      <div className="mt-5">
        {audioName ? (
          <div className="flex items-center justify-between rounded-xl border border-blue-500/40 bg-blue-500/10 p-3.5">
            <div className="flex items-center gap-3">
              <ShieldCheck size={18} className="text-blue-500" />
              <div>
                <p className="font-mono text-xs font-semibold text-[var(--foreground)]">{audioName}</p>
                <p className="font-mono text-[10px] text-blue-400">Acoustic cadence analyzer ready</p>
              </div>
            </div>
            {onClearAudio && (
              <button
                type="button"
                onClick={onClearAudio}
                className="rounded p-1 text-[var(--muted)] transition hover:text-white"
                aria-label="Clear audio"
              >
                <X size={16} />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line)] p-4 font-mono text-xs text-[var(--muted)] transition hover:border-blue-500 hover:text-[var(--foreground)]"
            aria-label="Upload call audio"
          >
            <Upload size={16} className="text-blue-500" />
            <span>Attach call audio (.mp3, .wav) for temporal cadence analysis</span>
            <input
              ref={inputRef}
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav"
              className="hidden"
              onChange={pick}
            />
          </button>
        )}
      </div>

      <button
        disabled={!transcript.trim() || busy}
        onClick={onAnalyze}
        className="primary-button mt-5 w-full disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <>
            <LoaderCircle size={17} className="animate-spin" />
            Processing Coercion Vectors...
          </>
        ) : (
          <>
            <FileAudio size={17} />
            Execute Forensic Inspection
          </>
        )}
      </button>
    </section>
  );
}