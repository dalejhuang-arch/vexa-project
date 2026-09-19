"use client";

import React from "react";
import type { Analysis } from "@/lib/schema";

interface ScanMetadataProps {
  report: Analysis & { 
    fileName?: string; 
    processingMs?: number; 
    fallbackReason?: string;
  };
  mode: "ai" | "fallback" | "cached";
  audio: boolean;
}

export function ScanMetadata({ report, mode, audio }: ScanMetadataProps) {
  // Honest Mode Labels required by the specification
  const modeLabel =
    mode === "cached"
      ? "Cached Example"
      : report.inputMode === "media"
      ? "Audio/Video Analysis"
      : report.inputMode === "fallback"
      ? "Fallback Analysis"
      : "Transcript Input";

  const flaggedCount = report.segments.filter((s) => s.tactic !== "none").length;

  return (
    <div className="console-card p-5 font-mono text-xs">
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-2 mb-3">
        <span className="text-blue-500 font-semibold tracking-wider">
          // SCAN METADATA
        </span>
        <span className="text-[10px] text-[var(--muted)] uppercase">
          TELEMETRY LOG
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
          <span className="text-[var(--muted)]">INPUT MODE</span>
          <span className="text-blue-500 font-semibold">{modeLabel}</span>
        </div>

        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
          <span className="text-[var(--muted)]">CATEGORY</span>
          <span className="text-[var(--foreground)] font-medium truncate max-w-[180px]">
            {report.category}
          </span>
        </div>

        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
          <span className="text-[var(--muted)]">INTERCEPT TURNS</span>
          <span className="text-[var(--foreground)]">{report.segments.length} segments</span>
        </div>

        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
          <span className="text-[var(--muted)]">FLAGGED TACTICS</span>
          <span className={flaggedCount > 0 ? "text-orange-500 font-bold" : "text-emerald-500"}>
            {flaggedCount} detected
          </span>
        </div>

        <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
          <span className="text-[var(--muted)]">INSPECTION TIME</span>
          <span className="text-[var(--foreground)]">
            {report.processingMs ? `${(report.processingMs / 1000).toFixed(2)}s` : "< 0.10s (Cached)"}
          </span>
        </div>

        {report.fileName && (
          <div className="flex items-center justify-between pb-1.5 border-b border-[var(--line)]/50">
            <span className="text-[var(--muted)]">SOURCE MEDIA</span>
            <span className="text-[var(--foreground)] truncate max-w-[150px]">
              {report.fileName}
            </span>
          </div>
        )}

        {report.fallbackReason && (
          <div className="flex items-center justify-between pt-1 text-orange-500">
            <span>FALLBACK REASON</span>
            <span className="font-bold uppercase tracking-wider">{report.fallbackReason}</span>
          </div>
        )}
      </div>
    </div>
  );
}