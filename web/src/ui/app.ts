// MA2 Timecode Cut — the tool UI. Port of gui.py (MainWindow), wired to the
// shared TS core. Pure DOM + the canvas Timeline + the Web Audio Player.
import { tcToFrames, framesToTc } from "../core/frames.ts";
import { rippleCut, rippleInsert } from "../core/cut.ts";
import { decodeShow, encodeShow, summary, lanes, estimateBeat } from "../core/tcshow.ts";
import type { ShowSummary } from "../core/tcshow.ts";
import { decodeAudio, estimateBpmFromPeaks } from "./audio.ts";
import { Player } from "./player.ts";
import { Timeline } from "./timeline.ts";
import { VolumeKnob } from "./knob.ts";

export const APP_VERSION = "0.1.0";
const AUDIO_EXT = [".wav", ".mp3", ".flac", ".ogg", ".aif", ".aiff", ".m4a"];
const DROP_HINT = "↓ drop your own .xml on the cues + audio on the waveform — or click a lane to browse";
const DROP_HINT_EMPTY = "↓ drop a grandMA2 .xml here — or click the cue area to browse";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}

export class ToolApp {
  readonly el: HTMLElement;

  private text: string | null = null;
  private hasBom = false;
  private fps = 30;
  private anchor = 0;
  private appliedBpm = 0;
  private info: ShowSummary | null = null;
  private showName = "";
  private song: AudioBuffer | null = null;
  private undo: string[] = [];

  private engine = new Player();
  private timeline = new Timeline();
  private knob = new VolumeKnob();
  private raf = 0;

  // controls
  private playBtn!: HTMLButtonElement;
  private tcDisp!: HTMLElement;
  private barDisp!: HTMLElement;
  private metroBtn!: HTMLButtonElement;
  private volLbl!: HTMLElement;
  private infoLabel!: HTMLElement;
  private infoTip!: HTMLElement;
  private cinInput!: HTMLInputElement;
  private coutInput!: HTMLInputElement;
  private durInput!: HTMLInputElement;
  private bpmInput!: HTMLInputElement;
  private autoBtn!: HTMLButtonElement;
  private songPeaks: Float32Array | null = null;
  private songPeaksRate = 0;
  private report!: HTMLPreElement;
  private cutBtn!: HTMLButtonElement;
  private uncutBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private tabCut!: HTMLButtonElement;
  private tabInsert!: HTMLButtonElement;
  private cutMode: "cut" | "insert" = "cut";
  private cinLabel!: HTMLElement;
  private endLabel!: HTMLElement;
  private endSeg!: HTMLElement;
  private endOut!: HTMLButtonElement;
  private endDur!: HTMLButtonElement;
  private coutField!: HTMLElement;
  private durField!: HTMLElement;
  private cinUnit: "tc" | "bar" = "tc";
  private coutUnit: "tc" | "bar" = "tc";
  private durUnit: "sec" | "bar" = "sec";
  private cinUnitBtns: HTMLButtonElement[] = [];
  private coutUnitBtns: HTMLButtonElement[] = [];
  private durUnitBtns: HTMLButtonElement[] = [];
  private endStack!: HTMLElement;
  private snapBtns: HTMLButtonElement[] = [];
  private zoomLbl!: HTMLSpanElement;

  constructor() {
    this.el = this.build();
    this.wire();
    this.setLoaded(false);
  }

  // ---------- build ----------
  private build(): HTMLElement {
    const root = h("div", { class: "tool" });

    // header
    const brand = h("div", { class: "brand" },
      h("span", { class: "brand-mark" }, "Ø"),
      h("span", { class: "brand-name" }, "TIMECODE TOOLS"),
      h("span", { class: "brand-ver" }, `v${APP_VERSION}`),
    );

    this.playBtn = h("button", { class: "icon-btn play", "aria-label": "Play / pause (Space)", disabled: "" }, "▶");
    this.tcDisp = h("span", { class: "tc-disp" }, "00:00:00:00");
    this.barDisp = h("span", { class: "bar-disp" }, "BAR 1·1");
    this.metroBtn = h("button", { class: "icon-btn metro", "aria-label": "Metronome", title: "Metronome (clicks at the bar grid)", "aria-pressed": "false", disabled: "" });
    this.metroBtn.append(metroSvg());
    const transport = h("div", { class: "transport" },
      this.playBtn,
      h("span", { class: "sep" }, "·"),
      this.tcDisp,
      h("span", { class: "sep" }, "·"),
      this.barDisp,
      this.metroBtn,
    );

    const snapWrap = h("div", { class: "snap" }, h("span", { class: "snap-lbl" }, "Snap"));
    const snaps: Array<["off" | "bar" | "beat" | "second", string, string]> = [
      ["off", "○", "No snap"],
      ["bar", "▮", "Snap to bar"],
      ["beat", "♪", "Snap to beat"],
      ["second", "◷", "Snap to second"],
    ];
    snaps.forEach(([mode, glyph, tip], i) => {
      const b = h("button", { class: "snap-btn" + (i === 0 ? " active" : ""), title: tip, "aria-label": tip }, glyph);
      b.addEventListener("click", () => {
        this.timeline.setSnap(mode);
        this.snapBtns.forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
      this.snapBtns.push(b);
      snapWrap.append(b);
    });

    // zoom controls (also: ctrl/⌘ + wheel or pinch over the timeline)
    const zoomWrap = h("div", { class: "zoom" }, h("span", { class: "snap-lbl" }, "Zoom"));
    const zOut = h("button", { class: "snap-btn", title: "Zoom out", "aria-label": "Zoom out" }, "−");
    this.zoomLbl = h("span", { class: "zoom-lbl", title: "Current zoom" }, "1×");
    const zIn = h("button", { class: "snap-btn", title: "Zoom in", "aria-label": "Zoom in" }, "+");
    const zFit = h("button", { class: "snap-btn", title: "Fit to window", "aria-label": "Zoom to fit" }, "⤢");
    zOut.addEventListener("click", () => this.timeline.zoomBy(1.6));
    zIn.addEventListener("click", () => this.timeline.zoomBy(1 / 1.6));
    zFit.addEventListener("click", () => this.timeline.zoomFit());
    zoomWrap.append(zOut, this.zoomLbl, zIn, zFit);
    this.timeline.onZoom = (factor) => {
      this.zoomLbl.textContent = factor <= 1.01 ? "1×" : `${factor < 10 ? factor.toFixed(1) : Math.round(factor)}×`;
    };

    this.volLbl = h("span", { class: "vol-lbl" }, "100%");
    const vol = h("div", { class: "vol" }, h("span", { class: "vol-cap" }, "Vol"), this.knob.el, this.volLbl);

    // BPM control — built here so it can sit in the transport
    this.bpmInput = h("input", { class: "num-input bpm-in", value: "", placeholder: "—", "aria-label": "BPM", spellcheck: "false" }) as HTMLInputElement;
    const halfBtn = h("button", { class: "bpm-mul", title: "Halve BPM", "aria-label": "Halve BPM" }, "÷2");
    const dblBtn = h("button", { class: "bpm-mul", title: "Double BPM", "aria-label": "Double BPM" }, "×2");
    halfBtn.addEventListener("click", () => this.scaleBpm(0.5));
    dblBtn.addEventListener("click", () => this.scaleBpm(2));
    this.autoBtn = h("button", { class: "btn-auto on", title: "Auto-detect BPM — from the audio if loaded, else the cue grid" }, "AUTO");
    const bpmCtl = h("div", { class: "bpm-ctl" }, h("span", { class: "bpm-cap" }, "BPM"), this.bpmInput, halfBtn, dblBtn, this.autoBtn);

    const header = h("div", { class: "header" }, brand, transport, bpmCtl, h("div", { class: "spacer" }), zoomWrap, snapWrap, vol);

    // info line: summary (left, may ellipsis) + an always-visible load hint (right)
    this.infoLabel = h("div", { class: "info-label" }, "No show loaded");
    this.infoTip = h("div", { class: "info-tip" }, DROP_HINT);
    const info = h("div", { class: "info-row" }, this.infoLabel, this.infoTip);

    // timeline
    const tlWrap = h("div", { class: "tl-wrap" }, this.timeline.el);

    // cut panel — two tabs: Cut (ripple-delete) and Insert (open a gap)
    this.tabCut = h("button", { class: "seg active" }, "Cut");
    this.tabInsert = h("button", { class: "seg" }, "Insert");
    const tabRow = h("div", { class: "seg-row" }, this.tabCut, this.tabInsert);

    // Cut in / Insert at — a point with an independent TC/BAR toggle
    this.cinInput = h("input", { class: "tc-input", value: "00:00:00:00", "aria-label": "Cut in", spellcheck: "false" }) as HTMLInputElement;
    this.cinLabel = h("label", {}, "Cut in");
    const cinRow = h("div", { class: "field" }, this.cinLabel,
      h("div", { class: "field-val" }, this.cinInput, this.buildUnit("cin")));

    this.endOut = h("button", { class: "seg active" }, "Cut out");
    this.endDur = h("button", { class: "seg" }, "Duration");
    this.endSeg = h("div", { class: "seg-row small" }, this.endOut, this.endDur);
    this.coutInput = h("input", { class: "tc-input", value: "00:00:04:00", "aria-label": "Cut out", spellcheck: "false" }) as HTMLInputElement;
    this.durInput = h("input", { class: "tc-input", value: "4.000", "aria-label": "Duration / length", spellcheck: "false" }) as HTMLInputElement;
    this.coutField = h("div", { class: "field-val" }, this.coutInput, this.buildUnit("cout"));
    this.durField = h("div", { class: "field-val" }, this.durInput, this.buildUnit("dur"));
    this.endStack = h("div", { class: "end-val" }, this.coutField);
    this.endLabel = h("label", {}, "End by");
    const endRow = h("div", { class: "field" }, this.endLabel,
      h("div", { class: "end-wrap" }, this.endSeg, this.endStack));
    const cutStack = h("div", { class: "mode-stack" }, cinRow, endRow);

    const cutPanel = h("div", { class: "panel cut-panel" }, tabRow, cutStack);

    // preview
    this.report = h("pre", { class: "report" }, "Load a grandMA2 timecode .xml to begin.") as HTMLPreElement;
    const previewPanel = h("div", { class: "panel preview-panel" }, this.report);

    const cols = h("div", { class: "cols" }, cutPanel, previewPanel);

    // action bar
    this.cutBtn = h("button", { class: "btn-cut", disabled: "" }, "CUT!");
    this.uncutBtn = h("button", { class: "btn-uncut", disabled: "" }, "UNCUT");
    this.saveBtn = h("button", { class: "btn-save", disabled: "" }, "SAVE FILE");
    const actions = h("div", { class: "actions" }, this.cutBtn, this.uncutBtn, this.saveBtn);

    root.append(header, info, tlWrap, cols, actions);

    // setup-time wiring
    this.autoBtn.addEventListener("click", () => this.autoBpm(true));
    this.bpmInput.addEventListener("input", () => this.setAutoActive(false)); // typing → manual (AUTO greys)
    this.bpmInput.addEventListener("change", () => this.applyBpm());
    this.bpmInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        this.applyBpm();
        this.bpmInput.blur();
      }
    });

    return root;
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    const wrap = this.timeline.el.parentElement!;
    const ro = new ResizeObserver(() => this.fit());
    ro.observe(wrap); // tl-wrap grows with the window → timeline fills width AND height
    this.fit();
  }

  /** Re-measure the timeline to its container (content box) — fills width + height. */
  fit(): void {
    const wrap = this.timeline.el.parentElement;
    if (!wrap) return;
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    this.timeline.setSize((wrap.clientWidth || 900) - padX, (wrap.clientHeight || 300) - padY);
  }

  /** Optionally preload a bundled demo show so the tool isn't empty on first view.
   *  Pass `bpm` to pin a known tempo instead of the auto-detect estimate. */
  async loadDemo(url: string, bpm?: number): Promise<void> {
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const blob = await r.blob();
      const name = url.split("/").pop() || "demo.xml";
      await this.loadShowFile(new File([blob], name));
      if (bpm && this.text) this.setBpm(bpm, true); // demo tempo, shown as auto
    } catch {
      /* demo is optional */
    }
  }

  // ---------- wiring ----------
  private wire(): void {
    this.timeline.onSeek = (f) => this.seekTo(f);
    this.timeline.onShowRequest = () => this.pickShow();
    this.timeline.onAudioRequest = () => this.pickAudio();
    this.timeline.onEjectShow = () => this.unloadShow();
    this.timeline.onEjectAudio = () => this.unloadAudio();
    this.timeline.onFilesDropped = (files) => this.onDrop(files);
    this.timeline.onCutDragged = (a, b) => this.onCutDragged(a, b);

    this.playBtn.addEventListener("click", () => this.togglePlay());
    this.metroBtn.addEventListener("click", () => this.toggleMetro());
    this.knob.onChange = (v) => this.onVolume(v);
    this.engine.onState = (p) => this.onState(p);

    this.tabCut.addEventListener("click", () => this.setCutMode("cut"));
    this.tabInsert.addEventListener("click", () => this.setCutMode("insert"));
    this.endOut.addEventListener("click", () => this.setEndMode(false));
    this.endDur.addEventListener("click", () => this.setEndMode(true));

    for (const i of [this.cinInput, this.coutInput, this.durInput]) {
      i.addEventListener("input", () => this.recompute());
      i.addEventListener("blur", () => this.reformat());
    }

    this.cutBtn.addEventListener("click", () => (this.cutMode === "insert" ? this.applyInsert() : this.applyCut()));
    this.uncutBtn.addEventListener("click", () => this.doUncut());
    this.saveBtn.addEventListener("click", () => this.saveFile());

    window.addEventListener("keydown", (e) => {
      if (e.key === " " && this.text && !isTyping()) {
        e.preventDefault();
        this.togglePlay();
      }
    });
  }

  // ---------- file IO ----------
  private pickShow(): void {
    pickFile(".xml,application/xml,text/xml").then((f) => f && this.loadShowFile(f));
  }
  private pickAudio(): void {
    if (!this.text) {
      this.toast("Load a show first — open a grandMA2 .xml before adding audio.");
      return;
    }
    pickFile(AUDIO_EXT.join(",") + ",audio/*").then((f) => f && this.loadAudioFile(f));
  }
  private onDrop(files: File[]): void {
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith(".xml")) this.loadShowFile(f);
      else if (AUDIO_EXT.some((e) => n.endsWith(e))) this.loadAudioFile(f);
    }
  }

  private async loadShowFile(f: File): Promise<void> {
    try {
      const buf = await f.arrayBuffer();
      const { hasBom, text } = decodeShow(buf);
      summary(text); // throws if not a timecode show
      this.text = text;
      this.hasBom = hasBom;
      this.showName = f.name;
      this.undo = [];
      this.reloadWorking(this.song === null);
      this.setLoaded(true);
      this.autoBpm(false);
      // reset units to TC/sec and default to a visible 4-second cut window
      this.cinUnit = this.coutUnit = "tc";
      this.durUnit = "sec";
      this.setUnitActive(this.cinUnitBtns, true);
      this.setUnitActive(this.coutUnitBtns, true);
      this.setUnitActive(this.durUnitBtns, true);
      this.cinInput.value = framesToTc(this.anchor, this.fps);
      this.coutInput.value = framesToTc(this.anchor + 4 * this.fps, this.fps);
      this.recompute();
    } catch (err) {
      this.toast(`Can't read file: ${(err as Error).message}`);
    }
  }

  /** Load audio from a URL (used to preload a bundled demo track). */
  async loadAudioUrl(url: string): Promise<void> {
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const blob = await r.blob();
      await this.loadAudioFile(new File([blob], url.split("/").pop() || "audio"));
    } catch {
      /* demo audio is optional */
    }
  }

  private async loadAudioFile(f: File): Promise<void> {
    if (!this.text) return;
    try {
      // decode on an OfflineAudioContext — no user-gesture / output context yet
      const buf = await f.arrayBuffer();
      const dec = await decodeAudio(buf);
      this.song = dec.buffer;
      this.songPeaks = dec.peaks;
      this.songPeaksRate = dec.duration > 0 ? dec.peaks.length / dec.duration : 0;
      this.engine.setAudio(dec.buffer);
      this.timeline.setAudio(dec.peaks, dec.duration, f.name);
      this.updateMetroEnabled();
    } catch (err) {
      this.toast(`Couldn't load audio: ${(err as Error).message}`);
    }
  }

  private reloadWorking(resetAudio: boolean): void {
    const info = summary(this.text!);
    this.info = info;
    this.fps = info.fps;
    this.anchor = info.firstFrame;
    this.infoLabel.textContent =
      `${info.name} · ${info.fps} FPS · ${info.firstTc}–${info.lastTc} · ${info.nEvents} cues · ${info.nSubtracks} tracks`;
    this.infoTip.textContent = DROP_HINT;
    this.timeline.setShow(info.fps, lanes(this.text!), info.firstFrame, info.lastFrame, this.showName);
    this.timeline.setGrid(this.appliedBpm, this.anchor);
    if (resetAudio) {
      this.song = null;
      this.timeline.clearAudio();
    }
    this.engine.setShow(info.firstFrame, info.lastFrame, info.fps);
    this.engine.setVolume(this.knob.value() / 100);
    this.engine.seekFrame(this.firstFrame()); // reset position so the cut/uncut length change can't strand the playhead
    this.applyMetro();
    this.playBtn.disabled = false;
    this.timeline.setPlayhead(this.firstFrame());
    this.updateHead(this.firstFrame());
  }

  private unloadShow(): void {
    if (this.text === null) return;
    this.engine.pause();
    this.text = null;
    this.info = null;
    this.song = null;
    this.showName = "";
    this.appliedBpm = 0;
    this.undo = [];
    this.timeline.reset();
    this.engine.clearAudio();
    this.uncutBtn.disabled = true;
    this.playBtn.disabled = true;
    this.metroBtn.classList.remove("on");
    this.metroBtn.setAttribute("aria-pressed", "false");
    this.metroBtn.disabled = true;
    this.setLoaded(false);
    this.infoLabel.textContent = "No show loaded";
    this.infoTip.textContent = DROP_HINT_EMPTY;
    this.report.textContent = "Load a grandMA2 timecode .xml to begin.";
    this.bpmInput.value = "";
    this.songPeaks = null;
    this.setAutoActive(true);
    this.refreshSave();
  }

  private unloadAudio(): void {
    if (this.song === null) return;
    this.song = null;
    this.songPeaks = null;
    this.engine.clearAudio();
    this.timeline.clearAudio();
    this.timeline.setPlayhead(this.firstFrame());
    this.updateMetroEnabled();
  }

  private async saveFile(): Promise<void> {
    if (!this.text) return;
    const base = (this.showName || "show").replace(/\.xml$/i, "");
    const name = `${base}_cut.xml`;
    const bytes = encodeShow(this.text, this.hasBom);
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.report.textContent =
      `Cut saved → ${name}\n\nImport into grandMA2 (empty slot, filename first, no .xml):\n\n` +
      `    Import "${base}_cut" At Timecode <N>`;
  }

  // ---------- cut compute ----------
  private endIsDuration(): boolean {
    return this.endDur.classList.contains("active");
  }
  private barFrames(): number {
    return this.appliedBpm > 0 ? (this.fps * 240) / this.appliedBpm : 0;
  }
  private barToFrame(bar: number): number | null {
    const bf = this.barFrames();
    return bf > 0 && isFinite(bar) ? Math.round(this.anchor + (bar - 1) * bf) : null;
  }
  private frameToBar(fr: number): number {
    const bf = this.barFrames();
    return bf > 0 ? (fr - this.anchor) / bf + 1 : 1;
  }
  private tcSafe(s: string): number | null {
    try {
      return tcToFrames(s, this.fps);
    } catch {
      return null;
    }
  }
  private pointFrame(value: string, unit: "tc" | "bar"): number | null {
    return unit === "bar" ? this.barToFrame(parseFloat(value)) : this.tcSafe(value);
  }
  /** a bar/bars unit is active but there's no BPM yet */
  private barsNeedBpm(): boolean {
    const endBar = this.endIsDuration() ? this.durUnit === "bar" : this.coutUnit === "bar";
    return this.appliedBpm <= 0 && (this.cinUnit === "bar" || endBar);
  }

  private cutWindow(): { cin: number; len: number } | null {
    if (!this.text) return null;
    const cin = this.pointFrame(this.cinInput.value, this.cinUnit);
    if (cin === null) return null;
    let len: number;
    if (this.endIsDuration()) {
      const v = parseFloat(this.durInput.value);
      if (!isFinite(v) || v <= 0) return null;
      if (this.durUnit === "bar") {
        const bf = this.barFrames();
        if (bf <= 0) return null;
        len = Math.round(v * bf);
      } else {
        len = Math.round(v * this.fps);
      }
    } else {
      const cout = this.pointFrame(this.coutInput.value, this.coutUnit);
      if (cout === null) return null;
      len = cout - cin;
    }
    return len > 0 ? { cin, len } : null;
  }

  private recompute(): void {
    if (!this.text) return;
    const insert = this.cutMode === "insert";
    const w = this.cutWindow();
    if (!w || w.len <= 0) {
      this.timeline.setCut(null, null);
      this.report.textContent = this.barsNeedBpm()
        ? "Set a BPM to use bar units."
        : insert
          ? "Set an insert point and a positive length."
          : "Cut out must be later than cut in.";
      this.cutBtn.disabled = true;
      return;
    }
    const { cin, len } = w;
    const cout = cin + len;
    this.timeline.setCut(cin, cout);

    const lines: string[] = [];
    const barsLine = (verb: string): void => {
      if (this.appliedBpm <= 0) return;
      const beatFrames = (this.fps * 60) / this.appliedBpm;
      const beats = len / beatFrames;
      const bars = beats / 4;
      if (Math.abs(bars - Math.round(bars)) < 0.02) {
        lines.push(`At ${this.appliedBpm.toFixed(2)} BPM: ${beats.toFixed(2)} beats ≈ ${Math.round(bars)} bars   ✓ whole bars`);
      } else {
        const nb = Math.max(1, Math.round(bars));
        lines.push(`At ${this.appliedBpm.toFixed(2)} BPM: ${beats.toFixed(2)} beats — ⚠ not whole bars`);
        lines.push(`   nearest ${nb} bars → ${verb} ${framesToTc(cin + Math.round(nb * 4 * beatFrames), this.fps)}`);
      }
    };

    if (insert) {
      const { shifted } = rippleInsert(this.text, cin, len);
      lines.push("PENDING — press INSERT! to apply", "");
      lines.push(`Insert at:   ${framesToTc(cin, this.fps)}`);
      lines.push(`Length:      ${len} frames  /  ${(len / this.fps).toFixed(3)} s`);
      barsLine("gap ends at");
      lines.push("");
      lines.push(`SHIFT ${shifted} cues right by ${len} frames.`);
      lines.push("Opens a gap — nothing is deleted.");
    } else {
      const { deleted, shifted } = rippleCut(this.text, cin, len);
      lines.push("PENDING — press CUT! to apply", "");
      lines.push(`Cut window:  ${framesToTc(cin, this.fps)}  →  ${framesToTc(cout, this.fps)}`);
      lines.push(`Length:      ${len} frames  /  ${(len / this.fps).toFixed(3)} s`);
      barsLine("cut out");
      lines.push("");
      lines.push(`DELETE ${deleted.length} cues:`);
      for (const [fr, nm] of deleted.slice(0, 18)) lines.push(`    ${framesToTc(fr, this.fps)}  ${nm}`);
      if (deleted.length > 18) lines.push(`    … and ${deleted.length - 18} more`);
      lines.push("");
      lines.push(`SHIFT ${shifted} cues left by ${len} frames.`);
    }
    this.report.textContent = lines.join("\n");
    this.cutBtn.disabled = false;
  }

  private onCutDragged(a: number, b: number): void {
    // write the dragged window back into whatever units are selected
    this.cinInput.value = this.cinUnit === "bar" ? this.frameToBar(a).toFixed(2) : framesToTc(a, this.fps);
    if (this.endIsDuration()) {
      const bf = this.barFrames();
      this.durInput.value =
        this.durUnit === "bar" && bf > 0 ? ((b - a) / bf).toFixed(2) : ((b - a) / this.fps).toFixed(3);
    } else {
      this.coutInput.value = this.coutUnit === "bar" ? this.frameToBar(b).toFixed(2) : framesToTc(b, this.fps);
    }
    this.recompute();
  }

  private applyCut(): void {
    if (!this.text) return;
    const w = this.cutWindow();
    if (!w || w.len <= 0) return;
    this.undo.push(this.text);
    const { text } = rippleCut(this.text, w.cin, w.len);
    this.text = text;
    this.reloadWorking(false);
    this.timeline.setCut(null, null);
    this.uncutBtn.disabled = false;
    this.refreshSave();
    const n = this.undo.length;
    this.report.textContent = `✓ CUT APPLIED  (UNCUT to undo · ${n} edit${n === 1 ? "" : "s"})`;
  }

  private applyInsert(): void {
    if (!this.text) return;
    const w = this.cutWindow(); // cin = insert point, len = gap length
    if (!w || w.len <= 0) return;
    this.undo.push(this.text);
    const { text } = rippleInsert(this.text, w.cin, w.len);
    this.text = text;
    this.reloadWorking(false);
    this.timeline.setCut(null, null);
    this.uncutBtn.disabled = false;
    this.refreshSave();
    const n = this.undo.length;
    this.report.textContent = `✓ INSERTED  (UNCUT to undo · ${n} edit${n === 1 ? "" : "s"})`;
  }

  private doUncut(): void {
    if (!this.undo.length) return;
    this.text = this.undo.pop()!;
    this.reloadWorking(false);
    this.uncutBtn.disabled = this.undo.length === 0;
    this.refreshSave();
    this.recompute(); // keep the segment selected and re-show its preview
    const n = this.undo.length;
    this.toast("Reverted last cut" + (n ? ` · ${n} left` : ""));
  }

  // ---------- BPM ----------
  private setAutoActive(on: boolean): void {
    this.autoBtn.classList.toggle("on", on);
  }
  private setBpm(v: number, isAuto: boolean): void {
    this.appliedBpm = v;
    this.bpmInput.value = v % 1 === 0 ? String(v) : v.toFixed(1);
    this.setAutoActive(isAuto);
    this.timeline.setGrid(this.appliedBpm, this.anchor);
    this.applyMetro();
    this.recompute();
    this.timeline.relayout();
  }
  private applyBpm(): void {
    const v = parseFloat(this.bpmInput.value);
    if (!isFinite(v) || v <= 0) {
      this.setAutoActive(false);
      return;
    }
    this.setBpm(v, false); // manual → AUTO greys
  }
  private scaleBpm(factor: number): void {
    if (this.appliedBpm <= 0) return;
    this.setBpm(Math.round(this.appliedBpm * factor * 100) / 100, false); // octave shift = manual override
  }
  private autoBpm(announce: boolean): void {
    if (!this.text) return;
    // prefer the audio (real tempo) when loaded, else the cue grid
    let bpm: number | null = this.songPeaks ? estimateBpmFromPeaks(this.songPeaks, this.songPeaksRate) : null;
    if (bpm === null) {
      const est = estimateBeat(this.text);
      bpm = est ? Math.round(est.bpm * 10) / 10 : null;
    }
    if (bpm) {
      this.setBpm(bpm, true); // detected → AUTO amber
    } else if (announce) {
      this.setAutoActive(false);
      this.bpmInput.focus();
    }
  }

  // ---------- transport ----------
  private togglePlay(): void {
    if (!this.text) return;
    this.engine.toggle();
  }
  private onState(playing: boolean): void {
    this.playBtn.textContent = playing ? "❚❚" : "▶";
    this.playBtn.classList.toggle("on", playing);
    if (playing) this.loop();
    else cancelAnimationFrame(this.raf);
  }
  private loop(): void {
    const step = () => {
      const f = this.engine.positionFrame();
      this.timeline.setPlayhead(f);
      this.updateHead(f);
      if (this.engine.isPlaying()) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  private seekTo(f: number): void {
    this.engine.seekFrame(f);
    this.timeline.setPlayhead(f);
    this.updateHead(f);
  }
  private updateHead(f: number): void {
    this.tcDisp.textContent = framesToTc(f, this.fps);
    if (this.appliedBpm > 0) {
      const beat = (this.fps * 60) / this.appliedBpm;
      const b = Math.floor((f - this.anchor) / beat);
      const bar = Math.floor(b / 4) + 1;
      const beatInBar = ((b % 4) + 4) % 4 + 1;
      this.barDisp.textContent = `BAR ${bar}·${beatInBar}`;
    } else {
      this.barDisp.textContent = "BAR —";
    }
  }

  private onVolume(v: number): void {
    this.engine.setVolume(v / 100);
    this.timeline.setGain(v / 100);
    this.volLbl.textContent = `${v}%`;
  }

  private toggleMetro(): void {
    const on = !this.metroBtn.classList.contains("on");
    this.metroBtn.classList.toggle("on", on);
    this.metroBtn.setAttribute("aria-pressed", String(on));
    this.applyMetro();
  }
  private applyMetro(): void {
    const on = this.metroBtn.classList.contains("on") && this.appliedBpm > 0 && this.text !== null;
    const beatFrames = this.appliedBpm > 0 ? (this.fps * 60) / this.appliedBpm : 0;
    this.engine.setMetro(on, beatFrames, this.anchor);
  }
  private updateMetroEnabled(): void {
    const ok = this.text !== null && this.appliedBpm > 0;
    this.metroBtn.disabled = !this.text;
    if (!ok && this.metroBtn.classList.contains("on")) {
      this.metroBtn.classList.remove("on");
      this.metroBtn.setAttribute("aria-pressed", "false");
    }
    this.applyMetro();
  }

  // ---------- units / modes / state ----------
  private buildUnit(which: "cin" | "cout" | "dur"): HTMLElement {
    const dur = which === "dur";
    const aLbl = dur ? "sec" : "TC";
    const bLbl = dur ? "bars" : "BAR";
    const aBtn = h("button", { class: "unit active", "aria-label": aLbl, title: aLbl }, aLbl) as HTMLButtonElement;
    const bBtn = h("button", { class: "unit", "aria-label": bLbl, title: bLbl }, bLbl) as HTMLButtonElement;
    aBtn.addEventListener("click", () => this.setUnit(which, dur ? "sec" : "tc"));
    bBtn.addEventListener("click", () => this.setUnit(which, "bar"));
    if (which === "cin") this.cinUnitBtns = [aBtn, bBtn];
    else if (which === "cout") this.coutUnitBtns = [aBtn, bBtn];
    else this.durUnitBtns = [aBtn, bBtn];
    return h("div", { class: "unit-seg" }, aBtn, bBtn);
  }
  private setUnit(which: "cin" | "cout" | "dur", unit: "tc" | "bar" | "sec"): void {
    const bf = this.barFrames();
    if (which === "dur") {
      if (unit !== this.durUnit) {
        const cur = parseFloat(this.durInput.value);
        if (isFinite(cur) && bf > 0) {
          this.durInput.value =
            unit === "bar" ? ((cur * this.fps) / bf).toFixed(2) : ((cur * bf) / this.fps).toFixed(3);
        }
      }
      this.durUnit = unit === "bar" ? "bar" : "sec";
      this.setUnitActive(this.durUnitBtns, this.durUnit === "sec");
    } else {
      const input = which === "cin" ? this.cinInput : this.coutInput;
      const prev = which === "cin" ? this.cinUnit : this.coutUnit;
      const next: "tc" | "bar" = unit === "bar" ? "bar" : "tc";
      if (next !== prev) {
        if (next === "bar") {
          const fr = bf > 0 ? this.tcSafe(input.value) : null;
          input.value = fr !== null ? this.frameToBar(fr).toFixed(2) : "1";
        } else {
          const fr = bf > 0 ? this.barToFrame(parseFloat(input.value)) : null;
          input.value = framesToTc(fr ?? this.anchor, this.fps);
        }
      }
      if (which === "cin") {
        this.cinUnit = next;
        this.setUnitActive(this.cinUnitBtns, next === "tc");
      } else {
        this.coutUnit = next;
        this.setUnitActive(this.coutUnitBtns, next === "tc");
      }
    }
    this.recompute();
  }
  private setUnitActive(btns: HTMLButtonElement[], firstActive: boolean): void {
    btns[0].classList.toggle("active", firstActive);
    btns[1].classList.toggle("active", !firstActive);
  }
  private setCutMode(mode: "cut" | "insert"): void {
    this.cutMode = mode;
    const insert = mode === "insert";
    this.tabInsert.classList.toggle("active", insert);
    this.tabCut.classList.toggle("active", !insert);
    this.cinLabel.textContent = insert ? "Insert at" : "Cut in";
    this.endLabel.textContent = insert ? "Length" : "End by";
    // insert is always point + length → force Duration and hide the Cut out toggle
    this.endSeg.style.display = insert ? "none" : "";
    if (insert && !this.endIsDuration()) this.setEndMode(true);
    this.cutBtn.textContent = insert ? "INSERT!" : "CUT!";
    this.cutBtn.classList.toggle("insert", insert);
    this.timeline.setMode(insert ? "insert" : "cut");
    this.recompute();
  }
  private setEndMode(dur: boolean): void {
    const w = this.cutWindow(); // current window, computed in the OLD mode
    this.endDur.classList.toggle("active", dur);
    this.endOut.classList.toggle("active", !dur);
    this.endStack.innerHTML = "";
    this.endStack.append(dur ? this.durField : this.coutField);
    // carry the window across the switch so it doesn't jump
    if (w) {
      if (dur) {
        const bf = this.barFrames();
        this.durInput.value =
          this.durUnit === "bar" && bf > 0 ? (w.len / bf).toFixed(2) : (w.len / this.fps).toFixed(3);
      } else {
        const cout = w.cin + w.len;
        this.coutInput.value =
          this.coutUnit === "bar" ? this.frameToBar(cout).toFixed(2) : framesToTc(cout, this.fps);
      }
    }
    this.recompute();
  }
  private setLoaded(ok: boolean): void {
    const ctrls: Array<HTMLInputElement | HTMLButtonElement> = [
      this.cinInput, this.coutInput, this.durInput, this.bpmInput, this.endOut, this.endDur,
      this.tabCut, this.tabInsert,
      ...this.cinUnitBtns, ...this.coutUnitBtns, ...this.durUnitBtns,
    ];
    for (const c of ctrls) c.disabled = !ok;
    this.cutBtn.disabled = !ok;
    this.metroBtn.disabled = !ok;
    this.updateMetroEnabled();
  }
  private refreshSave(): void {
    this.saveBtn.disabled = this.undo.length === 0;
    this.saveBtn.classList.toggle("hot", this.undo.length > 0);
  }
  private reformat(): void {
    if (!this.text) return;
    if (this.cinUnit === "tc") {
      const f = this.tcSafe(this.cinInput.value);
      if (f !== null) this.cinInput.value = framesToTc(f, this.fps);
    }
    if (!this.endIsDuration() && this.coutUnit === "tc") {
      const f = this.tcSafe(this.coutInput.value);
      if (f !== null) this.coutInput.value = framesToTc(f, this.fps);
    }
  }
  private firstFrame(): number {
    return this.info ? this.info.firstFrame : 0;
  }
  private toast(msg: string): void {
    this.report.textContent = msg;
  }
}

function metroSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  const body = document.createElementNS(ns, "path");
  body.setAttribute("d", "M9 3 h6 l3 18 H6 Z");
  body.setAttribute("fill", "none");
  body.setAttribute("stroke", "currentColor");
  body.setAttribute("stroke-width", "1.6");
  body.setAttribute("stroke-linejoin", "round");
  const pend = document.createElementNS(ns, "line");
  pend.setAttribute("x1", "12");
  pend.setAttribute("y1", "19");
  pend.setAttribute("x2", "15.5");
  pend.setAttribute("y2", "7");
  pend.setAttribute("stroke", "currentColor");
  pend.setAttribute("stroke-width", "1.6");
  pend.setAttribute("stroke-linecap", "round");
  svg.append(body, pend);
  return svg;
}
function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA");
}
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept });
    inp.style.display = "none";
    inp.addEventListener("change", () => resolve(inp.files?.[0] ?? null));
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 1000);
  });
}
