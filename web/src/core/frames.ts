// Timecode <-> absolute frame number. Port of ma2_tc_cut.py / tcshow.py.
// `time` in the XML is a FRAME NUMBER at the show's frame_format, not ms.

export function tcToFrames(tc: string, fps: number): number {
  const parts = String(tc).split(":").map((p) => parseInt(p, 10));
  while (parts.length < 4) parts.unshift(0);
  const [h, m, s, f] = parts;
  return (h * 3600 + m * 60 + s) * fps + f;
}

export function framesToTc(fr: number, fps: number): string {
  // MA3 decimal-second exports can land a few nanoseconds below an exact frame.
  // Stabilize the display without quantizing stored event times.
  fr = Math.trunc(fr + (fr >= 0 ? 1e-6 : 0));
  // floor division / modulo that matches Python divmod for non-negative frames
  let s = Math.floor(fr / fps);
  const f = fr - s * fps;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(f)}`;
}
