"""
Audio → waveform peaks for the timeline.

Uses miniaudio when available (wav / mp3 / flac / ogg, no system ffmpeg needed);
falls back to the stdlib `wave` module for .wav only. Returns a list of peak
amplitudes (0..1), one per bucket, plus the clip duration in seconds.
"""
from __future__ import annotations

import array
import math
import wave


def _bucket_peaks(samples, n_buckets, full_scale):
    """Max |sample| per bucket, normalised to 0..1. `samples` is mono int."""
    n = len(samples)
    if n == 0:
        return []
    buckets = max(1, min(n_buckets, n))
    out = []
    for i in range(buckets):
        a = i * n // buckets
        b = (i + 1) * n // buckets
        seg = samples[a:b]
        if seg:
            peak = max(abs(min(seg)), abs(max(seg)))     # min()/max() run in C
            out.append(min(1.0, peak / full_scale))
        else:
            out.append(0.0)
    return out


def _via_miniaudio(path, n_buckets):
    import miniaudio
    dec = miniaudio.decode_file(
        path,
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=1,
        sample_rate=8000,          # plenty for a display waveform; keeps it fast
    )
    duration = dec.num_frames / dec.sample_rate if dec.sample_rate else 0.0
    return _bucket_peaks(dec.samples, n_buckets, 32768.0), duration


def _via_wave(path, n_buckets):
    import wave
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        nf = w.getnframes()
        raw = w.readframes(nf)
    duration = nf / sr if sr else 0.0
    if sw == 2:
        a = array.array('h')
        a.frombytes(raw)
        mono = a[0::ch] if ch > 1 else a
        return _bucket_peaks(mono, n_buckets, 32768.0), duration
    if sw == 1:                                          # 8-bit PCM is unsigned
        a = array.array('B')
        a.frombytes(raw)
        mono = a[0::ch] if ch > 1 else a
        centred = array.array('h', (s - 128 for s in mono))
        return _bucket_peaks(centred, n_buckets, 128.0), duration
    raise ValueError(f"Unsupported WAV sample width ({sw * 8}-bit). Use 16-bit, or install miniaudio.")


def load_waveform(path, n_buckets=2000):
    """Return (peaks: list[float] 0..1, duration_seconds: float)."""
    try:
        return _via_miniaudio(path, n_buckets)
    except ImportError:
        pass
    except Exception:
        # miniaudio present but couldn't decode this file — try wave below.
        pass
    if path.lower().endswith(".wav"):
        return _via_wave(path, n_buckets)
    raise ValueError(
        "Couldn't decode this audio. Install the optional 'miniaudio' package "
        "for mp3/flac/ogg, or load a .wav file."
    )


# ── full-quality decode + click-track mixing (for the sample-accurate metronome) ──
def decode(path):
    """Return (samples: array('h') interleaved, sample_rate, nchannels), full quality."""
    try:
        import miniaudio
        dec = miniaudio.decode_file(path, output_format=miniaudio.SampleFormat.SIGNED16)
        return dec.samples, dec.sample_rate, dec.nchannels
    except ImportError:
        pass
    if path.lower().endswith(".wav"):
        with wave.open(path, 'rb') as w:
            sr, ch, sw, nf = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
            raw = w.readframes(nf)
        if sw == 2:
            a = array.array('h'); a.frombytes(raw); return a, sr, ch
        if sw == 1:
            b = array.array('B'); b.frombytes(raw)
            return array.array('h', ((s - 128) * 256 for s in b)), sr, ch
        raise ValueError(f"Unsupported WAV sample width ({sw * 8}-bit).")
    raise ValueError("Couldn't decode audio. Install 'miniaudio' for mp3/flac/ogg, or use a .wav.")


def peaks_from(samples, ch, n_buckets=2000):
    mono = samples[0::ch] if ch > 1 else samples
    return _bucket_peaks(mono, n_buckets, 32768.0)


def write_click_mix(out_path, samples, sr, ch, bpm, click_gain=0.5):
    """
    Write `samples` with metronome clicks summed in at every beat (anchored at
    sample 0 = bar 1, downbeat accented). Sample-accurate by construction.
    """
    beat = sr * 60.0 / bpm
    out = array.array('h', samples)        # copy (C-speed)
    nframes = len(samples) // ch
    click_len = int(sr * 0.04)
    # precompute click waveforms, already interleaved for `ch` channels
    def make(freq, amp):
        a = array.array('h')
        for i in range(click_len):
            v = int(math.exp(-i / sr * 55) * amp * 32767 * math.sin(2 * math.pi * freq * i / sr))
            for _c in range(ch):
                a.append(v)
        return a
    down = make(2000.0, click_gain)
    off = make(1400.0, click_gain * 0.7)
    blen = click_len * ch
    k = 0
    while True:
        sf = int(round(k * beat))
        if sf >= nframes:
            break
        blk = down if (k % 4 == 0) else off
        base = sf * ch
        end = min(blen, len(out) - base)
        for j in range(end):                # one flat loop over the (short) click region
            x = out[base + j] + blk[j]
            out[base + j] = -32768 if x < -32768 else (32767 if x > 32767 else x)
        k += 1
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr); w.writeframes(out.tobytes())
