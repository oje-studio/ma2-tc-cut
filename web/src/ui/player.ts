// Web Audio playback engine + sample-accurate metronome.
//
// The desktop app mixed clicks into the PCM stream. In the browser we instead
// schedule click buffers ahead of time against AudioContext.currentTime — the
// "two clocks" pattern: a coarse setInterval loop schedules clicks at exact
// audio-clock times, so the clicks themselves are sample-accurate and drift-free.
// Toggling the metronome just flips a flag (≤ one lookahead window of latency).
//
// Volume > 100% is free here: a GainNode amplifies (the desktop needed a manual
// software stage because QAudioSink only attenuates).

const LOOKAHEAD_MS = 25; // scheduler wakeup interval
const SCHEDULE_AHEAD = 0.1; // seconds of clicks to queue ahead
const CLICK_LEN = 0.04; // seconds

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private clickDown: AudioBuffer | null = null;
  private clickOff: AudioBuffer | null = null;

  private showFirst = 0;
  private showLast = 1;
  private fps = 30;
  private totalSec = 1;
  private audioSec = 0;

  private playing = false;
  private positionSec = 0; // playback position, 0 = show start (showFirst)
  private startCtx = 0; // ctx time corresponding to positionSec = 0
  private volume = 1;

  private metroOn = false;
  private beatFrames = 0;
  private anchorFrame = 0;
  private nextBeatK = 0;
  private timer: number | null = null;

  onState: (playing: boolean) => void = () => {};

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.clickDown = this.makeClick(2000, 0.5);
      this.clickOff = this.makeClick(1400, 0.35);
    }
    return this.ctx;
  }

  private makeClick(freq: number, amp: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * CLICK_LEN);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      d[i] = Math.exp((-i / sr) * 55) * amp * Math.sin((2 * Math.PI * freq * i) / sr);
    }
    return buf;
  }

  /** Resume the AudioContext (must be called from a user gesture the first time). */
  async unlock(): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
  }

  setShow(firstFrame: number, lastFrame: number, fps: number): void {
    this.showFirst = firstFrame;
    this.showLast = Math.max(lastFrame, firstFrame + 1);
    this.fps = Math.max(1, fps);
    this.recalcTotal();
  }

  setAudio(buffer: AudioBuffer): void {
    // No ensureCtx() here — the real AudioContext is created on the first user
    // gesture (play). Decoding happens on an OfflineAudioContext, so a buffer
    // can be loaded before any gesture without a muted/blocked context.
    this.buffer = buffer;
    this.audioSec = buffer.duration;
    this.recalcTotal();
  }

  clearAudio(): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.buffer = null;
    this.audioSec = 0;
    this.recalcTotal();
    this.positionSec = Math.min(this.positionSec, this.totalSec);
  }

  hasAudio(): boolean {
    return this.buffer !== null;
  }

  private recalcTotal(): void {
    const showSec = (this.showLast - this.showFirst) / this.fps;
    this.totalSec = Math.max(showSec, this.audioSec, 0.001);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, v);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
    }
  }

  setMetro(on: boolean, beatFrames: number, anchorFrame: number): void {
    this.metroOn = on && beatFrames > 0;
    this.beatFrames = beatFrames;
    this.anchorFrame = anchorFrame;
    if (this.playing) this.resetBeatCursor();
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Current playhead as a show frame. While playing, shift back by the output
   *  latency so the playhead matches what's actually heard (clicks/audio land
   *  on the playhead instead of trailing it). */
  positionFrame(): number {
    let sec = this.positionSec;
    if (this.playing && this.ctx) {
      sec = this.ctx.currentTime - this.startCtx - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    }
    const clamped = Math.max(0, Math.min(this.totalSec, sec));
    return this.showFirst + clamped * this.fps;
  }

  seekFrame(frame: number): void {
    const sec = Math.max(0, Math.min(this.totalSec, (frame - this.showFirst) / this.fps));
    this.positionSec = sec;
    if (this.playing) {
      this.stopSource();
      this.startCtx = this.ctx!.currentTime - sec;
      this.startSource(sec);
      this.resetBeatCursor();
    }
  }

  async play(): Promise<void> {
    if (this.playing) return;
    await this.unlock();
    const ctx = this.ctx!;
    if (this.positionSec >= this.totalSec) this.positionSec = 0;
    this.startCtx = ctx.currentTime - this.positionSec;
    this.startSource(this.positionSec);
    this.playing = true;
    this.resetBeatCursor();
    this.timer = window.setInterval(() => this.tick(), LOOKAHEAD_MS);
    this.onState(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.positionSec = Math.max(0, Math.min(this.totalSec, this.ctx!.currentTime - this.startCtx));
    this.stopSource();
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.playing = false;
    this.onState(false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  private startSource(offsetSec: number): void {
    if (!this.buffer || !this.ctx || !this.master) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.master);
    const off = Math.max(0, Math.min(this.buffer.duration, offsetSec));
    if (off < this.buffer.duration) src.start(this.ctx.currentTime, off);
    this.source = src;
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  private resetBeatCursor(): void {
    if (!this.metroOn || this.beatFrames <= 0) return;
    const curFrame = this.positionFrame();
    const k = Math.ceil((curFrame - this.anchorFrame) / this.beatFrames);
    this.nextBeatK = Math.max(0, k);
  }

  private tick(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    // metronome: schedule any beats landing in the lookahead window
    if (this.metroOn && this.beatFrames > 0) {
      const horizon = now + SCHEDULE_AHEAD;
      const endFrame = this.showFirst + this.totalSec * this.fps; // metronome runs to the end of playback (audio), not just the show
      // guard against runaway loops on bad input
      for (let guard = 0; guard < 256; guard++) {
        const beatFrame = this.anchorFrame + this.nextBeatK * this.beatFrames;
        const beatSec = (beatFrame - this.showFirst) / this.fps;
        const when = this.startCtx + beatSec;
        if (when >= horizon) break;
        if (beatFrame > endFrame + this.beatFrames) break;
        if (when >= now - 0.05) this.scheduleClick(when, this.nextBeatK % 4 === 0);
        this.nextBeatK += 1;
      }
    }

    // stop at the end
    if (now - this.startCtx >= this.totalSec) {
      this.pause();
      this.positionSec = 0;
    }
  }

  private scheduleClick(when: number, down: boolean): void {
    if (!this.ctx || !this.master) return;
    const src = this.ctx.createBufferSource();
    src.buffer = down ? this.clickDown : this.clickOff;
    src.connect(this.master);
    src.start(Math.max(when, this.ctx.currentTime));
  }
}
