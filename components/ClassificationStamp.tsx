"use client";

import React from "react";
import type { Category } from "@/lib/schema";

interface ClassificationStampProps {
  category: Category;
  risk: number;
}

export function ClassificationStamp({ category, risk }: ClassificationStampProps) {
  const isHighRisk = risk >= 60;

  return (
    <div className="flex items-center gap-3">
      <div
        className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-1.5 font-mono text-xs font-bold tracking-wider uppercase transition-transform select-none ${
          isHighRisk
            ? "border-orange-500/80 bg-orange-500/10 text-orange-500 dark:text-orange-400 -rotate-3"
            : "border-blue-500/80 bg-blue-500/10 text-blue-600 dark:text-blue-400 -rotate-2"
        }`}
        style={{
          boxShadow: isHighRisk
            ? "0 0 15px rgba(249, 115, 22, 0.15)"
            : "0 0 15px rgba(59, 130, 246, 0.15)",
        }}
      >
        <span className="inline-block h-2 w-2 rounded-full animate-ping" style={{ backgroundColor: isHighRisk ? "#F97316" : "#3B82F6" }} />
        <span>CLASSIFIED: {category}</span>
      </div>
    </div>
  );
}