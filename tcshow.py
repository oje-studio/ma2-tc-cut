#!/usr/bin/env python3
"""
Read-only analysis helpers for grandMA2 timecode XML — standard library only,
no Qt. Used by the GUI for the info panel and the tempo estimate, and handy on
its own.
"""
import re

FRAME_FMT = re.compile(r'frame_format="[^"]*?(\d+)')
TC_NAME   = re.compile(r'<Timecode\b[^>]*\bname="([^"]*)"')
SUBTRACK  = re.compile(r'<SubTrack\b')
EVENT     = re.compile(r'<Event\b[^>]*\btime="(\d+)"')
OBJ_NAME  = re.compile(r'<Object\b[^>]*\bname="([^"]*)"')
CUE_NAME  = re.compile(r'<Cue\b[^>]*\bname="([^"]*)"')


def read_show(path):
    """Return (has_bom, text). Text is decoded without the BOM."""
    raw = open(path, 'rb').read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    return bom, (raw[3:] if bom else raw).decode('utf-8')


def get_fps(text):
    m = FRAME_FMT.search(text)
    if not m:
        raise ValueError('frame_format not found — is this a grandMA2 timecode XML?')
    return int(m.group(1))


def frames_to_tc(fr, fps):
    s, f = divmod(int(fr), fps)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def events_by_subtrack(text):
    """List per subtrack: [(subtrack_index, [frame, ...]), ...] in document order."""
    eol = '\r\n' if '\r\n' in text else '\n'
    result, cur = [], None
    for line in text.split(eol):
        if SUBTRACK.search(line):
            cur = []
            result.append(cur)
        elif cur is not None:
            m = EVENT.search(line)
            if m:
                cur.append(int(m.group(1)))
    return result


def summary(text):
    """Quick facts for the info panel."""
    fps = get_fps(text)
    subs = events_by_subtrack(text)
    times = [t for s in subs for t in s]
    nm = TC_NAME.search(text)
    first, last = (min(times), max(times)) if times else (0, 0)
    return {
        'fps': fps,
        'name': nm.group(1) if nm else '(unnamed)',
        'n_events': len(times),
        'n_subtracks': len(subs),
        'first_frame': first,
        'last_frame': last,
        'first_tc': frames_to_tc(first, fps),
        'last_tc': frames_to_tc(last, fps),
    }


def estimate_beat(text):
    """
    Rough tempo estimate from the cue grid: look at moments where >=3 subtracks
    fire together (almost always downbeats), and find the frame length that best
    divides the gaps between them. Returns (beat_frames, bpm) or None.

    Heuristic — meant as a hint. Always let the user override with the real BPM.
    """
    fps = get_fps(text)
    subs = events_by_subtrack(text)
    hits = {}
    for si, times in enumerate(subs):
        for t in times:
            hits.setdefault(t, set()).add(si)
    struct = sorted(t for t, s in hits.items() if len(s) >= 3)
    gaps = [b - a for a, b in zip(struct, struct[1:])]
    gaps = [g for g in gaps if 10 <= g <= 700]      # drop sub-beat chases and long sections
    if len(gaps) < 3:
        return None
    best_b, best_err = None, 1e9
    b = 10.0
    while b <= 40.0:                                  # ~45..180 BPM at 30fps
        err = 0.0
        for g in gaps:
            r = g % b
            err += min(r, b - r) / b
        err /= len(gaps)
        if err < best_err:
            best_err, best_b = err, b
        b += 0.1
    if best_b is None or best_err > 0.18:             # too noisy -> no confident grid
        return None
    # Octave correction: the minimizer is biased toward small divisors (an eighth
    # fits as well as the quarter). Fold the implied tempo into a musical range so
    # we report the felt beat, not a harmonic of it.
    bpm = fps * 60.0 / best_b
    while bpm >= 140.0:
        bpm /= 2.0
    while bpm < 70.0:
        bpm *= 2.0
    return fps * 60.0 / bpm, bpm


def lanes(text):
    """
    Per-subtrack lanes for the timeline:
    [{'name': <object/track label>, 'events': [(frame, cue_name), ...]}, ...]
    """
    eol = '\r\n' if '\r\n' in text else '\n'
    out, cur, pending, obj = [], None, None, None
    for line in text.split(eol):
        mo = OBJ_NAME.search(line)
        if mo:
            obj = mo.group(1)
            continue
        if SUBTRACK.search(line):
            cur = {'name': obj or f'Track {len(out) + 1}', 'events': []}
            out.append(cur)
            obj, pending = None, None
            continue
        if cur is None:
            continue
        me = EVENT.search(line)
        if me:
            pending = int(me.group(1))
            continue
        mc = CUE_NAME.search(line)
        if mc and pending is not None:
            cur['events'].append((pending, mc.group(1)))
            pending = None
    return out
