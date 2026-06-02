// MA2 Timecode Cut — the tool UI. Port of gui.py (MainWindow), wired to the
// shared TS core. Pure DOM + the canvas Timeline + the Web Audio Player.
import { tcToFrames, framesToTc } from "../core/frames.ts";
import { rippleCut } from "../core/cut.ts";
import { decodeShow, encodeShow, summary, lanes, estimateBeat } from "../core/tcshow.ts";
import type { ShowSummary } from "../core/tcshow.ts";
import { decodeAudio } from "./audio.ts";
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
  private bpmHint!: HTMLElement;
  private report!: HTMLPreElement;
  private cutBtn!: HTMLButtonElement;
  private uncutBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private modeTc!: HTMLButtonElement;
  private modeBars!: HTMLButtonElement;
  private endOut!: HTMLButtonElement;
  private endDur!: HTMLButtonElement;
  private fromBar!: HTMLInputElement;
  private removeBars!: HTMLInputElement;
  private tcStack!: HTMLElement;
  private barsStack!: HTMLElement;
  private endStack!: HTMLElement;
  private snapBtns: HTMLButtonElement[] = [];

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
      h("span", { class: "brand-name" }, "TIMECODE CUT"),
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

    this.volLbl = h("span", { class: "vol-lbl" }, "100%");
    const vol = h("div", { class: "vol" }, h("span", { class: "vol-cap" }, "Vol"), this.knob.el, this.volLbl);

    const header = h("div", { class: "header" }, brand, transport, h("div", { class: "spacer" }), snapWrap, vol);

    // info line: summary (left, may ellipsis) + an always-visible load hint (right)
    this.infoLabel = h("div", { class: "info-label" }, "No show loaded");
    this.infoTip = h("div", { class: "info-tip" }, DROP_HINT);
    const info = h("div", { class: "info-row" }, this.infoLabel, this.infoTip);

    // timeline
    const tlWrap = h("div", { class: "tl-wrap" }, this.timeline.el);

    // cut panel
    this.modeTc = h("button", { class: "seg active" }, "By timecode");
    this.modeBars = h("button", { class: "seg" }, "By bars");
    const modeRow = h("div", { class: "seg-row" }, this.modeTc, this.modeBars);

    this.cinInput = h("input", { class: "tc-input", value: "00:00:00:00", "aria-label": "Cut in", spellcheck: "false" }) as HTMLInputElement;
    const cinRow = h("div", { class: "field" }, h("label", {}, "Cut in"), this.cinInput);

    this.endOut = h("button", { class: "seg active" }, "Cut out");
    this.endDur = h("button", { class: "seg" }, "Duration");
    const endSeg = h("div", { class: "seg-row small" }, this.endOut, this.endDur);
    this.coutInput = h("input", { class: "tc-input", value: "00:00:00:00", "aria-label": "Cut out", spellcheck: "false" }) as HTMLInputElement;
    this.durInput = h("input", { class: "tc-input", value: "8.000", "aria-label": "Duration seconds", spellcheck: "false" }) as HTMLInputElement;
    this.endStack = h("div", { class: "end-stack" }, this.coutInput);
    const endRow = h("div", { class: "field" }, h("label", {}, "End by"), h("div", { class: "end-wrap" }, endSeg, this.endStack));
    this.tcStack = h("div", { class: "mode-stack" }, cinRow, endRow);

    this.fromBar = h("input", { class: "num-input", type: "number", min: "1", value: "1", "aria-label": "From bar" }) as HTMLInputElement;
    this.removeBars = h("input", { class: "num-input", type: "number", min: "1", value: "4", "aria-label": "Remove bars" }) as HTMLInputElement;
    this.barsStack = h("div", { class: "mode-stack hidden" },
      h("div", { class: "field" }, h("label", {}, "From bar"), this.fromBar),
      h("div", { class: "field" }, h("label", {}, "Remove bars"), this.removeBars),
    );

    this.bpmInput = h("input", { class: "num-input", value: "", placeholder: "—", "aria-label": "BPM", spellcheck: "false" }) as HTMLInputElement;
    const setBtn = h("button", { class: "btn-sec" }, "Set");
    const autoBtn = h("button", { class: "btn-auto" }, "AUTO");
    const bpmRow = h("div", { class: "field bpm-row" }, h("label", {}, "BPM"), this.bpmInput, setBtn, autoBtn);
    this.bpmHint = h("div", { class: "bpm-hint" }, "");

    const cutPanel = h("div", { class: "panel cut-panel" }, modeRow, this.tcStack, this.barsStack, bpmRow, this.bpmHint);

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
    setBtn.addEventListener("click", () => this.applyBpm());
    autoBtn.addEventListener("click", () => this.autoBpm(true));
    this.bpmInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") this.applyBpm();
    });

    return root;
  }

  mount(parent: HTMLElement): void {
    parent.append(this.el);
    const ro = new ResizeObserver(() => {
      this.timeline.setWidth(this.timeline.el.parentElement!.clientWidth);
    });
    ro.observe(this.el);
    this.timeline.setWidth(this.timeline.el.parentElement!.clientWidth || 900);
  }

  /** Re-measure the timeline to its container — call when the view becomes visible. */
  fit(): void {
    this.timeline.setWidth(this.timeline.el.parentElement?.clientWidth || 900);
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
      if (bpm && this.text) {
        this.bpmInput.value = String(bpm);
        this.applyBpm();
      }
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

    this.modeTc.addEventListener("click", () => this.setMode(false));
    this.modeBars.addEventListener("click", () => this.setMode(true));
    this.endOut.addEventListener("click", () => this.setEndMode(false));
    this.endDur.addEventListener("click", () => this.setEndMode(true));

    for (const i of [this.cinInput, this.coutInput, this.durInput, this.fromBar, this.removeBars]) {
      i.addEventListener("input", () => this.recompute());
      i.addEventListener("blur", () => this.reformat());
    }

    this.cutBtn.addEventListener("click", () => this.applyCut());
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
      this.cinInput.value = framesToTc(this.anchor, this.fps);
      this.coutInput.value = framesToTc(this.anchor, this.fps);
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
    this.bpmHint.textContent = "";
    this.refreshSave();
  }

  private unloadAudio(): void {
    if (this.song === null) return;
    this.song = null;
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
  private byBars(): boolean {
    return this.modeBars.classList.contains("active");
  }
  private endIsDuration(): boolean {
    return this.endDur.classList.contains("active");
  }

  private cutWindow(): { cin: number; len: number } | null {
    if (!this.text) return null;
    if (this.byBars()) {
      if (this.appliedBpm <= 0) return null;
      const bar = (this.fps * 240) / this.appliedBpm;
      const fromN = Math.max(1, Math.round(num(this.fromBar.value, 1)));
      const cnt = Math.max(1, Math.round(num(this.removeBars.value, 1)));
      return { cin: Math.round(this.anchor + (fromN - 1) * bar), len: Math.round(cnt * bar) };
    }
    const cin = tcToFrames(this.cinInput.value, this.fps);
    if (this.endIsDuration()) {
      const len = Math.round(num(this.durInput.value, 0) * this.fps);
      return { cin, len };
    }
    const cout = tcToFrames(this.coutInput.value, this.fps);
    return { cin, len: cout - cin };
  }

  private recompute(): void {
    if (!this.text) return;
    const w = this.cutWindow();
    if (!w || w.len <= 0) {
      this.timeline.setCut(null, null);
      this.report.textContent =
        this.byBars() && this.appliedBpm <= 0
          ? "Set a BPM first to cut by bars."
          : "Cut out must be later than cut in.";
      this.cutBtn.disabled = true;
      return;
    }
    const { cin, len } = w;
    const cout = cin + len;
    this.timeline.setCut(cin, cout);
    const { deleted, shifted } = rippleCut(this.text, cin, len);

    const lines: string[] = ["PENDING — press CUT! to apply", ""];
    lines.push(`Cut window:  ${framesToTc(cin, this.fps)}  →  ${framesToTc(cout, this.fps)}`);
    lines.push(`Length:      ${len} frames  /  ${(len / this.fps).toFixed(3)} s`);
    if (this.appliedBpm > 0) {
      const beatFrames = (this.fps * 60) / this.appliedBpm;
      const beats = len / beatFrames;
      const bars = beats / 4;
      const whole = Math.abs(bars - Math.round(bars)) < 0.02;
      if (whole) {
        lines.push(`At ${this.appliedBpm.toFixed(2)} BPM: ${beats.toFixed(2)} beats ≈ ${Math.round(bars)} bars   ✓ whole bars`);
      } else {
        const nb = Math.max(1, Math.round(bars));
        const newLen = Math.round(nb * 4 * beatFrames);
        lines.push(`At ${this.appliedBpm.toFixed(2)} BPM: ${beats.toFixed(2)} beats — ⚠ not whole bars`);
        lines.push(`   nearest ${nb} bars → cut out ${framesToTc(cin + newLen, this.fps)}`);
      }
    }
    lines.push("");
    lines.push(`DELETE ${deleted.length} cues:`);
    for (const [fr, nm] of deleted.slice(0, 18)) lines.push(`    ${framesToTc(fr, this.fps)}  ${nm}`);
    if (deleted.length > 18) lines.push(`    … and ${deleted.length - 18} more`);
    lines.push("");
    lines.push(`SHIFT ${shifted} cues left by ${len} frames.`);
    this.report.textContent = lines.join("\n");
    this.cutBtn.disabled = false;
  }

  private onCutDragged(a: number, b: number): void {
    if (this.byBars()) {
      const bar = (this.fps * 240) / this.appliedBpm;
      this.fromBar.value = String(Math.max(1, Math.round((a - this.anchor) / bar) + 1));
      this.removeBars.value = String(Math.max(1, Math.round((b - a) / bar)));
    } else {
      this.cinInput.value = framesToTc(a, this.fps);
      if (this.endIsDuration()) this.durInput.value = ((b - a) / this.fps).toFixed(3);
      else this.coutInput.value = framesToTc(b, this.fps);
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
    this.report.textContent = `✓ CUT APPLIED  (UNCUT to undo · ${n} cut${n === 1 ? "" : "s"})`;
  }

  private doUncut(): void {
    if (!this.undo.length) return;
    this.text = this.undo.pop()!;
    this.reloadWorking(false);
    this.timeline.setCut(null, null);
    this.uncutBtn.disabled = this.undo.length === 0;
    this.refreshSave();
    const n = this.undo.length;
    this.report.textContent = "Reverted last cut." + (n ? `  (${n} cut${n === 1 ? "" : "s"} left)` : "");
  }

  // ---------- BPM ----------
  private applyBpm(): void {
    const v = parseFloat(this.bpmInput.value);
    if (!isFinite(v) || v <= 0) return;
    this.appliedBpm = v;
    this.bpmInput.value = v.toFixed(v % 1 === 0 ? 0 : 2);
    this.timeline.setGrid(this.appliedBpm, this.anchor);
    this.bpmHint.textContent = `BPM set to ${this.bpmInput.value}`;
    this.applyMetro();
    this.recompute();
    this.timeline.relayout();
  }

  private autoBpm(announce: boolean): void {
    if (!this.text) return;
    const est = estimateBeat(this.text);
    if (est) {
      this.appliedBpm = est.bpm;
      this.bpmInput.value = est.bpm.toFixed(2);
      this.timeline.setGrid(this.appliedBpm, this.anchor);
      this.bpmHint.textContent = `≈ ${est.bpm.toFixed(1)} BPM detected from the cues · type a value + Set to override`;
    } else {
      this.bpmHint.textContent = "Couldn't auto-detect BPM — type the track BPM and press Set.";
      if (announce) this.bpmInput.focus();
    }
    this.applyMetro();
    this.recompute();
    this.timeline.relayout();
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

  // ---------- modes / state ----------
  private setMode(bars: boolean): void {
    this.modeBars.classList.toggle("active", bars);
    this.modeTc.classList.toggle("active", !bars);
    this.tcStack.classList.toggle("hidden", bars);
    this.barsStack.classList.toggle("hidden", !bars);
    this.recompute();
  }
  private setEndMode(dur: boolean): void {
    this.endDur.classList.toggle("active", dur);
    this.endOut.classList.toggle("active", !dur);
    this.endStack.innerHTML = "";
    this.endStack.append(dur ? this.durInput : this.coutInput);
    this.recompute();
  }
  private setLoaded(ok: boolean): void {
    for (const c of [this.cinInput, this.coutInput, this.durInput, this.bpmInput, this.fromBar, this.removeBars, this.modeTc, this.modeBars, this.endOut, this.endDur]) {
      (c as HTMLInputElement | HTMLButtonElement).disabled = !ok;
    }
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
    try {
      this.cinInput.value = framesToTc(tcToFrames(this.cinInput.value, this.fps), this.fps);
      if (!this.endIsDuration()) this.coutInput.value = framesToTc(tcToFrames(this.coutInput.value, this.fps), this.fps);
    } catch {
      /* leave as typed */
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
function num(s: string, dflt: number): number {
  const v = parseFloat(s);
  return isFinite(v) ? v : dflt;
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
