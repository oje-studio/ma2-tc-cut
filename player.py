"""
Streaming playback engine. Plays decoded PCM through a QAudioSink and mixes a
metronome click into the stream on the fly. Because the click lives in the same
buffer as the music, it is sample-accurate; toggling it is just a flag read in
readData() — instant, with no reload and no stop.
"""
from __future__ import annotations

import array
import math

from PySide6.QtCore import QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices, QAudio


class ClickMixDevice(QIODevice):
    def __init__(self, samples, sr, ch, min_frames=0):
        super().__init__()
        self.samples = samples                   # may be None (pure silence)
        self.sr = sr
        self.ch = ch
        self.audio_total = (len(samples) // ch) if samples is not None else 0
        self.total = max(self.audio_total, int(min_frames))   # play to the longer of show/audio
        self.cursor = 0
        self.metro_on = False
        self.beat = 0.0                           # frames per beat
        self.gain = 1.0                           # software boost for volume > 100%
        self._lut = None                          # clip lookup table, built when gain != 1
        ln = int(sr * 0.04)
        self.click_len = ln

        def mk(freq, amp):
            a = array.array('h')
            for i in range(ln):
                v = int(math.exp(-i / sr * 55) * amp * 32767 * math.sin(2 * math.pi * freq * i / sr))
                a.extend([v] * ch)
            return a
        self._down = mk(2000.0, 0.5)
        self._off = mk(1400.0, 0.35)

    def set_metro(self, on, beat_frames):
        self.metro_on = bool(on)
        self.beat = float(beat_frames)

    def set_gain(self, g):
        """Software gain for the >100% range (QAudioSink only attenuates).
        Precompute a clip lookup table so readData() stays a cheap mapping."""
        g = max(0.0, float(g))
        self.gain = g
        if g == 1.0:
            self._lut = None
            return
        lo, hi = -32768, 32767
        self._lut = array.array('h', (
            lo if int(v * g) < lo else (hi if int(v * g) > hi else int(v * g))
            for v in range(lo, hi + 1)))

    def seek(self, frame):
        self.cursor = max(0, min(self.total, int(frame)))

    def isSequential(self):
        return True

    def bytesAvailable(self):
        return (self.total - self.cursor) * self.ch * 2 + super().bytesAvailable()

    def _add(self, chunk, off, blk, skip=0):
        lim = min(len(blk) - skip, len(chunk) - off)
        for j in range(lim):
            x = chunk[off + j] + blk[skip + j]
            chunk[off + j] = -32768 if x < -32768 else (32767 if x > 32767 else x)

    def readData(self, maxlen):
        if self.cursor >= self.total:
            return bytes()
        nf = max(1, int(maxlen) // (2 * self.ch))
        end = min(self.cursor + nf, self.total)
        if self.samples is not None and self.cursor < self.audio_total:
            aend = min(end, self.audio_total)
            chunk = array.array('h', self.samples[self.cursor * self.ch:aend * self.ch])
            if aend < end:
                chunk.frombytes(bytes(2 * self.ch * (end - aend)))      # pad silence past the audio
        else:
            chunk = array.array('h')
            chunk.frombytes(bytes(2 * self.ch * (end - self.cursor)))   # pure silence
        if self.metro_on and self.beat > 0:
            # a click that began in a previous buffer and spills into this one
            kp = int(self.cursor // self.beat)
            bp = int(round(kp * self.beat))
            if bp < self.cursor and bp + self.click_len > self.cursor:
                self._add(chunk, 0, self._down if kp % 4 == 0 else self._off,
                          skip=(self.cursor - bp) * self.ch)
            # clicks whose onset is inside this buffer
            k = int(math.ceil(self.cursor / self.beat))
            while True:
                bp = int(round(k * self.beat))
                if bp >= end:
                    break
                if bp >= self.cursor:
                    self._add(chunk, (bp - self.cursor) * self.ch,
                              self._down if k % 4 == 0 else self._off)
                k += 1
        if self._lut is not None:                 # boost > 100% (with clipping)
            lut = self._lut
            for i in range(len(chunk)):
                chunk[i] = lut[chunk[i] + 32768]
        self.cursor = end
        return chunk.tobytes()

    def writeData(self, data):
        return 0


class AudioEngine(QObject):
    positionChanged = Signal(int)        # audio frame index (~playhead)
    stateChanged = Signal(bool)          # playing?

    def __init__(self, parent=None):
        super().__init__(parent)
        self.sink = None
        self.dev = None
        self.sr = 44100
        self.ch = 2
        self._playing = False
        self._timer = QTimer(self)
        self._timer.setInterval(33)
        self._timer.timeout.connect(self._tick)

    def load(self, samples, sr, ch, min_frames=0):
        self.stop()
        self.sr, self.ch = sr, ch
        fmt = QAudioFormat()
        fmt.setSampleRate(sr)
        fmt.setChannelCount(ch)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self.dev = ClickMixDevice(samples, sr, ch, min_frames)
        self.dev.open(QIODevice.ReadOnly)
        self.sink = QAudioSink(QMediaDevices.defaultAudioOutput(), fmt)

    def load_silent(self, total_frames, sr=44100, ch=2):
        """A silent stream of `total_frames` — lets Play / metronome / playhead
        run even before any audio file is loaded."""
        self.load(None, sr, ch, total_frames)

    def set_volume(self, g):
        # 0–100% via the sink (hardware, free); >100% boosted in software.
        if self.sink:
            self.sink.setVolume(max(0.0, min(1.0, g)))
        if self.dev:
            self.dev.set_gain(max(1.0, g))

    def set_metro(self, on, beat_frames):
        if self.dev:
            self.dev.set_metro(on, beat_frames)

    def play(self):
        if not self.sink or not self.dev:
            return
        if self.sink.state() == QAudio.State.SuspendedState and self.dev.cursor < self.dev.total:
            self.sink.resume()
        else:
            if self.dev.cursor >= self.dev.total:
                self.dev.seek(0)
            self.sink.stop()
            self.sink.start(self.dev)
        self._playing = True
        self._timer.start()
        self.stateChanged.emit(True)

    def pause(self):
        if self.sink and self._playing:
            self.sink.suspend()
            self._playing = False
            self._timer.stop()
            self.stateChanged.emit(False)

    def toggle(self):
        self.pause() if self._playing else self.play()

    def stop(self):
        if self.sink:
            self.sink.stop()
        self._playing = False
        self._timer.stop()

    def unload(self):
        """Tear the stream down completely (used when the show is closed)."""
        self.stop()
        self.dev = None
        self.sink = None

    def is_playing(self):
        return self._playing

    def seek(self, frame):
        if self.dev:
            self.dev.seek(frame)
            self.positionChanged.emit(self.dev.cursor)

    def position(self):
        return self.dev.cursor if self.dev else 0

    def _tick(self):
        if not self.dev:
            return
        # cursor is what's been read into the output buffer; subtract the buffer
        # fill so the playhead matches what's actually being heard.
        lead = 0
        if self.sink:
            try:
                lead = self.sink.bufferSize() // (self.ch * 2)
            except Exception:
                lead = 0
        self.positionChanged.emit(max(0, self.dev.cursor - lead))
        if self.dev.cursor >= self.dev.total:
            self.pause()
