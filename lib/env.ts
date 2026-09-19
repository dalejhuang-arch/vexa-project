// lib/env.ts
const PLACEHOLDERS = new Set(["", "your_key_here", "replace-with-your-gemini-api-key"]);

export function hasGeminiApiKey(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  return !PLACEHOLDERS.has(key) && !key.startsWith("YOUR_");
}

export function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (PLACEHOLDERS.has(key) || key.startsWith("YOUR_")) {
    throw new Error("GEMINI_API_KEY is missing. Please add a valid key to .env.local.");
  }
  return key;
}