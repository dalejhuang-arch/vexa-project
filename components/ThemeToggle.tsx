"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [dark, setDark] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    try {
      localStorage.setItem("vexa-theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="no-print flex h-9 w-9 items-center justify-center rounded-full border border-[var(--line)] text-[var(--muted)] transition hover:border-blue-500/40 hover:text-[var(--foreground)]"
    >
      {mounted ? dark ? <Sun size={16} /> : <Moon size={16} /> : <span className="h-4 w-4" />}
    </button>
  );
}

export default ThemeToggle;