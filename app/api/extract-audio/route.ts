// app/api/extract-audio/route.ts
// Fixes silent video + "Acoustic cadence skipped": the browser often can't decode a container's
// audio codec. ffmpeg turns ANY media into a 16 kHz mono WAV every browser can decode and play.
import { NextResponse } from "next/server";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;

function run(bin: string, args: string[], ms: number): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    let err = "";
    const p = spawn(bin, args);
    const t = setTimeout(() => p.kill("SIGKILL"), ms);
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: -1, err: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, err });
    });
  });
}

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ error: { message, code } }, { status });

export async function POST(request: Request) {
  let file: File | null = null;
  try {
    const c = (await request.formData()).get("file");
    if (c instanceof File) file = c;
  } catch {
    return fail(400, "bad_request", "Invalid media payload.");
  }
  if (!file || file.size === 0) return fail(400, "bad_request", "No media file provided.");
  if (file.size > MAX_BYTES) return fail(413, "too_large", "Media files must be 20 MB or smaller.");

  const dir = await mkdtemp(path.join(tmpdir(), "vexa-"));
  try {
    const input = path.join(dir, "in.bin");
    const output = path.join(dir, "out.wav");
    await writeFile(input, Buffer.from(await file.arrayBuffer()));
    const bin = ffmpegPath ?? "ffmpeg";
    const { code, err } = await run(bin, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-t", "600", "-c:a", "pcm_s16le", output], 45_000);
    if (code === -1) return fail(501, "no_ffmpeg", "Server-side audio extraction is unavailable (ffmpeg not installed).");
    const out = await readFile(output).catch(() => null);
    if (!out || out.length < 1000) {
      if (/does not contain any stream|Stream map .* matches no streams|no audio/i.test(err) || !/Audio:/i.test(err)) {
        return fail(422, "no_audio", "This file has no audio track.");
      }
      return fail(422, "extract_failed", "Could not extract audio from this file.");
    }
    return new NextResponse(new Uint8Array(out), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}