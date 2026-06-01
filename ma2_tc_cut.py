#!/usr/bin/env python3
"""
MA2 timecode ripple-cut: removes the window [cut_in; cut_out) from a grandMA2
timecode show and slides every later event left (like "cut time" in Ableton).

`time` in the XML is a FRAME NUMBER at the show's frame_format (e.g. 30 FPS),
NOT milliseconds. The fps is read from the file automatically (the
<Timecode frame_format="..."> tag).

No external dependencies — standard library only. Runs on any Python 3,
including a show laptop / MA onPC machine without pip or a compiler.

It edits ONLY the <Event ...> lines (the index/time attributes) and removes the
cut <Event>...</Event> blocks whole. Everything else — BOM, declaration,
stylesheet, namespace, schemaLocation, indentation (tabs), line endings, and the
absence of a trailing newline — is preserved BYTE-FOR-BYTE so the MA2 import
doesn't choke.

IMPORTANT (musical correctness): a timecode cut is only correct if it mirrors the
audio edit — same in-point, same length. Give the length in WHOLE bars/beats, not
round seconds: "14.000 s" is almost never a whole number of bars, and then
everything after the cut drifts off the beat. Put the in-point on a downbeat. For
frame accuracy use --cut-out (no second-rounding).
"""
import argparse
import re
import sys

EVENT_OPEN = re.compile(r'<Event\b')
SUBTRACK   = re.compile(r'<SubTrack\b')
TIME_ATTR  = re.compile(r'(\btime=")(\d+)(")')
INDEX_ATTR = re.compile(r'(\bindex=")(\d+)(")')
FRAME_FMT  = re.compile(r'frame_format="[^"]*?(\d+)')
CUE_NAME   = re.compile(r'<Cue\b[^>]*\bname="([^"]*)"')


def tc_to_frames(tc, fps):
    """'HH:MM:SS:FF' -> absolute frame number. Accepts short forms (SS:FF etc.)."""
    parts = [int(p) for p in str(tc).split(':')]
    while len(parts) < 4:
        parts = [0] + parts
    h, m, s, f = parts
    return ((h * 3600 + m * 60 + s) * fps) + f


def frames_to_tc(fr, fps):
    s, f = divmod(int(fr), fps)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def ripple_cut(text, cut_in, cut_len):
    """Return (new_text, deleted, shifted). `text` is without BOM. Line endings preserved."""
    eol = '\r\n' if '\r\n' in text else '\n'
    lines = text.split(eol)
    n = len(lines)
    cut_end = cut_in + cut_len

    out, deleted, shifted = [], [], 0
    idx = 0          # index counter within the current SubTrack
    i = 0
    while i < n:
        line = lines[i]

        if SUBTRACK.search(line):
            idx = 0
            out.append(line); i += 1; continue

        if EVENT_OPEN.search(line):
            block = [line]
            j = i
            single = ('</Event>' in line) or (re.search(r'/>\s*$', line) is not None)
            if not single:
                j = i + 1
                while j < n:
                    block.append(lines[j])
                    if '</Event>' in lines[j]:
                        break
                    j += 1
            t = int(TIME_ATTR.search(line).group(2))

            if cut_in <= t < cut_end:                    # inside the cut -> delete
                name = '?'
                for bl in block:
                    cm = CUE_NAME.search(bl)
                    if cm:
                        name = cm.group(1); break
                deleted.append((t, name))
                i = j + 1
                continue

            new_t = t - cut_len if t >= cut_end else t   # past the window -> shift left
            if new_t != t:
                shifted += 1
            head = TIME_ATTR.sub(lambda z: z.group(1) + str(new_t) + z.group(3), block[0], count=1)
            head = INDEX_ATTR.sub(lambda z: z.group(1) + str(idx) + z.group(3), head, count=1)
            idx += 1
            out.append(head)
            out.extend(block[1:])
            i = j + 1
            continue

        out.append(line); i += 1

    return eol.join(out), deleted, shifted


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')   # so non-ASCII cue names don't crash the Windows console
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        description='Ripple-cut a window out of a grandMA2 timecode show (byte-exact XML).')
    ap.add_argument('infile')
    ap.add_argument('outfile')
    ap.add_argument('--cut-in', required=True,
                    help='start of the cut, absolute TC HH:MM:SS:FF')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--cut-out',
                   help='end of the cut, absolute TC HH:MM:SS:FF (frame-accurate, no rounding)')
    g.add_argument('--dur', type=float,
                   help='cut length in seconds (rounded to frames). Default 30')
    args = ap.parse_args()

    raw = open(args.infile, 'rb').read()
    bom = b'\xef\xbb\xbf'
    has_bom = raw.startswith(bom)
    text = (raw[len(bom):] if has_bom else raw).decode('utf-8')

    m = FRAME_FMT.search(text)
    if not m:
        sys.exit('frame_format not found — is this really a grandMA2 timecode show?')
    fps = int(m.group(1))

    cut_in = tc_to_frames(args.cut_in, fps)
    if args.cut_out is not None:
        cut_out = tc_to_frames(args.cut_out, fps)
        if cut_out <= cut_in:
            sys.exit(f'--cut-out ({args.cut_out}) must be later than --cut-in ({args.cut_in})')
        cut_len = cut_out - cut_in
        dur_s = cut_len / fps
    else:
        dur_s = args.dur if args.dur is not None else 30.0
        cut_len = round(dur_s * fps)

    new_text, deleted, shifted = ripple_cut(text, cut_in, cut_len)
    open(args.outfile, 'wb').write((bom if has_bom else b'') + new_text.encode('utf-8'))

    cut_end = cut_in + cut_len
    print(f"fps={fps}  cut {frames_to_tc(cut_in, fps)} .. {frames_to_tc(cut_end, fps)}"
          f"  ({cut_len} frames / {dur_s:.3f}s)")
    print(f"deleted events in window: {len(deleted)}   shifted left: {shifted}")
    for t, nm in sorted(deleted):
        print(f"  DEL {frames_to_tc(t, fps)}  {nm}")


if __name__ == '__main__':
    main()
