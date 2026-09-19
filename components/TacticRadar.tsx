"use client";

import React from "react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
import type { Tactic } from "@/lib/schema";

interface TacticRadarProps {
  counts: Record<Tactic, number>;
}

// Short, clear labels to avoid any text clipping across desktop and 375px mobile
const TACTIC_METRICS: Array<{ key: Tactic; label: string }> = [
  { key: "urgency", label: "Urgency" },
  { key: "authority_impersonation", label: "Authority" },
  { key: "isolation", label: "Isolation" },
  { key: "threat", label: "Threat" },
  { key: "too_good_to_be_true", label: "Too Good" },
  { key: "payment_request", label: "Payment" },
  { key: "personal_info_request", label: "Personal Info" },
];

export function TacticRadar({ counts }: TacticRadarProps) {
  const data = TACTIC_METRICS.map((metric) => {
    const rawCount = counts[metric.key] ?? 0;
    return {
      tactic: metric.label,
      // Scale count into 0-100 radius for clean geometry
      score: Math.min(100, rawCount * 25),
      rawCount,
    };
  });

  return (
    <div className="console-card p-5 sm:p-6">
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-xs text-blue-500 tracking-wider">
          // MANIPULATION RADAR
        </span>
        <span className="font-mono text-[10px] text-[var(--muted)]">
          7 AXIS COERCION PROFILE
        </span>
      </div>

      <div className="h-64 w-full -my-2">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart cx="50%" cy="50%" outerRadius="68%" data={data} margin={{ top: 12, right: 28, bottom: 12, left: 28 }}>
            <PolarGrid stroke="var(--line)" />
            <PolarAngleAxis
              dataKey="tactic"
              tick={{
                fill: "var(--muted)",
                fontSize: 10,
                fontFamily: "monospace",
              }}
            />
            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
            <Radar
              name="Tactic Presence"
              dataKey="score"
              stroke="#3B82F6"
              strokeWidth={1.5}
              fill="#3B82F6"
              fillOpacity={0.3}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[var(--line)] pt-3 text-[11px] font-mono text-[var(--muted)]">
        <div>
          <span>PRIMARY VECTOR:</span>{" "}
          <strong className="text-[var(--foreground)]">
            {Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a), ["none", 0])[0].replace(/_/g, " ")}
          </strong>
        </div>
        <div className="text-right">
          <span>COERCION COUNT:</span>{" "}
          <strong className="text-blue-500">
            {Object.values(counts).reduce((a, b) => a + b, 0)}
          </strong>
        </div>
      </div>
    </div>
  );
}