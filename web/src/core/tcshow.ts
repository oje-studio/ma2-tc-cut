// Read-only analysis of grandMA2 timecode XML — port of tcshow.py.
// Drives the info line, the timeline lanes, and the BPM estimate.
import { framesToTc } from "./frames.ts";

const FRAME_FMT = /frame_format="[^"]*?(\d+)/;
const TC_NAME = /<Timecode\b[^>]*\bname="([^"]*)"/;
const SUBTRACK = /<SubTrack\b/;
const EVENT = /<Event\b[^>]*\btime="(\d+)"/;
const OBJ_NAME = /<Object\b[^>]*\bname="([^"]*)"/;
const CUE_NAME = /<Cue\b[^>]*\bname="([^"]*)"/;
const BOM = "﻿";

export interface ShowSummary {
  fps: number;
  name: string;
  nEvents: number;
  nSubtracks: number;
  firstFrame: number;
  lastFrame: number;
  firstTc: string;
  lastTc: string;
}

export interface Lane {
  name: string;
  events: Array<[number, string]>; // (frame, cue name)
}

/** Decode an uploaded file: strip a leading UTF-8 BOM, remember whether it was there. */
export function decodeShow(buf: ArrayBuffer): { hasBom: boolean; text: string } {
  const bytes = new Uint8Array(buf);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = hasBom ? bytes.subarray(3) : bytes;
  const text = new TextDecoder("utf-8").decode(body);
  return { hasBom, text };
}

/** Re-encode for download: prepend the BOM iff the original had one. */
export function encodeShow(text: string, hasBom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!hasBom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}

export function getFps(text: string): number {
  const m = FRAME_FMT.exec(text);
  if (!m) throw new Error("frame_format not found — is this a grandMA2 timecode XML?");
  return parseInt(m[1], 10);
}

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Frames per subtrack, in document order. */
export function eventsBySubtrack(text: string): number[][] {
  const result: number[][] = [];
  let cur: number[] | null = null;
  for (const line of text.split(eol(text))) {
    if (SUBTRACK.test(line)) {
      cur = [];
      result.push(cur);
    } else if (cur !== null) {
      const m = EVENT.exec(line);
      if (m) cur.push(parseInt(m[1], 10));
    }
  }
  return result;
}

export function summary(text: string): ShowSummary {
  const fps = getFps(text);
  const subs = eventsBySubtrack(text);
  const times: number[] = [];
  for (const s of subs) for (const t of s) times.push(t);
  const nm = TC_NAME.exec(text);
  const first = times.length ? Math.min(...times) : 0;
  const last = times.length ? Math.max(...times) : 0;
  return {
    fps,
    name: nm ? nm[1] : "(unnamed)",
    nEvents: times.length,
    nSubtracks: subs.length,
    firstFrame: first,
    lastFrame: last,
    firstTc: framesToTc(first, fps),
    lastTc: framesToTc(last, fps),
  };
}

/**
 * Rough tempo from the cue grid: moments where >=3 subtracks fire together are
 * almost always downbeats; find the frame length that best divides the gaps.
 * Returns { beatFrames, bpm } or null. A hint — always overridable.
 */
export function estimateBeat(text: string): { beatFrames: number; bpm: number } | null {
  const fps = getFps(text);
  const subs = eventsBySubtrack(text);
  const hits = new Map<number, Set<number>>();
  subs.forEach((times, si) => {
    for (const t of times) {
      let s = hits.get(t);
      if (!s) hits.set(t, (s = new Set()));
      s.add(si);
    }
  });
  const struct = [...hits.entries()].filter(([, s]) => s.size >= 3).map(([t]) => t).sort((a, b) => a - b);
  let gaps: number[] = [];
  for (let i = 1; i < struct.length; i++) gaps.push(struct[i] - struct[i - 1]);
  gaps = gaps.filter((g) => g >= 10 && g <= 700);
  if (gaps.length < 3) return null;

  let bestB: number | null = null;
  let bestErr = 1e9;
  for (let b = 10.0; b <= 40.0; b += 0.1) {
    let err = 0;
    for (const g of gaps) {
      const r = g % b;
      err += Math.min(r, b - r) / b;
    }
    err /= gaps.length;
    if (err < bestErr) {
      bestErr = err;
      bestB = b;
    }
  }
  if (bestB === null || bestErr > 0.18) return null;

  // Octave-correct into a musical range so we report the felt beat.
  let bpm = (fps * 60.0) / bestB;
  while (bpm >= 140.0) bpm /= 2.0;
  while (bpm < 70.0) bpm *= 2.0;
  return { beatFrames: (fps * 60.0) / bpm, bpm };
}

/** Per-subtrack lanes for the timeline. */
export function lanes(text: string): Lane[] {
  const out: Lane[] = [];
  let cur: Lane | null = null;
  let pending: number | null = null;
  let obj: string | null = null;
  for (const line of text.split(eol(text))) {
    const mo = OBJ_NAME.exec(line);
    if (mo) {
      obj = mo[1];
      continue;
    }
    if (SUBTRACK.test(line)) {
      cur = { name: obj || `Track ${out.length + 1}`, events: [] };
      out.push(cur);
      obj = null;
      pending = null;
      continue;
    }
    if (cur === null) continue;
    const me = EVENT.exec(line);
    if (me) {
      pending = parseInt(me[1], 10);
      continue;
    }
    const mc = CUE_NAME.exec(line);
    if (mc && pending !== null) {
      cur.events.push([pending, mc[1]]);
      pending = null;
    }
  }
  return out;
}

export { BOM };
