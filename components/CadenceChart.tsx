// components/CadenceChart.tsx
"use client";

import React from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import type { CadencePoint } from "@/lib/audioAnalysis";

interface CadenceChartProps {
  telemetry: CadencePoint[];
  flaggedTimestamps?: number[];
}

export function CadenceChart({ telemetry, flaggedTimestamps = [] }: CadenceChartProps) {
  if (!telemetry || telemetry.length === 0) return null;

  return (
    <div className="w-full bg-white/[0.02] border border-white/10 rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <span className="font-mono text-xs tracking-wider text-blue-400">{"// AUDIO CADENCE"}</span>
            <h4 className="font-sans font-bold text-sm text-[var(--foreground)]">Energy and pauses only</h4>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-[var(--muted)]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" /> Energy Level
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" /> Flagged Tactic Marker
          </span>
        </div>
      </div>

      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={telemetry} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="energyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="timestamp"
              unit="s"
              tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "monospace" }}
              axisLine={{ stroke: "var(--line)" }}
            />
            <YAxis
              tick={{ fill: "var(--muted)", fontSize: 11, fontFamily: "monospace" }}
              axisLine={{ stroke: "var(--line)" }}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const data = payload[0].payload as CadencePoint;
                  return (
                    <div className="bg-[var(--card)] border border-[var(--line)] p-2 rounded-lg font-mono text-xs shadow-xl">
                      <p className="text-[var(--muted)]">Time: {data.timestamp}s</p>
                      <p className="text-blue-400">Energy: {data.energy}%</p>
                      {data.isPause && <p className="text-amber-400">Low Vocal Energy (Pause)</p>}
                    </div>
                  );
                }
                return null;
              }}
            />
            <Area
              type="monotone"
              dataKey="energy"
              stroke="#3B82F6"
              strokeWidth={1.5}
              fillOpacity={1}
              fill="url(#energyGrad)"
            />
            {flaggedTimestamps.map((sec, idx) => (
              <ReferenceLine
                key={idx}
                x={sec}
                stroke="#F97316"
                strokeDasharray="3 3"
                label={{ value: "FLAG", fill: "#F97316", fontSize: 9, position: "top" }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}