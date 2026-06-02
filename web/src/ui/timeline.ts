// Canvas timeline — port of timeline.py (TimelineWidget).
// Cue lanes, BPM bar grid, TC ruler, draggable ripple-cut window, waveform band,
// eject glyphs and the moving playhead. Mouse-driven, same interaction model.
import * as t from "../theme.ts";
import type { Lane } from "../core/tcshow.ts";

const LBL_W = 134;
const AXIS_H = 30;
const PAD_R = 14;
const LANE_MIN = 30;
const AUDIO_H = 54;
const BARS_H = 18;
const HANDLE_H = 11;
const SCROLL_H = 11; // bottom scrollbar lane (shown when zoomed)

type Zone = "left" | "right" | "move" | null;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function tc(fr: number, fps: number): string {
  let s = Math.floor(fr / fps);
  const f = Math.round(fr) - s * fps;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad2(f)}`;
}

function blend(c1: string, c2: string, k: number): string {
  const a = c1.replace("#", "");
  const b = c2.replace("#", "");
  const ch = (i: number): number => {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    return Math.round(x + (y - x) * k);
  };
  return `rgb(${ch(0)}, ${ch(2)}, ${ch(4)})`;
}

export class Timeline {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cssW = 800;
  private cssH = 260;

  fps = 30;
  first = 0;
  last = 1; // effective right edge = max(showLast, audio end) so nothing clips
  private showLast = 1;
  lanes: Lane[] = [];
  cutIn: number | null = null;
  cutOut: number | null = null;
  audioPeaks: Float32Array | null = null;
  audioDur = 0;
  gain = 1;
  bpm = 0;
  anchor = 0;
  snapMode: "off" | "bar" | "beat" | "second" = "off";
  playhead: number | null = null;
  showName = "";
  audioName = "";

  private viewStart = 0; // visible frame range (zoom + pan); equals [first,last] when fit
  private viewEnd = 1;
  private mode: "cut" | "insert" = "cut"; // colours the window red (cut) or green (insert)
  private fillH = 0; // target height from the container (fills vertical space)
  private uiScale = 1; // canvas text scale on big screens
  private audioTop: number | null = null;
  private dragMode: Zone = null;
  private winDrag = 0;
  private ejectShow: [number, number, number, number] | null = null;
  private ejectAudio: [number, number, number, number] | null = null;
  private hoverEject: "show" | "audio" | null = null;
  private scrubbing = false;
  private flash = new Map<number, number>(); // laneIndex -> brightness 0..1
  private prevPlayhead: number | null = null;
  private flashRaf = 0;
  private scrollThumb: [number, number, number, number] | null = null;
  private scrolling = false;
  private scrollGrab = 0;

  onSeek: (frame: number) => void = () => {};
  onShowRequest: () => void = () => {};
  onAudioRequest: () => void = () => {};
  onEjectShow: () => void = () => {};
  onEjectAudio: () => void = () => {};
  onFilesDropped: (files: File[]) => void = () => {};
  onCutDragged: (a: number, b: number) => void = () => {};
  onZoom: (factor: number) => void = () => {}; // factor = full / visible span (1 = fit)

  constructor() {
    const c = document.createElement("canvas");
    c.className = "timeline";
    this.ctx = c.getContext("2d")!;
    this.el = c;
    this.bindMouse();
    this.bindDrop();
  }

  // ---------- data ----------
  /** Effective right edge spans the longer of the show and the audio. */
  private applyRange(): void {
    const audioEnd = this.audioDur > 0 ? Math.round(this.first + this.audioDur * this.fps) : this.first;
    this.last = Math.max(this.showLast, audioEnd, this.first + 1);
    this.viewStart = this.first; // reset zoom-to-fit when the data range changes
    this.viewEnd = this.last;
    this.onZoom(1);
  }
  setShow(fps: number, lanes: Lane[], first: number, last: number, name = ""): void {
    this.fps = Math.max(1, fps);
    this.lanes = lanes || [];
    this.first = first;
    this.showLast = Math.max(last, first + 1);
    this.anchor = first;
    if (name) this.showName = name;
    this.cutIn = this.cutOut = this.playhead = this.prevPlayhead = null;
    this.flash.clear();
    this.applyRange();
    this.relayout();
  }
  setCut(a: number | null, b: number | null): void {
    this.cutIn = a;
    this.cutOut = b;
    this.draw();
  }
  setMode(mode: "cut" | "insert"): void {
    this.mode = mode;
    this.draw();
  }
  setAudio(peaks: Float32Array, durationS: number, name = ""): void {
    this.audioPeaks = peaks;
    this.audioDur = durationS;
    if (name) this.audioName = name;
    this.applyRange();
    this.draw();
  }
  clearAudio(): void {
    this.audioPeaks = null;
    this.audioDur = 0;
    this.audioName = "";
    this.playhead = null;
    this.applyRange();
    this.draw();
  }
  reset(): void {
    this.lanes = [];
    this.audioPeaks = null;
    this.audioDur = 0;
    this.audioName = "";
    this.showName = "";
    this.bpm = 0;
    this.showLast = this.last = 1;
    this.cutIn = this.cutOut = this.playhead = this.prevPlayhead = null;
    this.flash.clear();
    this.ejectShow = this.ejectAudio = this.hoverEject = null;
    this.relayout();
  }
  setGrid(bpm: number, anchor?: number): void {
    this.bpm = bpm || 0;
    if (anchor !== undefined) this.anchor = anchor;
    this.relayout();
  }
  setSnap(mode: "off" | "bar" | "beat" | "second"): void {
    this.snapMode = mode;
  }
  setGain(g: number): void {
    this.gain = Math.max(0, g);
    this.draw();
  }
  setPlayhead(frame: number | null): void {
    const prev = this.prevPlayhead;
    this.prevPlayhead = frame;
    // when the playhead sweeps forward over a cue, flash that lane's label + ticks
    if (prev !== null && frame !== null && frame > prev && frame - prev <= 1.5 * this.fps) {
      this.lanes.forEach((lane, i) => {
        if (lane.events.some(([f]) => prev < f && f <= frame)) this.flash.set(i, 1.0);
      });
      this.ensureFlashLoop();
    }
    this.playhead = frame;
    this.draw();
  }

  private ensureFlashLoop(): void {
    if (this.flashRaf || this.flash.size === 0) return;
    const tick = (): void => {
      let any = false;
      for (const [k, v] of this.flash) {
        const nv = v - 0.08;
        if (nv <= 0) this.flash.delete(k);
        else {
          this.flash.set(k, nv);
          any = true;
        }
      }
      this.draw();
      this.flashRaf = any ? requestAnimationFrame(tick) : 0;
    };
    this.flashRaf = requestAnimationFrame(tick);
  }

  // ---------- layout / sizing ----------
  contentHeight(): number {
    const n = Math.max(1, this.lanes.length);
    const extra = (this.lanes.length ? AUDIO_H + SCROLL_H : 0) + (this.barFrames() > 0 ? BARS_H : 0);
    return Math.max(220, AXIS_H + n * LANE_MIN + 14 + extra);
  }
  relayout(): void {
    // fill the container vertically (taller lanes on big screens), floored at the minimum
    this.cssH = Math.max(this.contentHeight(), this.fillH);
    // scale canvas text up on large timelines so it stays readable
    this.uiScale = Math.max(1, Math.min(1.5, this.cssW / 1500));
    this.resizeCanvas();
    this.draw();
  }
  setSize(cssW: number, cssH: number): void {
    this.cssW = Math.max(320, cssW);
    this.fillH = Math.max(0, cssH);
    this.relayout();
  }
  setWidth(cssW: number): void {
    this.setSize(cssW, this.fillH);
  }
  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.el.width = Math.round(this.cssW * dpr);
    this.el.height = Math.round(this.cssH * dpr);
    this.el.style.width = `${this.cssW}px`;
    this.el.style.height = `${this.cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- mapping ----------
  private plotW(): number {
    return Math.max(1, this.cssW - LBL_W - PAD_R);
  }
  private x(frame: number): number {
    return LBL_W + ((frame - this.viewStart) / (this.viewEnd - this.viewStart)) * this.plotW();
  }
  private frameAt(px: number): number {
    const xx = Math.min(Math.max(px, LBL_W), LBL_W + this.plotW());
    return Math.round(this.viewStart + ((xx - LBL_W) / this.plotW()) * (this.viewEnd - this.viewStart));
  }
  // ---------- zoom / pan ----------
  private viewSpan(): number {
    return Math.max(1, this.viewEnd - this.viewStart);
  }
  private minSpan(): number {
    return Math.max(this.fps, Math.round((this.last - this.first) / 400));
  }
  setView(start: number, end: number): void {
    const full = this.last - this.first;
    const span = Math.min(Math.max(end - start, this.minSpan()), full);
    const s = Math.min(Math.max(start, this.first), this.last - span);
    this.viewStart = Math.round(s);
    this.viewEnd = Math.round(s + span);
    this.onZoom(full / span);
    this.draw();
  }
  zoomAtFrame(centerFrame: number, factor: number): void {
    const span = this.viewSpan();
    const ratio = (centerFrame - this.viewStart) / span;
    const newSpan = span * factor;
    this.setView(centerFrame - ratio * newSpan, centerFrame - ratio * newSpan + newSpan);
  }
  zoomBy(factor: number): void {
    // zoom around the playhead when it's set, otherwise the view centre
    const center =
      this.playhead !== null && this.playhead >= this.first && this.playhead <= this.last
        ? this.playhead
        : (this.viewStart + this.viewEnd) / 2;
    this.zoomAtFrame(center, factor);
  }
  panByFrames(df: number): void {
    this.setView(this.viewStart + df, this.viewEnd + df);
  }
  zoomFit(): void {
    this.viewStart = this.first;
    this.viewEnd = this.last;
    this.onZoom(1);
    this.draw();
  }
  private scrollTo(pointerX: number): void {
    const full = this.last - this.first;
    const left = LBL_W;
    const trackW = this.cssW - PAD_R - left;
    const span = this.viewSpan();
    const frac = (pointerX - this.scrollGrab - left) / trackW;
    const start = this.first + frac * full;
    this.setView(start, start + span);
  }
  private barFrames(): number {
    return this.bpm > 0 ? (this.fps * 240) / this.bpm : 0;
  }
  private snap(frame: number): number {
    let step = 0;
    if (this.snapMode === "bar") step = this.barFrames();
    else if (this.snapMode === "beat") step = this.barFrames() / 4;
    else if (this.snapMode === "second") step = this.fps;
    if (step <= 0) return frame;
    return this.anchor + Math.round((frame - this.anchor) / step) * step;
  }
  private window(): [number, number] | null {
    if (this.cutIn !== null && this.cutOut !== null && this.cutOut > this.cutIn) {
      return [this.cutIn, this.cutOut];
    }
    return null;
  }
  /** Canvas font string, scaled up on large timelines for readability. */
  private font(px: number, mono = false, weight = ""): string {
    const w = weight ? `${weight} ` : "";
    return `${w}${Math.round(px * this.uiScale)}px ${mono ? t.FONT_MONO : t.FONT_SANS}`;
  }

  // ---------- drawing ----------
  draw(): void {
    const p = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    p.fillStyle = t.BG_SURFACE;
    p.fillRect(0, 0, W, H);
    p.strokeStyle = t.BORDER_SUBTLE;
    p.lineWidth = 1;
    p.strokeRect(0.5, 0.5, W - 1, H - 1);

    this.ejectShow = this.ejectAudio = null;
    if (this.lanes.length === 0) {
      this.audioTop = null;
      p.fillStyle = t.TEXT_MUTED;
      p.font = this.font(13);
      p.textAlign = "center";
      p.textBaseline = "middle";
      p.fillText("Click or drop a grandMA2 timecode .xml here", W / 2, H / 2);
      p.textAlign = "left";
      return;
    }

    const bf = this.barFrames();
    // waveform grows a little on a tall timeline so it stays readable
    const audioH = Math.round(Math.min(150, Math.max(AUDIO_H, (H - AXIS_H) * 0.16)));
    const barsH = bf > 0 ? Math.round(BARS_H * this.uiScale) : 0;
    const lanesBottom = H - 4 - audioH - barsH - SCROLL_H;
    const gridBottom = lanesBottom + barsH;
    this.audioTop = gridBottom;
    const n = this.lanes.length;
    const laneH = (lanesBottom - AXIS_H) / n;
    const win = this.window();

    // cut window fills
    if (win) {
      const xa = Math.max(LBL_W, Math.min(this.x(win[0]), W - PAD_R));
      const xb = Math.max(LBL_W, Math.min(this.x(win[1]), W - PAD_R));
      if (this.mode === "insert") {
        p.fillStyle = t.withAlpha(t.SEMANTIC_SUCCESS, 0.18); // a gap to open
        p.fillRect(xa, AXIS_H, xb - xa, gridBottom - AXIS_H);
      } else {
        p.fillStyle = t.withAlpha(t.SEMANTIC_INFO, 0.06);
        p.fillRect(xb, AXIS_H, W - PAD_R - xb, gridBottom - AXIS_H);
        p.fillStyle = t.withAlpha(t.SEMANTIC_DANGER, 0.16);
        p.fillRect(xa, AXIS_H, xb - xa, gridBottom - AXIS_H);
      }
    }

    if (bf > 0) this.drawGridLines(p, gridBottom, bf);
    this.drawTcRuler(p, W, gridBottom, bf <= 0);

    // CUES gutter
    p.textBaseline = "alphabetic";
    p.font = this.font(12);
    p.fillStyle = t.OPERATOR_LIGHTING;
    p.fillText("CUES", 10, 15);
    if (this.showName) {
      this.ejectShow = this.drawEject(p, LBL_W - 13, 10, this.hoverEject === "show");
      p.font = this.font(10);
      p.fillStyle = t.TEXT_MUTED;
      p.fillText(this.elide(p, this.showName, LBL_W - 16, "middle"), 10, 28);
    }

    // cue lanes
    for (let i = 0; i < n; i++) {
      const y0 = AXIS_H + i * laneH;
      const yc = y0 + laneH / 2;
      if (i > 0) {
        p.strokeStyle = t.BORDER_SUBTLE;
        p.beginPath();
        p.moveTo(LBL_W, y0);
        p.lineTo(W - PAD_R, y0);
        p.stroke();
      }
      const fl = this.flash.get(i) ?? 0;
      p.font = this.font(12, false, fl > 0.4 ? "600" : "");
      p.fillStyle = fl > 0 ? blend(t.TEXT_MUTED, t.TEXT_BRIGHT, fl) : t.TEXT_MUTED;
      p.textBaseline = "middle";
      p.fillText(this.elide(p, this.lanes[i].name, LBL_W - 16, "end"), 10, yc);
      p.textBaseline = "alphabetic";
      const th = Math.max(6, laneH * 0.46);
      const lit = fl > 0 ? blend(t.OPERATOR_LIGHTING, t.TEXT_BRIGHT, fl) : t.OPERATOR_LIGHTING;
      for (const [fr] of this.lanes[i].events) {
        const xx = this.x(fr);
        if (xx < LBL_W || xx > W - PAD_R) continue;
        const inside = win && win[0] <= fr && fr < win[1];
        p.strokeStyle = inside && this.mode === "cut" ? t.SEMANTIC_DANGER : lit;
        p.lineWidth = 2;
        p.beginPath();
        p.moveTo(xx, yc - th / 2);
        p.lineTo(xx, yc + th / 2);
        p.stroke();
      }
    }
    p.lineWidth = 1;

    if (barsH) this.drawBarsRuler(p, W, lanesBottom, barsH, bf);
    this.drawAudioBand(p, W, gridBottom, audioH, win);
    if (win) this.drawCutLabels(p, win, lanesBottom);

    // playhead
    if (this.playhead !== null && this.playhead >= this.viewStart && this.playhead <= this.viewEnd) {
      const xx = this.x(this.playhead);
      p.strokeStyle = t.TEXT_BRIGHT;
      p.beginPath();
      p.moveTo(xx, AXIS_H);
      p.lineTo(xx, H - 4 - SCROLL_H);
      p.stroke();
      p.fillStyle = t.TEXT_BRIGHT;
      p.beginPath();
      p.moveTo(xx - 5, AXIS_H);
      p.lineTo(xx + 5, AXIS_H);
      p.lineTo(xx, AXIS_H + 6);
      p.fill();
    }

    this.drawScrollbar(p, W, H);
  }

  private drawScrollbar(p: CanvasRenderingContext2D, W: number, H: number): void {
    const full = this.last - this.first;
    const left = LBL_W;
    const right = W - PAD_R;
    const trackW = right - left;
    const y = H - SCROLL_H + 3;
    const hh = SCROLL_H - 6;
    p.fillStyle = t.withAlpha(t.TEXT_BRIGHT, 0.05);
    p.fillRect(left, y, trackW, hh);
    const span = this.viewEnd - this.viewStart;
    if (span >= full - 1 || full <= 0) {
      this.scrollThumb = null; // fully zoomed-out → nothing to scroll
      return;
    }
    const tx = left + ((this.viewStart - this.first) / full) * trackW;
    const tw = Math.max(24, Math.min((span / full) * trackW, right - tx));
    p.fillStyle = t.withAlpha(t.TEXT_BRIGHT, this.scrolling ? 0.55 : 0.32);
    p.fillRect(tx, y, tw, hh);
    this.scrollThumb = [tx, H - SCROLL_H, tw, SCROLL_H];
  }

  private drawGridLines(p: CanvasRenderingContext2D, gridBottom: number, bf: number): void {
    const right = this.cssW - PAD_R;
    let k = 0;
    let fr = this.anchor;
    while (fr <= this.last + bf) {
      const xx = this.x(fr);
      if (fr >= this.first && xx >= LBL_W && xx <= right) {
        p.strokeStyle = k % 4 === 0 ? t.GRID_PHRASE : t.GRID_BAR;
        p.beginPath();
        p.moveTo(xx, AXIS_H);
        p.lineTo(xx, gridBottom);
        p.stroke();
      }
      k += 1;
      fr = this.anchor + k * bf;
    }
  }

  private drawBarsRuler(p: CanvasRenderingContext2D, W: number, y: number, h: number, bf: number): void {
    p.strokeStyle = t.BORDER_SUBTLE;
    p.beginPath();
    p.moveTo(LBL_W, y);
    p.lineTo(W - PAD_R, y);
    p.stroke();
    p.font = this.font(10);
    p.fillStyle = t.TEXT_MUTED;
    p.textBaseline = "middle";
    p.fillText("BARS", 10, y + h / 2);
    const barPx = (bf / (this.viewEnd - this.viewStart)) * this.plotW();
    const steps = [1, 2, 4, 8, 16, 32, 64];
    const step = steps.find((s) => s * barPx >= 34) ?? 64;
    p.font = this.font(10, true);
    let k = 0;
    let fr = this.anchor;
    while (fr <= this.last + bf) {
      if (fr >= this.first && k % step === 0) {
        const xx = this.x(fr);
        if (xx >= LBL_W && xx <= W - PAD_R - 10) {
          p.fillStyle = k % 4 === 0 ? t.TEXT_PRIMARY : t.TEXT_MUTED;
          p.fillText(String(k + 1), xx + 3, y + h / 2);
        }
      }
      k += 1;
      fr = this.anchor + k * bf;
    }
    p.textBaseline = "alphabetic";
  }

  private drawTcRuler(p: CanvasRenderingContext2D, W: number, gridBottom: number, drawLines: boolean): void {
    p.font = this.font(10, true);
    let lastRight = -1e9;
    for (let i = 0; i < 7; i++) {
      const fr = this.viewStart + ((this.viewEnd - this.viewStart) * i) / 6;
      const xx = LBL_W + (this.plotW() * i) / 6;
      if (drawLines) {
        p.strokeStyle = t.BORDER_SUBTLE;
        p.beginPath();
        p.moveTo(xx, AXIS_H);
        p.lineTo(xx, gridBottom);
        p.stroke();
      }
      const label = tc(fr, this.fps);
      const tw = p.measureText(label).width;
      const txp = i === 0 ? LBL_W : i === 6 ? W - PAD_R - tw : xx - tw / 2;
      if (txp <= lastRight + 6) continue;
      p.fillStyle = t.TEXT_MUTED;
      p.fillText(label, txp, AXIS_H - 9);
      lastRight = txp + tw;
    }
  }

  private drawAudioBand(p: CanvasRenderingContext2D, W: number, top: number, audioH: number, win: [number, number] | null): void {
    p.strokeStyle = t.BORDER;
    p.beginPath();
    p.moveTo(LBL_W, top);
    p.lineTo(W - PAD_R, top);
    p.stroke();
    p.font = this.font(12);
    p.fillStyle = t.OPERATOR_AUDIO;
    p.fillText("AUDIO", 10, top + 15);
    if (this.audioName) {
      this.ejectAudio = this.drawEject(p, LBL_W - 13, top + 11, this.hoverEject === "audio");
      p.font = this.font(10);
      p.fillStyle = t.TEXT_MUTED;
      p.fillText(this.elide(p, this.audioName, LBL_W - 16, "middle"), 10, top + 31);
    }
    if (!this.audioPeaks) {
      p.font = this.font(12);
      p.fillStyle = t.TEXT_MUTED;
      p.textAlign = "center";
      p.textBaseline = "middle";
      p.fillText("Click or drop an audio file here", LBL_W + (W - PAD_R - LBL_W) / 2, top + audioH / 2);
      p.textAlign = "left";
      p.textBaseline = "alphabetic";
      return;
    }
    const yc = top + audioH / 2;
    const half = audioH / 2 - 5;
    const m = this.audioPeaks.length;
    const peaks = this.audioPeaks;
    const normal = t.withAlpha(t.OPERATOR_AUDIO, 0.78);
    const danger = t.withAlpha(t.SEMANTIC_DANGER, 0.9);
    const right = W - PAD_R;
    const audioFrames = this.audioDur * this.fps;
    // amplitude for a column's [f0,f1) frame range = max peak in that range
    const ampAt = (f0: number, f1: number): number => {
      let i0 = Math.floor(((f0 - this.first) / audioFrames) * m);
      let i1 = Math.ceil(((f1 - this.first) / audioFrames) * m);
      i0 = Math.max(0, i0);
      i1 = Math.min(m, Math.max(i0 + 1, i1));
      let mx = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > mx) mx = peaks[i];
      return Math.min(1, mx * this.gain) * half;
    };
    p.lineWidth = 1;
    // one line per pixel column → solid waveform at any zoom (no gaps)
    p.strokeStyle = normal;
    p.beginPath();
    for (let px = LBL_W; px <= right; px++) {
      const f0 = this.frameAt(px);
      if (f0 < this.first || f0 > this.first + audioFrames) continue;
      const a = ampAt(f0, this.frameAt(px + 1));
      p.moveTo(px + 0.5, yc - a);
      p.lineTo(px + 0.5, yc + a);
    }
    p.stroke();
    if (win) {
      p.strokeStyle = danger; // overdraw the cut window in red
      p.beginPath();
      for (let px = LBL_W; px <= right; px++) {
        const f0 = this.frameAt(px);
        if (f0 < win[0] || f0 >= win[1] || f0 < this.first || f0 > this.first + audioFrames) continue;
        const a = ampAt(f0, this.frameAt(px + 1));
        p.moveTo(px + 0.5, yc - a);
        p.lineTo(px + 0.5, yc + a);
      }
      p.stroke();
    }
  }

  private drawCutLabels(p: CanvasRenderingContext2D, win: [number, number], lanesBottom: number): void {
    const [a, b] = win;
    const xa = this.x(a);
    const xb = this.x(b);
    const len = b - a;
    const col = this.mode === "insert" ? t.SEMANTIC_SUCCESS : t.SEMANTIC_DANGER;
    const sign = this.mode === "insert" ? "+" : "−";
    p.font = this.font(11, true);
    p.fillStyle = col;
    const la = tc(a, this.fps);
    p.fillText(la, Math.max(LBL_W, xa - p.measureText(la).width - 4), AXIS_H + 14);
    p.fillText(tc(b, this.fps), xb + 4, AXIS_H + 14);
    // length readout, centred under the window near the bars row
    const lab = `${sign}${len}f / ${(len / this.fps).toFixed(2)}s`;
    p.font = this.font(10, true);
    const lw = p.measureText(lab).width;
    p.fillStyle = col;
    p.fillText(lab, (xa + xb) / 2 - lw / 2, lanesBottom - 4);

    // handle bar at the top of the window
    p.fillStyle = col;
    p.fillRect(xa, AXIS_H, xb - xa, HANDLE_H);
    p.fillStyle = t.BG_APP;
    p.font = this.font(9);
    p.textAlign = "center";
    p.fillText("···", (xa + xb) / 2, AXIS_H + 8);
    p.textAlign = "left";
    // edge grips
    p.strokeStyle = t.BG_APP;
    p.lineWidth = 1;
    for (const xe of [xa, xb]) {
      p.beginPath();
      p.moveTo(xe, AXIS_H + 2);
      p.lineTo(xe, AXIS_H + HANDLE_H - 2);
      p.stroke();
    }
  }

  private drawEject(p: CanvasRenderingContext2D, cx: number, cy: number, hot: boolean): [number, number, number, number] {
    p.fillStyle = hot ? t.TEXT_PRIMARY : t.TEXT_DIM;
    p.beginPath();
    p.moveTo(cx, cy - 4.5);
    p.lineTo(cx - 4.5, cy + 1);
    p.lineTo(cx + 4.5, cy + 1);
    p.closePath();
    p.fill();
    p.fillRect(cx - 4.5, cy + 2.5, 9, 2);
    return [cx - 9, cy - 9, 18, 18];
  }

  private elide(p: CanvasRenderingContext2D, text: string, maxW: number, mode: "middle" | "end"): string {
    if (p.measureText(text).width <= maxW) return text;
    const ell = "…";
    if (mode === "end") {
      let s = text;
      while (s.length > 1 && p.measureText(s + ell).width > maxW) s = s.slice(0, -1);
      return s + ell;
    }
    let lo = 0;
    let hi = text.length;
    let best = ell;
    while (lo <= hi) {
      const half = Math.floor((lo + hi) / 2);
      const left = text.slice(0, Math.ceil(half / 2));
      const right = text.slice(text.length - Math.floor(half / 2));
      const cand = left + ell + right;
      if (p.measureText(cand).width <= maxW) {
        best = cand;
        lo = half + 1;
      } else {
        hi = half - 1;
      }
    }
    return best;
  }

  // ---------- interaction ----------
  private handleZone(px: number, py: number): Zone {
    const win = this.window();
    if (!win) return null;
    const xa = this.x(win[0]);
    const xb = this.x(win[1]);
    if (!(AXIS_H <= py && py <= AXIS_H + HANDLE_H && xa - 4 <= px && px <= xb + 4)) return null;
    const edge = Math.min(9, (xb - xa) / 2);
    if (px <= xa + edge) return "left";
    if (px >= xb - edge) return "right";
    return "move";
  }

  private rectHit(r: [number, number, number, number] | null, x: number, y: number): boolean {
    return !!r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
  }

  private bindMouse(): void {
    const c = this.el;
    const pos = (e: PointerEvent | MouseEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener(
      "wheel",
      (e) => {
        if (this.lanes.length === 0) return;
        const [x] = pos(e);
        if (x < LBL_W) return;
        if (e.ctrlKey || e.metaKey) {
          // ctrl/cmd + wheel, or trackpad pinch → zoom toward the cursor
          e.preventDefault();
          this.zoomAtFrame(this.frameAt(x), e.deltaY > 0 ? 1.18 : 1 / 1.18);
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          // shift + wheel, or horizontal trackpad swipe → pan
          e.preventDefault();
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.panByFrames((delta / this.plotW()) * this.viewSpan());
        }
        // plain vertical wheel falls through → page scrolls
      },
      { passive: false },
    );
    c.addEventListener("pointerdown", (e) => {
      const [x, y] = pos(e);
      if (this.rectHit(this.ejectShow, x, y)) return this.onEjectShow();
      if (this.rectHit(this.ejectAudio, x, y)) return this.onEjectAudio();
      if (this.lanes.length === 0) return this.onShowRequest();
      if (x < LBL_W) return;
      // bottom scrollbar (only present when zoomed)
      if (this.scrollThumb !== null && y >= this.cssH - SCROLL_H) {
        this.scrolling = true;
        const [tx, , tw] = this.scrollThumb;
        this.scrollGrab = x >= tx && x <= tx + tw ? x - tx : tw / 2;
        try {
          c.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic / unsupported pointer */
        }
        this.scrollTo(x);
        return;
      }
      const zone = this.handleZone(x, y);
      if (zone) {
        c.setPointerCapture(e.pointerId);
        this.dragMode = zone;
        this.winDrag = this.frameAt(x) - (this.cutIn ?? 0);
        c.style.cursor = zone === "move" ? "grabbing" : "ew-resize";
        return;
      }
      if (this.audioTop !== null && y >= this.audioTop && !this.audioPeaks) return this.onAudioRequest();
      c.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      this.onSeek(this.snap(this.frameAt(x)));
    });
    c.addEventListener("pointermove", (e) => {
      const [x, y] = pos(e);
      if (this.scrolling && e.buttons & 1) {
        this.scrollTo(x);
        return;
      }
      if (this.dragMode && e.buttons & 1) {
        const f = this.snap(this.frameAt(x));
        if (this.dragMode === "move") {
          const length = (this.cutOut ?? 0) - (this.cutIn ?? 0);
          const newIn = Math.max(this.first, Math.min(this.snap(this.frameAt(x) - this.winDrag), this.last - length));
          this.cutIn = newIn;
          this.cutOut = newIn + length;
        } else if (this.dragMode === "left") {
          this.cutIn = Math.max(this.first, Math.min(f, (this.cutOut ?? 0) - 1));
        } else {
          this.cutOut = Math.min(this.last, Math.max(f, (this.cutIn ?? 0) + 1));
        }
        this.draw();
        this.onCutDragged(this.cutIn!, this.cutOut!);
        return;
      }
      if (this.scrubbing && e.buttons & 1) {
        this.onSeek(this.snap(this.frameAt(x)));
        return;
      }
      const hov = this.rectHit(this.ejectShow, x, y) ? "show" : this.rectHit(this.ejectAudio, x, y) ? "audio" : null;
      if (hov !== this.hoverEject) {
        this.hoverEject = hov;
        this.draw();
      }
      if (hov) {
        c.style.cursor = "pointer";
        return;
      }
      const z = this.handleZone(x, y);
      c.style.cursor = z === "move" ? "grab" : z ? "ew-resize" : "default";
    });
    const end = () => {
      if (this.dragMode) {
        this.dragMode = null;
        c.style.cursor = "default";
      }
      if (this.scrolling) {
        this.scrolling = false;
        this.draw();
      }
      this.scrubbing = false;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => {
      if (this.hoverEject) {
        this.hoverEject = null;
        this.draw();
      }
    });
  }

  private bindDrop(): void {
    const c = this.el;
    c.addEventListener("dragover", (e) => {
      e.preventDefault();
      c.classList.add("drag-over");
    });
    c.addEventListener("dragleave", () => c.classList.remove("drag-over"));
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      c.classList.remove("drag-over");
      if (e.dataTransfer?.files?.length) this.onFilesDropped([...e.dataTransfer.files]);
    });
  }
}
