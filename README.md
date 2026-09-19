# Vexa

Vexa is a scam-call forensics console for cybersecurity analysis. Paste a suspicious call transcript, or try one of the cached examples, to see the manipulation tactic used on each segment, an overall risk score, and a practical counter-response.

## Features

- AI analysis through a server-only Gemini route with Zod validation, timeout/retry, and a local fallback.
- Three instant hardcoded forensic examples for demo reliability.
- Expandable evidence timeline, risk gauge, tactic radar, scan metadata, glossary, and terminal-style status log.
- Optional client-side audio cadence extraction using Meyda; raw audio samples never leave the browser.
- Dark/light theme persistence with keyboard-accessible controls and reduced-motion support.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, Framer Motion, Recharts, lucide-react, Meyda, Zod, and `@google/genai`.

## Getting started

```bash
npm install
# edit .env.local and set GEMINI_API_KEY
npm run dev
```

Open http://localhost:3000. For a deterministic degraded-mode demo, set `FORCE_FALLBACK=true` in `.env.local`.

```bash
npm run lint
npm run typecheck
npm run build
```

AI disclosure: Vexa uses AI to organize evidence, not to make legal or financial decisions. Review findings before acting.
