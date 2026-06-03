// SMPTE Linear Timecode (LTC) encoder.
//
// Each video frame is encoded as an 80-bit packet, Biphase-Mark-Coded (BMC) at
// 80 × fps bits/s. The packet layout follows SMPTE 12M (frame/sec/min/hour
// units & tens BCD nibbles, status/user bits, sync word 0011_1111_1111_1101).
//
// We render this as PCM and pack into a 16-bit WAV. Mono is enough for LTC.
//
// References:
//   SMPTE 12M-1-2008 §5 (bit layout, sync word)
//   ITU-R BR.780 / EBU 6605 (LTC interchange)
//   wikipedia "Linear timecode" (BMC encoding diagram)

const SAMPLE_RATE = 48000;
const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]; // bits 64..79 (LSB-first slot order)

export interface LtcSpec {
  startTc: string;             // "HH:MM:SS:FF" or "HH:MM:SS;FF" for drop-frame
  fps: 24 | 25 | 29.97 | 30;   // SMPTE rates we generate
  dropFrame?: boolean;         // 29.97 DF only
  durationSec: number;
  sampleRate?: number;         // default 48000
  level?: number;              // peak 0..1 (default 0.5 = −6 dBFS)
}

export interface LtcResult {
  wav: Uint8Array;
  endTc: string;               // last frame TC written, useful for batch math
  frames: number;              // total frames written
}

/** Build a stereo-or-mono WAV header + PCM payload. */
function writeWavMono16(samples: Int16Array, sampleRate: number): Uint8Array {
  const byteLen = samples.byteLength;
  const buf = new Uint8Array(44 + byteLen);
  const dv = new DataView(buf.buffer);
  const setStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };
  setStr(0, "RIFF");
  dv.setUint32(4, 36 + byteLen, true);
  setStr(8, "WAVE");
  setStr(12, "fmt ");
  dv.setUint32(16, 16, true);     // PCM chunk size
  dv.setUint16(20, 1, true);       // PCM format
  dv.setUint16(22, 1, true);       // channels
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true);       // block align
  dv.setUint16(34, 16, true);      // bits/sample
  setStr(36, "data");
  dv.setUint32(40, byteLen, true);
  buf.set(new Uint8Array(samples.buffer, samples.byteOffset, byteLen), 44);
  return buf;
}

// --- TC math ----------------------------------------------------------------

const DROP_FRAMES_PER_MIN = 2;
const DF_FPS_NOMINAL = 30; // 29.97df advances on a 30-fps grid with skips

/** Parse "HH:MM:SS:FF" (or ";FF" for DF) into a frame count at `fpsNom`. */
function tcToFrames(tc: string, fpsNom: number, dropFrame: boolean): number {
  const m = tc.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/);
  if (!m) throw new Error(`Bad TC: "${tc}" — expect HH:MM:SS:FF`);
  const [h, mi, s, f] = [+m[1], +m[2], +m[3], +m[4]];
  if (f >= fpsNom) throw new Error(`Frame out of range: ${f} >= ${fpsNom}`);
  if (!dropFrame) return ((h * 60 + mi) * 60 + s) * fpsNom + f;
  // 29.97 DF: 2 frames dropped at every minute except every 10th minute
  const totalMins = h * 60 + mi;
  const dropped = DROP_FRAMES_PER_MIN * (totalMins - Math.floor(totalMins / 10));
  return ((h * 60 + mi) * 60 + s) * DF_FPS_NOMINAL + f - dropped;
}

function framesToTc(fr: number, fpsNom: number, dropFrame: boolean): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  let h: number, mi: number, s: number, f: number;
  if (!dropFrame) {
    f = fr % fpsNom;
    let total = Math.floor(fr / fpsNom);
    s = total % 60; total = Math.floor(total / 60);
    mi = total % 60;
    h = Math.floor(total / 60);
    return `${p2(h)}:${p2(mi)}:${p2(s)}:${p2(f)}`;
  }
  // Inverse of the DF skip: SMPTE 12M Annex A reference algorithm.
  const framesPer10Min = 17982;        // 30*60*10 − 18
  const framesPerMin = 1798;           // 30*60 − 2
  const d = Math.floor(fr / framesPer10Min);
  const n = fr % framesPer10Min;
  if (n < DROP_FRAMES_PER_MIN) {
    fr = fr + 9 * DROP_FRAMES_PER_MIN * d;
  } else {
    fr =
      fr + 9 * DROP_FRAMES_PER_MIN * d +
      DROP_FRAMES_PER_MIN * Math.floor((n - DROP_FRAMES_PER_MIN) / framesPerMin);
  }
  f = fr % DF_FPS_NOMINAL;
  let total = Math.floor(fr / DF_FPS_NOMINAL);
  s = total % 60; total = Math.floor(total / 60);
  mi = total % 60;
  h = Math.floor(total / 60);
  return `${p2(h)}:${p2(mi)}:${p2(s)};${p2(f)}`; // semicolon = DF marker
}

// --- 80-bit LTC packet ------------------------------------------------------

/** Build an 80-bit LTC packet for a given TC, returns bits[0..79]. */
function buildPacket(tc: string, fps: number, dropFrame: boolean): number[] {
  const m = tc.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/)!;
  const [h, mi, s, f] = [+m[1], +m[2], +m[3], +m[4]];

  const bits = new Array<number>(80).fill(0);
  // BCD helpers — write `n` into the bit slots [u0..u3] (units) or [t0..t?] (tens).
  const putBcd = (n: number, slots: number[]): void => {
    for (let i = 0; i < slots.length; i++) bits[slots[i]] = (n >> i) & 1;
  };
  // Frame units (0..3) + tens (8..9)
  putBcd(f % 10, [0, 1, 2, 3]);
  putBcd(Math.floor(f / 10), [8, 9]);
  // Drop-frame flag (bit 10), color-frame (bit 11)
  bits[10] = dropFrame ? 1 : 0;
  bits[11] = 0;
  // Seconds units (16..19) + tens (24..26)
  putBcd(s % 10, [16, 17, 18, 19]);
  putBcd(Math.floor(s / 10), [24, 25, 26]);
  // Polarity correction bit (27) — set later so total ones is even (BMC)
  // Minutes units (32..35) + tens (40..42)
  putBcd(mi % 10, [32, 33, 34, 35]);
  putBcd(Math.floor(mi / 10), [40, 41, 42]);
  // Binary group flag bit (43) — leave 0
  // Hours units (48..51) + tens (56..57)
  putBcd(h % 10, [48, 49, 50, 51]);
  putBcd(Math.floor(h / 10), [56, 57]);
  // Sync word (64..79)
  for (let i = 0; i < 16; i++) bits[64 + i] = SYNC_WORD[i];

  // Polarity correction (bit 27): make the parity even so BMC has no DC drift
  let ones = 0;
  for (let i = 0; i < 64; i++) ones += bits[i];
  bits[27] = (ones & 1) === 1 ? 1 : 0;
  return bits;
}

// --- Main render ------------------------------------------------------------

export function generateLtcWav(spec: LtcSpec): LtcResult {
  const sr = spec.sampleRate ?? SAMPLE_RATE;
  const level = Math.max(0, Math.min(1, spec.level ?? 0.5));
  const peak = Math.round(level * 32767);

  // Normalise fps: drop-frame still advances at 30 nominal fps (skipping frames
  // at minute boundaries via the TC math, NOT by changing audio rate).
  const isDf = !!spec.dropFrame && Math.abs(spec.fps - 29.97) < 0.01;
  const fpsNom = isDf ? 30 : Math.round(spec.fps);
  const fpsActual = isDf ? 30000 / 1001 : spec.fps; // 29.97 = 30000/1001

  const startFr = tcToFrames(spec.startTc, fpsNom, isDf);
  const totalFrames = Math.max(1, Math.round(spec.durationSec * fpsActual));

  // Each frame: 80 bits → BMC → 160 transitions. samplesPerHalfBit = sr / (fps*160).
  // We just track a running phase and toggle on every "1" half-bit; "0" only toggles
  // once per bit. Output sample = peak when phase==1 else -peak (square LTC).
  const samplesPerFrame = sr / fpsActual;
  const totalSamples = Math.ceil(samplesPerFrame * totalFrames);
  const out = new Int16Array(totalSamples);

  // Pre-compute the transition table for one frame's 80 bits.
  // BMC: ALWAYS flip at the start of a bit cell; if the bit is 1, ALSO flip in the middle.
  let writeIdx = 0;
  let phase = 1; // current level: +1 or -1
  // Carry phase across frames so the BMC stream is continuous.
  for (let fi = 0; fi < totalFrames; fi++) {
    const tc = framesToTc(startFr + fi, fpsNom, isDf);
    const bits = buildPacket(tc, fpsNom, isDf);
    // Each bit cell spans samplesPerFrame/80 samples.
    const cellSamples = samplesPerFrame / 80;
    for (let bi = 0; bi < 80; bi++) {
      // Edge at the start of the cell.
      phase = -phase;
      // Mid-cell edge if bit==1.
      const halfStart = Math.floor(fi * samplesPerFrame + bi * cellSamples);
      const halfMid = Math.floor(fi * samplesPerFrame + (bi + 0.5) * cellSamples);
      const halfEnd = Math.floor(fi * samplesPerFrame + (bi + 1) * cellSamples);
      // Fill first half
      for (let s = writeIdx; s < halfMid && s < totalSamples; s++) out[s] = phase * peak;
      writeIdx = Math.max(writeIdx, halfMid);
      if (bits[bi] === 1) phase = -phase;
      // Fill second half
      for (let s = writeIdx; s < halfEnd && s < totalSamples; s++) out[s] = phase * peak;
      writeIdx = Math.max(writeIdx, halfEnd);
      // halfStart kept for clarity / future debug — silence unused-var lint
      void halfStart;
    }
  }
  // Pad any remainder with the last phase
  for (let s = writeIdx; s < totalSamples; s++) out[s] = phase * peak;

  return {
    wav: writeWavMono16(out, sr),
    endTc: framesToTc(startFr + totalFrames - 1, fpsNom, isDf),
    frames: totalFrames,
  };
}

// --- Batch planner ----------------------------------------------------------

export interface BatchSpec {
  rangeStart: string;          // "HH:MM:SS" (frame implied 00)
  rangeEnd: string;            // exclusive end TC
  intervalSec: number;         // gap between file START times (e.g. 1800 = 30 min)
  durationSec: number;         // length of each file (e.g. 1500 = 25 min)
  fps: 24 | 25 | 29.97 | 30;
  dropFrame?: boolean;
  filenamePattern?: string;    // {tc}, {hh}, {mm}, {ss}, {idx}
}

export interface PlannedFile {
  filename: string;
  startTc: string;
  endTc: string;               // start + duration (exclusive)
  durationSec: number;
}

const DEFAULT_PATTERN = "ltc_{hh}-{mm}.wav";

export function planBatch(spec: BatchSpec): PlannedFile[] {
  const isDf = !!spec.dropFrame && Math.abs(spec.fps - 29.97) < 0.01;
  const fpsNom = isDf ? 30 : Math.round(spec.fps);
  const fpsActual = isDf ? 30000 / 1001 : spec.fps;
  const norm = (s: string): string => (s.length === 8 ? s + (isDf ? ";00" : ":00") : s);
  const startFr = tcToFrames(norm(spec.rangeStart), fpsNom, isDf);
  const endFr = tcToFrames(norm(spec.rangeEnd), fpsNom, isDf);
  if (endFr <= startFr) throw new Error("Range end must be after the start.");
  const stepFrames = Math.round(spec.intervalSec * fpsActual);
  const dur = Math.round(spec.durationSec * fpsActual);
  const pattern = spec.filenamePattern || DEFAULT_PATTERN;

  const out: PlannedFile[] = [];
  let idx = 0;
  for (let fr = startFr; fr < endFr; fr += stepFrames, idx++) {
    const startTc = framesToTc(fr, fpsNom, isDf);
    const endTc = framesToTc(fr + dur - 1, fpsNom, isDf);
    const m = startTc.match(/^(\d{2}):(\d{2}):(\d{2})/)!;
    const filename = pattern
      .replace("{tc}", startTc.replace(/[:;]/g, "-"))
      .replace("{hh}", m[1])
      .replace("{mm}", m[2])
      .replace("{ss}", m[3])
      .replace("{idx}", String(idx + 1).padStart(3, "0"));
    out.push({ filename, startTc, endTc, durationSec: spec.durationSec });
  }
  return out;
}

// --- Minimal ZIP (store-only, no compression) for batch download -----------

interface ZipEntry { name: string; data: Uint8Array; }
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    // Local file header
    const lh = new Uint8Array(30 + nameBuf.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method 0 = store
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); // time/date (placeholder)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBuf.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBuf, 30);
    fileParts.push(lh, e.data);

    // Central dir header
    const ch = new Uint8Array(46 + nameBuf.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBuf, 46);
    centralParts.push(ch);

    offset += lh.length + e.data.length;
  }
  const centralLen = centralParts.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralLen, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralLen + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of fileParts) { out.set(part, p); p += part.length; }
  for (const part of centralParts) { out.set(part, p); p += part.length; }
  out.set(end, p);
  return out;
}

// --- exports for tests / debug ----
export const _internal = { tcToFrames, framesToTc, buildPacket };
