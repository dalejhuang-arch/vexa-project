"use client";

import React, { useEffect, useState } from "react";

interface RiskGaugeProps {
  score: number;
}

export function RiskGauge({ score }: RiskGaugeProps) {
  const [displayScore, setDisplayScore] = useState(0);

  useEffect(() => {
    // Mechanical readout ticking effect for forensic instrumentation feel
    let current = 0;
    const increment = Math.max(1, Math.floor(score / 35));
    const timer = setInterval(() => {
      current += increment;
      if (current >= score) {
        setDisplayScore(score);
        clearInterval(timer);
      } else {
        setDisplayScore(current);
      }
    }, 25);

    return () => clearInterval(timer);
  }, [score]);

  // Circumference for r=56 is ~352
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (circumference * displayScore) / 100;

  const isHighRisk = score >= 60;
  const isModerate = score >= 30 && score < 60;

  const strokeColor = isHighRisk
    ? "#F97316" // Flagged / Threat Orange
    : isModerate
    ? "#3B82F6" // System Blue
    : "#22C55E"; // Instrument Clear Green

  return (
    <div className="console-card p-6 text-center relative overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-xs text-blue-500 tracking-wider">
          // THREAT METRIC
        </span>
        <span className="font-mono text-[10px] text-[var(--muted)]">SCALE 0–100</span>
      </div>

      <div className="relative inline-flex items-center justify-center">
        <svg className="w-36 h-36 transform -rotate-90">
          {/* Background circle track */}
          <circle
            cx="72"
            cy="72"
            r={radius}
            stroke="var(--line)"
            strokeWidth="9"
            fill="transparent"
          />
          {/* Animated score stroke */}
          <circle
            cx="72"
            cy="72"
            r={radius}
            stroke={strokeColor}
            strokeWidth="9"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
            className="transition-all duration-75 ease-out"
          />
        </svg>

        {/* Live ticking digit readout */}
        <div 
          aria-live="polite" 
          className="absolute flex flex-col items-center justify-center font-mono"
        >
          <span className="text-4xl font-bold text-[var(--foreground)] tracking-tight">
            {displayScore}
          </span>
          <span className="text-[10px] text-[var(--muted)] tracking-widest uppercase mt-0.5">
            RISK SCORE
          </span>
        </div>
      </div>

      <p className="font-mono text-xs mt-4 tracking-wide text-[var(--foreground)] font-semibold">
        {isHighRisk ? (
          <span className="text-orange-500">CRITICAL COERCION SIGNALS DETECTED</span>
        ) : isModerate ? (
          <span className="text-blue-500">MODERATE SUSPICION PROFILE</span>
        ) : (
          <span className="text-emerald-500">CLEAR // LOW MANIPULATION RISK</span>
        )}
      </p>
    </div>
  );
}