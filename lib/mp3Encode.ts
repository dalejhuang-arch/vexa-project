// lib/mp3Encode.ts
// Browser-side MP3 encoding via lamejs, so every upload — however long the
// original recording is — stays safely under Vercel's ~4.5MB serverless
// request-body ceiling automatically. No manual "shrink it first" step needed.
import lamejs from "lamejs";

// Stay comfortably under Vercel's hard 4.5MB cap, leaving headroom for
// multipart/form-data overhead and any future growth in that limit's margin.
const TARGET_BYTES = 4 * 1024 * 1024;

// Standard MP3 bitrates lamejs supports. We pick the highest one that still
// keeps the whole file under TARGET_BYTES for its duration.
const ALLOWED_KBPS = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128];

function pickBitrate(durationSec: number): number {
  const idealKbps = Math.floor((TARGET_BYTES * 8) / Math.max(1, durationSec) / 1000);
  let best = ALLOWED_KBPS[0]!;
  for (const kbps of ALLOWED_KBPS) {
    if (kbps <= idealKbps) best = kbps;
  }
  // Never go below 16kbps (speech becomes unintelligible mush) or above
  // 64kbps (wasted bytes for voice-only content — no benefit to Gemini).
  return Math.min(64, Math.max(16, best));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resamples `mono` to 16kHz and encodes it as a mono MP3, dynamically
 * choosing the bitrate so the OUTPUT FILE SIZE is guaranteed to stay under
 * TARGET_BYTES regardless of how long the source recording is. A 30-second
 * clip and a 20-minute clip both come out safely under the limit — the
 * longer one just gets a lower (still speech-clear) bitrate.
 */
export async function encodeCompactMp3(mono: Float32Array, sourceRate: number, name: string): Promise<File> {
  const targetRate = 16000;
  const ratio = sourceRate / targetRate;
  const outLen = Math.floor(mono.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = a; k < b; k++) sum += mono[k] ?? 0;
    const v = Math.min(1, Math.max(-1, sum / (b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  const durationSec = outLen / targetRate;
  const kbps = pickBitrate(durationSec);
  const encoder = new lamejs.Mp3Encoder(1, targetRate, kbps);
  const chunks: Uint8Array[] = [];
  const FRAME = 1152; // MPEG frame size lamejs expects per encodeBuffer call

  for (let i = 0; i < pcm.length; i += FRAME) {
    const slice = pcm.subarray(i, i + FRAME);
    const buf = encoder.encodeBuffer(slice);
    if (buf.length > 0) chunks.push(new Uint8Array(buf));
    // Yield to the main thread periodically so a long recording doesn't
    // freeze the UI while encoding (mirrors the pattern in measure()).
    if ((i / FRAME) % 400 === 399) await sleep(0);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  const base = name.replace(/\.[^.]+$/, "") || "audio";
  return new File([out], `${base}-compact.mp3`, { type: "audio/mpeg" });
}