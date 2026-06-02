// Ripple cut — byte-exact port of ripple_cut() in ma2_tc_cut.py.
//
// Removes the window [cutIn, cutIn+cutLen) and slides every later event left.
// It edits ONLY the index/time attributes on <Event ...> open lines and removes
// the cut <Event>...</Event> blocks whole. Everything else (BOM handled by the
// caller, declaration, namespace, tab indentation, line endings, no trailing
// newline) is preserved character-for-character so grandMA2 re-imports cleanly.
//
// This module is intentionally self-contained (no imports) so it can be unit
// tested against the Python implementation in isolation.

const EVENT_OPEN = /<Event\b/;
const SUBTRACK = /<SubTrack\b/;
const TIME_ATTR = /(\btime=")(\d+)(")/;
const INDEX_ATTR = /(\bindex=")(\d+)(")/;
const SELF_CLOSE_END = /\/>\s*$/;
const CUE_NAME = /<Cue\b[^>]*\bname="([^"]*)"/;

export interface CutResult {
  text: string;
  deleted: Array<[number, string]>; // (frame, cue name)
  shifted: number;
}

export function rippleCut(text: string, cutIn: number, cutLen: number): CutResult {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const n = lines.length;
  const cutEnd = cutIn + cutLen;

  const out: string[] = [];
  const deleted: Array<[number, string]> = [];
  let shifted = 0;
  let idx = 0; // index counter within the current SubTrack
  let i = 0;

  while (i < n) {
    const line = lines[i];

    if (SUBTRACK.test(line)) {
      idx = 0;
      out.push(line);
      i += 1;
      continue;
    }

    if (EVENT_OPEN.test(line)) {
      const block: string[] = [line];
      let j = i;
      const single = line.includes("</Event>") || SELF_CLOSE_END.test(line);
      if (!single) {
        j = i + 1;
        while (j < n) {
          block.push(lines[j]);
          if (lines[j].includes("</Event>")) break;
          j += 1;
        }
      }
      const tm = TIME_ATTR.exec(line);
      const t = parseInt(tm![2], 10);

      if (cutIn <= t && t < cutEnd) {
        // inside the cut -> delete the whole block
        let name = "?";
        for (const bl of block) {
          const cm = CUE_NAME.exec(bl);
          if (cm) {
            name = cm[1];
            break;
          }
        }
        deleted.push([t, name]);
        i = j + 1;
        continue;
      }

      const newT = t >= cutEnd ? t - cutLen : t; // past the window -> shift left
      if (newT !== t) shifted += 1;
      let head = block[0].replace(TIME_ATTR, (_m, a, _d, c) => a + String(newT) + c);
      head = head.replace(INDEX_ATTR, (_m, a, _d, c) => a + String(idx) + c);
      idx += 1;
      out.push(head);
      for (let k = 1; k < block.length; k++) out.push(block[k]);
      i = j + 1;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return { text: out.join(eol), deleted, shifted };
}

export interface InsertResult {
  text: string;
  shifted: number;
}

/** Ripple insert — the inverse of rippleCut. Opens a `len`-frame gap at `at`:
 *  every event at or after `at` slides right by `len`. Nothing is deleted, so
 *  indices stay valid; only the `time` attribute changes. Byte-exact otherwise. */
export function rippleInsert(text: string, at: number, len: number): InsertResult {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const out: string[] = [];
  let shifted = 0;
  for (const line of lines) {
    if (EVENT_OPEN.test(line)) {
      const tm = TIME_ATTR.exec(line);
      if (tm) {
        const t = parseInt(tm[2], 10);
        if (t >= at) {
          shifted += 1;
          out.push(line.replace(TIME_ATTR, (_m, a, _d, c) => a + String(t + len) + c));
          continue;
        }
      }
    }
    out.push(line);
  }
  return { text: out.join(eol), shifted };
}
