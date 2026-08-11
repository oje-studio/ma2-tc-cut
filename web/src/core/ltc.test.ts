// LTC encoder unit tests — the SMPTE math that the generator's correctness
// rests on. Run with `npm test` (vitest); gates the Pages deploy in CI.
import { describe, it, expect } from "vitest";
import {
  generateLtcWav,
  renderLtcPcm,
  writeWavStereo16,
  floatToInt16,
  planBatch,
  buildZip,
  chunkByBytes,
  _internal,
} from "./ltc.ts";

const { tcToFrames, framesToTc, buildPacket } = _internal;

describe("timecode math (non-drop)", () => {
  it("round-trips across rates", () => {
    for (const fps of [24, 25, 30]) {
      for (const tc of ["00:00:00:00", "00:59:59:23", "01:00:00:00", "23:59:59:23"]) {
        const fr = tcToFrames(tc, fps, false);
        expect(framesToTc(fr, fps, false)).toBe(tc);
      }
    }
  });

  it("computes absolute frames", () => {
    expect(tcToFrames("00:00:01:00", 30, false)).toBe(30);
    expect(tcToFrames("01:00:00:00", 25, false)).toBe(90000);
  });

  it("rejects malformed TC and out-of-range frames", () => {
    expect(() => tcToFrames("bad", 30, false)).toThrow();
    expect(() => tcToFrames("00:00:00:30", 30, false)).toThrow(); // FF >= fps
  });
});

describe("drop-frame math (29.97 DF, SMPTE Annex A)", () => {
  it("drops frames 00/01 at minute boundaries", () => {
    const last = tcToFrames("00:00:59;29", 30, true);
    expect(framesToTc(last + 1, 30, true)).toBe("00:01:00;02");
  });

  it("does NOT drop at every 10th minute", () => {
    const last = tcToFrames("00:09:59;29", 30, true);
    expect(framesToTc(last + 1, 30, true)).toBe("00:10:00;00");
  });

  it("round-trips arbitrary DF timecodes", () => {
    for (const tc of ["00:01:00;02", "00:10:00;00", "01:23:45;10", "23:59:59;29"]) {
      const fr = tcToFrames(tc, 30, true);
      expect(framesToTc(fr, 30, true)).toBe(tc);
    }
  });

  it("one DF hour is 107,892 frames (30fps nominal minus 108 dropped)", () => {
    expect(tcToFrames("01:00:00;00", 30, true)).toBe(108000 - 108);
  });
});

describe("80-bit LTC packet", () => {
  it("carries the SMPTE sync word in bits 64–79", () => {
    const bits = buildPacket("00:00:00:00", 30, false);
    expect(bits).toHaveLength(80);
    expect(bits.slice(64)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
  });

  it("encodes BCD fields (frame/sec/min/hour units + tens)", () => {
    const bits = buildPacket("12:34:56:17", 30, false);
    const nib = (slots: number[]) => slots.reduce((v, s, i) => v | (bits[s] << i), 0);
    expect(nib([0, 1, 2, 3])).toBe(7);   // frame units
    expect(nib([8, 9])).toBe(1);          // frame tens
    expect(nib([16, 17, 18, 19])).toBe(6); // sec units
    expect(nib([24, 25, 26])).toBe(5);     // sec tens
    expect(nib([32, 33, 34, 35])).toBe(4); // min units
    expect(nib([40, 41, 42])).toBe(3);     // min tens
    expect(nib([48, 49, 50, 51])).toBe(2); // hour units
    expect(nib([56, 57])).toBe(1);         // hour tens
  });

  it("sets the polarity bit so bits 0–63 have even parity", () => {
    for (const tc of ["00:00:00:00", "12:34:56:17", "23:59:59:29"]) {
      const bits = buildPacket(tc, 30, false);
      const ones = bits.slice(0, 64).reduce((a, b) => a + b, 0);
      expect(ones % 2).toBe(0);
    }
  });

  it("sets the drop-frame flag (bit 10) only in DF mode", () => {
    expect(buildPacket("00:00:00;00", 30, true)[10]).toBe(1);
    expect(buildPacket("00:00:00:00", 30, false)[10]).toBe(0);
  });
});

describe("generateLtcWav", () => {
  it("renders exact frame counts and end TC (user scenario: 25 min @ 30fps)", () => {
    const r = generateLtcWav({ startTc: "00:00:00:00", fps: 30, durationSec: 1500, sampleRate: 8000 });
    expect(r.frames).toBe(45000);
    expect(r.endTc).toBe("00:24:59:29");
  });

  it("produces a valid 16-bit mono WAV header", () => {
    // fps 25 ⇒ 8000/25 = 320 samples/frame exactly — no fp-ceil drift.
    const r = generateLtcWav({ startTc: "00:00:00:00", fps: 25, durationSec: 60, sampleRate: 8000 });
    const dv = new DataView(r.wav.buffer, r.wav.byteOffset);
    const tag = (off: number) => String.fromCharCode(...r.wav.slice(off, off + 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(dv.getUint16(22, true)).toBe(1);      // mono
    expect(dv.getUint32(24, true)).toBe(8000);   // sample rate
    expect(dv.getUint16(34, true)).toBe(16);     // bits/sample
    expect(r.wav.byteLength).toBe(44 + 8000 * 60 * 2);
  });

  it("respects the level parameter", () => {
    const loud = renderLtcPcm({ startTc: "00:00:00:00", fps: 30, durationSec: 0.2, sampleRate: 8000, level: 1 });
    const quiet = renderLtcPcm({ startTc: "00:00:00:00", fps: 30, durationSec: 0.2, sampleRate: 8000, level: 0.25 });
    const peak = (p: Int16Array) => Math.max(...Array.from(p, Math.abs));
    expect(peak(loud.pcm)).toBeGreaterThan(30000);
    expect(peak(quiet.pcm)).toBeLessThan(8400);
  });
});

describe("writeWavStereo16 — LTC + music track routing", () => {
  it("emits a valid stereo header and interleaves L/R", () => {
    const left = Int16Array.from([1000, -1000, 500]);
    const right = Int16Array.from([-2000, 2000]);
    const wav = writeWavStereo16(left, right, 48000);
    const dv = new DataView(wav.buffer, wav.byteOffset);
    expect(dv.getUint16(22, true)).toBe(2);            // stereo
    expect(dv.getUint32(24, true)).toBe(48000);        // sample rate
    expect(dv.getUint32(28, true)).toBe(48000 * 4);    // byte rate
    expect(dv.getUint16(32, true)).toBe(4);            // block align
    expect(dv.getUint32(40, true)).toBe(3 * 4);        // data = max(len) frames
    expect(dv.getInt16(44, true)).toBe(1000);          // L0
    expect(dv.getInt16(46, true)).toBe(-2000);         // R0
    expect(dv.getInt16(48, true)).toBe(-1000);         // L1
    expect(dv.getInt16(50, true)).toBe(2000);          // R1
    expect(dv.getInt16(52, true)).toBe(500);           // L2
  });

  it("pads the shorter channel with silence so LTC outlives the song", () => {
    const ltc = Int16Array.from([1, 2, 3, 4]);
    const song = Int16Array.from([9]);
    const wav = writeWavStereo16(ltc, song, 8000);
    const dv = new DataView(wav.buffer, wav.byteOffset);
    expect(wav.byteLength).toBe(44 + 4 * 4);
    expect(dv.getInt16(46 + 4, true)).toBe(0);         // R1 silent
    expect(dv.getInt16(44 + 3 * 4, true)).toBe(4);     // L3 still ticking
  });
});

describe("floatToInt16", () => {
  it("scales, clamps out-of-range floats and pads to length", () => {
    const out = floatToInt16(Float32Array.from([0.5, -2, 2]), 1, 5);
    expect(out[0]).toBe(16384);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(32767);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it("applies gain and truncates past length", () => {
    const out = floatToInt16(Float32Array.from([1, 1]), 0.5, 1);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(Math.round(0.5 * 32767));
  });
});

describe("planBatch — the 'whole day every 30 min' scenario", () => {
  const spec = {
    rangeStart: "00:00:00",
    rangeEnd: "23:59:00",
    intervalSec: 1800,
    durationSec: 1500,
    fps: 30 as const,
  };

  it("plans 48 files with correct boundaries", () => {
    const files = planBatch(spec);
    expect(files).toHaveLength(48);
    expect(files[0].startTc).toBe("00:00:00:00");
    expect(files[0].endTc).toBe("00:24:59:29");
    expect(files[47].startTc).toBe("23:30:00:00");
    expect(files[47].endTc).toBe("23:54:59:29");
  });

  it("applies the filename pattern tokens", () => {
    const files = planBatch({ ...spec, filenamePattern: "ltc_{hh}-{mm}_{idx}" });
    expect(files[0].filename).toBe("ltc_00-00_001");
    expect(files[47].filename).toBe("ltc_23-30_048");
  });

  it("rejects an inverted range", () => {
    expect(() => planBatch({ ...spec, rangeStart: "10:00:00", rangeEnd: "09:00:00" })).toThrow();
  });
});

describe("chunkByBytes — memory ceiling for batch ZIPs", () => {
  const GB = 1024 ** 3;

  it("splits when a chunk would exceed the cap", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ id: i, bytes: 1 * GB }));
    const { chunks, truncated } = chunkByBytes(items, 1.5 * GB, 6);
    expect(chunks).toHaveLength(4); // 2× 1GB = 2GB > 1.5GB → one per chunk
    expect(truncated).toBe(0);
  });

  it("reports truncation when maxChunks is hit", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, bytes: 1 * GB }));
    const { chunks, truncated } = chunkByBytes(items, 1 * GB, 2);
    expect(chunks).toHaveLength(2);
    expect(truncated).toBe(4);
  });

  it("always allows at least one oversize item per chunk", () => {
    const { chunks } = chunkByBytes([{ bytes: 5 * GB }], 1 * GB, 6);
    expect(chunks).toHaveLength(1);
  });
});

describe("buildZip — store-only container", () => {
  it("emits local headers + EOCD with the right entry count", () => {
    const zip = buildZip([
      { name: "a.wav", data: new Uint8Array([1, 2, 3]) },
      { name: "b.wav", data: new Uint8Array([4, 5]) },
    ]);
    const dv = new DataView(zip.buffer, zip.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);                  // PK\3\4
    expect(dv.getUint32(zip.byteLength - 22, true)).toBe(0x06054b50); // EOCD
    expect(dv.getUint16(zip.byteLength - 22 + 10, true)).toBe(2);     // entries
  });
});
