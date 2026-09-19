// app/page.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  Info,
  Loader2,
  Lock,
  Mic,
  Play,
  Printer,
  ShieldAlert,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";

import { examples } from "@/data/examples";
import type { Analysis, AudioSummary } from "@/lib/schema";
import { analyzeAudio, type CadencePoint } from "@/lib/audioAnalysis";
import { VexaLogo } from "@/components/VexaLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SegmentReveal } from "@/components/SegmentReveal";
import { InsightsPanel } from "@/components/InsightsPanel";
import { RiskGauge } from "@/components/RiskGauge";
import { TacticRadar } from "@/components/TacticRadar";
import { CadenceChart } from "@/components/CadenceChart";
import { ClassificationStamp } from "@/components/ClassificationStamp";
import { TerminalLog } from "@/components/TerminalLog";
import { TacticGlossary } from "@/components/TacticGlossary";
import { ScanMetadata } from "@/components/ScanMetadata";

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

const DEMOS: Demo[] = [
  { id: "grandparent", label: "Grandparent Scam", file: "grandparent.mp4" },
  { id: "tech", label: "Tech Support Scam", file: "tech-support.mp4" },
  { id: "irs", label: "IRS Imposter Scam", file: "government.mp4" },
];

const MAX_BYTES = 20 * 1024 * 1024;
const DIRECT_UPLOAD_LIMIT = 4 * 1024 * 1024;
const MAX_RECORD_SECONDS = 120;
const ALLOWED_EXT = ["mp4", "mp3", "wav", "m4a", "webm"];
const MIN_ANALYSIS_MS = 2200;

const REASON_LABEL: Record<string, string> = {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const kindOf = (f: File): Kind => {
  if (f.type.startsWith("audio/")) return "audio";
  if (f.type.startsWith("video/")) return "video";
  return ["mp3", "wav", "m4a"].includes(extOf(f.name)) ? "audio" : "video";
};
const modeOf = (d: Report): NonNullable<Report["mode"]> =>
  d.cached ? "cached" : d.inputMode === "fallback" ? "fallback" : "ai";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

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

function TopBar({ label }: { label: string }) {
  return (
    <header className="no-print fixed inset-x-0 top-0 z-50 h-16 border-b border-[var(--line)] bg-[var(--background)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <VexaLogo />
          <span className="border-l border-[var(--line)] pl-3 font-mono text-xs tracking-wider text-[var(--muted)]">
            {label}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden items-center gap-2 font-mono text-[10px] tracking-widest text-[var(--muted)] sm:flex">
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
  const chooseFileRef = useRef<(f: File) => Promise<void>>(async () => {});

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

  function showReport(next: Report, text: string) {
    setReport(next);
    setReportTranscript(text);
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
    const example = examples.find((item) => item.id === demo.id);
    if (example) setTranscript(example.transcript);

    void (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        if (blob.size < 50_000 || blob.type.includes("html") || token !== loadToken.current) return;
        await runCadence(new File([blob], demo.file, { type: "video/mp4" }), token);
      } catch {
        /* preview UI reports the missing file */
      }
    })();
  }

  /* ---------- Microphone recording ---------- */
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
        setRecording(false);
        const type = (rec.mimeType || mime || "audio/webm").split(";")[0]!;
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
      recTimerRef.current = setInterval(() => {
        setRecSeconds((s) => {
          if (s + 1 >= MAX_RECORD_SECONDS) recorderRef.current?.stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      setError("Microphone access was denied or is unavailable.");
    }
  }
  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
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
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, audioSummary }),
      });
      const data = (await response.json()) as Report & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Analysis request failed.");
      const elapsed = Date.now() - started;
      if (elapsed < MIN_ANALYSIS_MS) await sleep(MIN_ANALYSIS_MS - elapsed);
      showReport({ ...data, mode: modeOf(data), processingMs: Date.now() - started }, transcript);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Text analysis failed.");
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  function uploadWithProgress(media: File): Promise<Report> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      xhr.open("POST", "/api/analyze-media");
      xhr.timeout = 120_000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.upload.onload = () => {
        setProgress(100);
        setPhase("analyzing");
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText) as Report & { error?: { message?: string } };
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error?.message ?? `Media analysis failed (${xhr.status}).`));
        } catch {
          reject(
            new Error(
              xhr.status === 413
                ? "The file is too large for the server. Try a shorter clip."
                : "The forensic server returned an unreadable response."
            )
          );
        }
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
        const json = (await response.json()) as Report & { error?: { message?: string } };
        if (!response.ok) throw new Error(json.error?.message ?? "Demonstration analysis failed.");
        data = json;
      } else if (file) {
        const compact = compactRef.current;
        const useCompact = file.size > DIRECT_UPLOAD_LIMIT && compact && compact.size < file.size;
        if (file.size > DIRECT_UPLOAD_LIMIT && !useCompact) {
          throw new Error(
            "This file is too large to upload directly and its audio couldn't be compressed in your browser. Try a shorter clip or a .wav/.mp3 file."
          );
        }
        data = await uploadWithProgress(useCompact ? compact! : file);
        data.fileName = file.name;
      } else {
        throw new Error("Select or attach an evidentiary media file first.");
      }
      const elapsed = Date.now() - started;
      if (elapsed < MIN_ANALYSIS_MS) await sleep(MIN_ANALYSIS_MS - elapsed);
      const example = selectedDemo ? examples.find((e) => e.id === selectedDemo.id) : undefined;
      showReport({ ...data, mode: modeOf(data), processingMs: Date.now() - started }, example?.transcript ?? "");
    } catch (caught) {
      if (selectedDemo) {
        const matched = examples.find((e) => e.id === selectedDemo.id) ?? examples[0]!;
        await sleep(800);
        showReport(
          {
            ...matched.result,
            inputMode: "media",
            fileName: selectedDemo.file,
            mode: "cached",
            processingMs: Date.now() - started,
          },
          matched.transcript
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
    setTranscript("");
    setError("");
    clearMedia();
  }

  if (report) {
    return (
      <ReportView
        report={report}
        transcript={reportTranscript}
        cadence={cadence}
        audioNote={audioNote}
        previewUrl={report.inputMode === "media" ? preview : ""}
        previewKind={previewKind}
        onReset={reset}
      />
    );
  }

  const hasMedia = Boolean(file || selectedDemo);
  const statusLabel =
    phase === "uploading" ? `Uploading evidence… ${progress}%` : phase === "analyzing" ? "Analyzing call…" : "";

  return (
    <div className="min-h-screen pt-16 text-[var(--foreground)] selection:bg-blue-500/20">
      <TopBar label="THREAT ANALYSIS CONSOLE" />

      <main className="mx-auto max-w-3xl px-6 py-16">
        {/* Hero */}
        <div className="mb-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          <p className="font-mono text-xs uppercase tracking-widest text-blue-500">// THREAT ANALYSIS CONSOLE</p>
        </div>
        <h1 className="font-display text-7xl font-bold leading-[0.9] tracking-tight sm:text-8xl">Vexa</h1>
        <p className="mt-4 text-lg leading-relaxed text-[var(--muted)]">
          Upload a call recording or paste a transcript. See exactly which manipulation tactic is used, line by line.
        </p>

        {/* Input card */}
        <section className="console-card mt-10 p-6">
          <div
            role="tablist"
            aria-label="Input type"
            className="mb-6 grid grid-cols-2 gap-1 rounded-full border border-[var(--line)] p-1"
          >
            {(
              [
                ["recording", "Recording", FileAudio],
                ["transcript", "Transcript", FileText],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                disabled={busy || recording}
                onClick={() => {
                  setTab(id);
                  setError("");
                }}
                className={`flex items-center justify-center gap-2 rounded-full px-4 py-2.5 font-mono text-xs font-semibold tracking-wide transition ${
                  tab === id ? "bg-blue-600 text-white" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {tab === "recording" && (
            <div role="tabpanel">
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
                      : "border-[var(--line)] hover:border-blue-500/40 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <Upload size={22} className="shrink-0 text-blue-500" />
                  <div className="text-left font-mono text-xs">
                    <span className="font-semibold">
                      {file
                        ? `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
                        : "Drop a call recording, or click to upload"}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-[var(--muted)]">
                      .mp4 · .webm · .mp3 · .wav · .m4a — max 20 MB
                    </span>
                  </div>
                </button>

                {recording ? (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="flex items-center justify-center gap-2 rounded-2xl border border-orange-500/50 bg-orange-500/10 px-6 py-4 font-mono text-xs font-semibold text-orange-500"
                  >
                    <Square size={14} className="animate-pulse" /> Stop · {clock(recSeconds)}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void startRecording()}
                    className="flex items-center justify-center gap-2 rounded-2xl border border-[var(--line)] px-6 py-4 font-mono text-xs font-semibold transition hover:border-blue-500/40 hover:text-blue-500 disabled:opacity-50"
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
                onChange={(event) => {
                  const candidate = event.target.files?.[0];
                  if (candidate) void chooseFile(candidate);
                }}
              />

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <p className="font-mono text-xs text-[var(--muted)]">Try an example:</p>
                  <span className="font-mono text-[10px] text-[var(--muted)]">Staged — not real recordings</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {DEMOS.map((demo) => {
                    const active = selectedDemo?.id === demo.id;
                    return (
                      <button
                        key={demo.id}
                        disabled={busy || recording}
                        onClick={() => chooseDemo(demo)}
                        aria-pressed={active}
                        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs transition disabled:opacity-50 ${
                          active
                            ? "border-blue-500 bg-blue-500/10 text-blue-500"
                            : "border-[var(--line)] hover:border-blue-500/40 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
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
                <div className="mt-5 rounded-2xl border border-[var(--line)] p-4">
                  <div className="mb-2 flex items-center justify-between font-mono text-xs">
                    <span className="max-w-[80%] truncate font-semibold">{selectedDemo?.file ?? file?.name}</span>
                    <button
                      onClick={clearMedia}
                      disabled={busy}
                      aria-label="Remove media"
                      className="rounded p-1 text-[var(--muted)] transition hover:text-[var(--foreground)] disabled:opacity-40"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  {previewError ? (
                    <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--line)] px-4 py-8 text-center font-mono text-[11px] leading-relaxed text-[var(--muted)]">
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
                      className="mt-2 max-h-64 w-full rounded-xl border border-[var(--line)] bg-black"
                    />
                  )}

                  {decoding && (
                    <p className="mt-2 flex items-center gap-2 font-mono text-[11px] text-[var(--muted)]">
                      <Loader2 size={12} className="animate-spin" /> Extracting acoustic cadence…
                    </p>
                  )}
                  {!decoding && cadence.length > 0 && (
                    <p className="mt-2 font-mono text-[11px] text-blue-500">
                      ✓ Cadence telemetry ready{audioSummary ? ` · ${audioSummary.pauseCount} pauses detected` : ""}
                    </p>
                  )}
                  {audioNote && <p className="mt-2 font-mono text-[11px] text-[var(--muted)]">{audioNote}</p>}
                </div>
              )}

              {selectedDemo && (
                <>
                  <details className="mt-3 rounded-2xl border border-[var(--line)] p-4 font-mono text-[11px] text-[var(--muted)]">
                    <summary className="cursor-pointer font-semibold text-[var(--foreground)]">
                      Make your own test recording — read this script aloud
                    </summary>
                    <p className="mt-3 leading-relaxed">
                      Use <strong>Record</strong> above (or your phone), read both roles, aim for 30–60 s, then analyze
                      it to exercise the full real pipeline.
                    </p>
                    <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">{transcript}</pre>
                  </details>
                  <label className="mt-3 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-[var(--muted)]">
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
                  <div className="mb-1 flex justify-between font-mono text-[11px] text-[var(--muted)]">
                    <span>INGESTION PROGRESS</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--line)]">
                    <div className="h-full bg-blue-500 transition-all duration-150" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              {error && <InlineError message={error} />}

              <button
                disabled={busy || decoding || recording || !hasMedia}
                onClick={() => void analyzeMedia()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3.5 font-mono text-xs font-semibold text-white transition hover:bg-blue-500 disabled:bg-[var(--line)] disabled:text-[var(--muted)]"
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />}
                {busy ? statusLabel : "Analyze Call"}
              </button>
              {!hasMedia && !recording && !busy && (
                <InlineNote>Attach or record a call — or pick an example — to begin.</InlineNote>
              )}
            </div>
          )}

          {tab === "transcript" && (
            <div role="tabpanel">
              <div className="relative">
                <label htmlFor="transcript-input" className="sr-only">
                  Call transcript
                </label>
                <textarea
                  id="transcript-input"
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  maxLength={20000}
                  placeholder="Paste a call transcript here — speaker labels are optional, Vexa infers who is speaking."
                  className="min-h-[220px] w-full resize-y rounded-2xl border border-[var(--line)] bg-transparent p-4 pb-8 font-mono text-xs leading-relaxed outline-none transition placeholder:text-[var(--muted)]/60 focus:border-blue-500/50 sm:text-sm"
                />
                <span
                  className={`pointer-events-none absolute bottom-3 right-4 font-mono text-xs ${
                    transcript.length > 18000 ? "text-orange-500" : "text-[var(--muted)]"
                  }`}
                >
                  {transcript.length.toLocaleString()} / 20,000
                </span>
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <p className="mb-3 font-mono text-xs text-[var(--muted)]">Try an example:</p>
                <div className="flex flex-wrap gap-2">
                  {examples.map((example) => (
                    <button
                      key={example.id}
                      disabled={busy}
                      onClick={() => {
                        setTranscript(example.transcript);
                        clearMedia();
                        showReport({ ...example.result, inputMode: "transcript", mode: "cached" }, example.transcript);
                      }}
                      className="flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3.5 py-1.5 font-mono text-xs transition hover:border-blue-500/40 hover:bg-black/[0.03] disabled:opacity-40 dark:hover:bg-white/[0.04]"
                    >
                      <Sparkles size={13} className="text-blue-500" />
                      {example.label}
                    </button>
                  ))}
                </div>
              </div>

              {error && <InlineError message={error} />}

              <button
                disabled={busy || !transcript.trim()}
                onClick={() => void analyzeText()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-3.5 font-mono text-xs font-semibold text-white transition hover:bg-blue-500 disabled:bg-[var(--line)] disabled:text-[var(--muted)]"
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <ShieldAlert size={15} />}
                {busy ? statusLabel || "Analyzing…" : "Analyze Call"}
              </button>
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

        <footer className="mt-12 border-t border-[var(--line)] pt-6 font-mono text-[11px] leading-relaxed text-[var(--muted)]">
          AI disclosure — analysis is produced by Google Gemini with a rule-based offline fallback. Scores are decision
          support, not proof; recordings are not stored.{" "}
          <a href="#glossary" className="text-blue-500 underline underline-offset-2">
            Tactic glossary
          </a>
          . Built for the TLN Cybersecurity Challenge 2026.
        </footer>
      </main>
    </div>
  );
}

function ReportView({
  report,
  transcript,
  cadence,
  audioNote,
  previewUrl,
  previewKind,
  onReset,
}: {
  report: Report;
  transcript: string;
  cadence: CadencePoint[];
  audioNote: string;
  previewUrl: string;
  previewKind: Kind;
  onReset: () => void;
}) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playerError, setPlayerError] = useState(false);

  const mode = report.mode ?? "ai";
  const engineLabel =
    mode === "cached" ? "Pre-verified Telemetry" : mode === "fallback" ? "Offline Heuristic Engine" : "Gemini Multimodal";
  const transcriptText =
    transcript ||
    (report.segments ? report.segments.map((s) => s.text).join("\n") : "") ||
    "Extracted dialogue recorded.";

  function seek(t: number) {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = t;
    void el.play().catch(() => {});
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

  const showPlayer = Boolean(previewUrl) && !playerError;
  const pill =
    "flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1.5 text-[var(--muted)] transition hover:border-blue-500/40 hover:text-[var(--foreground)]";

  return (
    <div className="report-shell min-h-screen pt-16 text-[var(--foreground)]">
      <TopBar label="EVIDENTIARY DOSSIER" />

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="no-print mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4 font-mono text-xs">
          <button onClick={onReset} className={pill}>
            <ArrowLeft size={14} /> New Inspection
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={download} className={pill}>
              <Download size={13} /> JSON
            </button>
            <button onClick={() => window.print()} className={pill}>
              <Printer size={13} /> Print / PDF
            </button>
            <span>
              <span className="text-[var(--muted)]">ENGINE: </span>
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
              <span className="font-mono text-xs tracking-wider text-blue-500">// FORENSIC ASSESSMENT</span>
              <p className="mt-2 font-sans text-lg font-semibold leading-snug sm:text-xl">{report.summary}</p>
              {report.fileName && (
                <p className="mt-3 font-mono text-[11px] text-[var(--muted)]">EXHIBIT: {report.fileName}</p>
              )}
            </div>

            {report.fallbackReason && (
              <div className="order-4 lg:order-none">
                <InlineError
                  message={`Simplified analysis — ${REASON_LABEL[report.fallbackReason] ?? report.fallbackReason}. Results come from the local rule-based engine and may be less accurate than the AI analysis.`}
                />
              </div>
            )}

            {showPlayer && (
              <div className="console-card no-print order-4 p-6 lg:order-none">
                <div className="mb-3 font-mono text-xs tracking-wider text-[var(--muted)]">EVIDENCE PLAYBACK</div>
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
                    className="max-h-72 w-full rounded-xl border border-[var(--line)] bg-black"
                  />
                )}
                <p className="mt-2 font-mono text-[10px] text-[var(--muted)]">
                  Expand a flagged line and press &ldquo;Play from&rdquo; to jump to that moment.
                </p>
              </div>
            )}

            <div className="order-5 lg:order-none">
              <InsightsPanel report={report} />
            </div>

            <div className="order-6 lg:order-none">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs tracking-wider text-blue-500">// EVIDENCE TIMELINE</span>
                <span className="font-mono text-xs text-[var(--muted)]">
                  {report.segments?.length ?? 0} SEGMENTS
                </span>
              </div>
              {report.segments && <SegmentReveal segments={report.segments} onSeek={showPlayer ? seek : undefined} />}
            </div>

            <div className="console-card order-7 p-6 lg:order-none">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-mono text-xs tracking-wider text-[var(--muted)]">DECODED TRANSCRIPT LOG</span>
                <span className="font-mono text-[10px] text-[var(--muted)]">CHRONOLOGICAL</span>
              </div>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[var(--line)] pt-3 font-mono text-xs leading-relaxed text-[var(--foreground)]/80">
                {transcriptText}
              </pre>
            </div>

            {(cadence.length > 0 || audioNote) && (
              <div className="order-8 lg:order-none">
                {cadence.length > 0 && <CadenceChart telemetry={cadence} />}
                {audioNote && <p className="mt-3 font-mono text-xs text-[var(--muted)]">{audioNote}</p>}
              </div>
            )}
          </section>

          <aside className="contents lg:sticky lg:top-20 lg:block lg:space-y-6 lg:self-start">
            <div className="order-2 lg:order-none">
              <RiskGauge score={report.riskScore} />
            </div>
            <div className="order-9 lg:order-none">
              <TacticRadar counts={report.tacticCounts} />
            </div>
            <div className="order-10 lg:order-none">
              <ScanMetadata report={report} mode={mode} audio={Boolean(report.mediaType)} />
            </div>
            <div className="order-11 lg:order-none">
              <TerminalLog isLoading={false} complete mode={report.inputMode === "media" ? "media" : "text"} />
            </div>
            <div id="glossary" className="order-12 scroll-mt-24 lg:order-none">
              <TacticGlossary />
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}