// lib/audioAnalysis.ts
import type { AudioSummary } from "./schema";

export interface CadencePoint {
  timestamp: number;
  energy: number;
  isPause: boolean;
}

export interface FullAudioAnalysis {
  summary: AudioSummary;
  audioSummary: AudioSummary;
  telemetry: CadencePoint[];
  cadencePoints: CadencePoint[];
  durationSec: number;
}

const FRAME = 2048;
const HOP = 1024;
const MAX_DECODE_BYTES = 40 * 1024 * 1024;

function empty(): FullAudioAnalysis {
  const summary: AudioSummary = { pauseCount: 0, longestPauseSec: 0, paceSpikeTimestamps: [] };
  return {
    summary,
    audioSummary: summary,
    telemetry: [],
    cadencePoints: [],
    durationSec: 0,
  };
}

export async function analyzeAudio(file: File): Promise<FullAudioAnalysis> {
  if (typeof window === "undefined" || file.size > MAX_DECODE_BYTES) return empty();

  let audioCtx: AudioContext | OfflineAudioContext | null = null;
  try {
    const rawBuffer = await file.arrayBuffer();
    // Clone arrayBuffer to prevent detachment bugs across context instances
    const bufferClone = rawBuffer.slice(0);

    // Primary: standard AudioContext without output routing (passive decoding)
    const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtor) {
      audioCtx = new AudioCtor();
    } else {
      audioCtx = new OfflineAudioContext(1, 44100 * 10, 44100);
    }

    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
      const promise = audioCtx!.decodeAudioData(bufferClone, resolve, reject);
      if (promise && typeof promise.catch === "function") {
        promise.catch(reject);
      }
    });

    const sampleRate = audioBuffer.sampleRate;
    const channel = audioBuffer.getChannelData(0);
    const frameCount = Math.max(0, Math.floor((channel.length - FRAME) / HOP) + 1);
    if (frameCount === 0) return empty();

    // Step 1: Compute Root Mean Square (RMS) frame energy
    const rms = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      const start = f * HOP;
      let sum = 0;
      for (let i = 0; i < FRAME; i++) {
        const val = channel[start + i] || 0;
        sum += val * val;
      }
      rms[f] = Math.sqrt(sum / FRAME);
    }

    // Step 2: Dynamic noise floor calibration
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0.01;
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] || 0.05;
    const silenceFloor = Math.min(0.025, Math.max(0.003, p95 * 0.12));
    const spikeFloor = Math.max(p95 * 0.65, silenceFloor * 3.5);
    const peakLoudness = Math.max(p99, 0.02);

    const frameDuration = HOP / sampleRate;
    const telemetry: CadencePoint[] = [];
    const paceSpikes: number[] = [];
    let silenceDuration = 0;
    let pauseCount = 0;
    let longestPause = 0;
    const rollingWindow: number[] = [];

    const commitPause = () => {
      if (silenceDuration >= 0.45) {
        pauseCount++;
        if (silenceDuration > longestPause) longestPause = silenceDuration;
      }
      silenceDuration = 0;
    };

    for (let f = 0; f < frameCount; f++) {
      const val = rms[f]!;
      const timestamp = Number(((f * HOP) / sampleRate).toFixed(2));
      const isSilent = val < silenceFloor;

      if (isSilent) {
        silenceDuration += frameDuration;
      } else {
        commitPause();
      }

      rollingWindow.push(val);
      if (rollingWindow.length > 20) rollingWindow.shift();
      const avg = rollingWindow.reduce((a, b) => a + b, 0) / rollingWindow.length;

      if (val > spikeFloor && val > avg * 2.1) {
        const lastSpike = paceSpikes[paceSpikes.length - 1];
        if (lastSpike === undefined || timestamp - lastSpike > 2.0) {
          paceSpikes.push(timestamp);
        }
      }

      // Sample down for UI display (every 0.25s)
      const prev = telemetry[telemetry.length - 1];
      if (!prev || timestamp - prev.timestamp >= 0.25) {
        telemetry.push({
          timestamp,
          energy: Number(Math.min(100, (val / peakLoudness) * 100).toFixed(1)),
          isPause: isSilent,
        });
      }
    }
    commitPause();

    const summary: AudioSummary = {
      pauseCount,
      longestPauseSec: Number(longestPause.toFixed(1)),
      paceSpikeTimestamps: paceSpikes,
    };

    return {
      summary,
      audioSummary: summary,
      telemetry,
      cadencePoints: telemetry,
      durationSec: Number(audioBuffer.duration.toFixed(2)),
    };
  } catch (err) {
    console.warn("[VEXA_AUDIO_ENGINE_FAILOVER]:", err);
    return empty();
  } finally {
    if (audioCtx && "close" in audioCtx && typeof audioCtx.close === "function") {
      audioCtx.close().catch(() => {});
    }
  }
}