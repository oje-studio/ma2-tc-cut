// LTC Generator — single + batch SMPTE timecode WAV exporter.
// Vanilla DOM, no framework. Visual language mirrors the MA2 Timecode Tools
// app inside this same site: a transport bar with mono TC readouts, segmented
// pills for discrete choices, a green action button.

import {
  generateLtcWav,
  renderLtcPcm,
  planBatch,
  buildZip,
  chunkByBytes,
  type BatchSpec,
  type PlannedFile,
} from "../core/ltc.ts";

type Fps = 24 | 25 | 29.97 | 30;
type SampleRate = 22050 | 44100 | 48000;
type DurUnit = "s" | "min" | "h";

interface State {
  mode: "single" | "batch";
  fps: Fps;
  dropFrame: boolean;
  sampleRate: SampleRate;
  level: number;
  // single
  startTc: string;
  durationSec: number;
  durationUnit: DurUnit;
  filename: string;
  // batch
  rangeStart: string;
  rangeEnd: string;
  intervalSec: number;
  intervalUnit: DurUnit;
  batchDurationSec: number;
  batchDurationUnit: DurUnit;
  filenamePattern: string;
}

const DEFAULTS: State = {
  mode: "single",
  fps: 30,
  dropFrame: false,
  sampleRate: 48000,
  level: 0.5,
  startTc: "00:00:00:00",
  durationSec: 60,
  durationUnit: "s",
  filename: "ltc_00-00-00",          // .wav appended by the tool
  rangeStart: "00:00:00",
  rangeEnd: "23:59:00",
  intervalSec: 1800,
  intervalUnit: "min",
  batchDurationSec: 1500,
  batchDurationUnit: "min",
  filenamePattern: "ltc_{hh}-{mm}",  // .wav appended by the tool
};

// Memory ceiling for each ZIP chunk (≈1.5 GB keeps Chrome / Safari happy).
// Total cap = MAX_CHUNKS × per-chunk → refuses anything beyond ~9 GB.
const PER_ZIP_LIMIT_BYTES = 1.5 * 1024 ** 3;
const MAX_ZIPS = 6;

const UNIT_S: Record<DurUnit, number> = { s: 1, min: 60, h: 3600 };
const toUnit = (sec: number, u: DurUnit): number => Math.round((sec / UNIT_S[u]) * 100) / 100;

/** Pick a sensible tick interval (seconds) for a timeline spanning `total` s. */
function chooseTickStep(total: number): number {
  // Aim for ~12-24 ticks across the strip
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const c of candidates) if (total / c <= 30) return c;
  return 3600;
}
/** Every Nth tick is a "major" tick (with a label). Sparser for long spans
 *  so the labels don't collide on the canvas. */
function chooseMajorEvery(step: number): number {
  if (step >= 3600) return 6;   // every 6 hours
  if (step >= 1800) return 2;   // every hour
  if (step >= 600) return 3;    // every 30 min
  if (step >= 60) return 5;     // every 5 min
  if (step >= 10) return 6;     // every minute
  if (step >= 1) return 5;      // every 5 s
  return 10;
}
/** Short timeline label — elapsed time from file start. HH:MM:SS over 1h,
 *  MM:SS otherwise. Cleaner than absolute TC; the absolute moment is in the
 *  "frame …" label under the waveform fragment instead. */
function formatTimeShort(secOffset: number): string {
  const total = Math.round(secOffset);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export class LtcApp {
  readonly el: HTMLElement;
  private s: State = { ...DEFAULTS };
  private preview!: HTMLElement;
  private waveCanvas!: HTMLCanvasElement;
  private startReadout!: HTMLElement;
  private endReadout!: HTMLElement;
  private fpsBadge!: HTMLElement;
  private srBadge!: HTMLElement;
  private levelBadge!: HTMLElement;
  private genBtn!: HTMLButtonElement;
  private playBtn?: HTMLButtonElement;
  private status!: HTMLElement;
  // Web Audio playback (Single mode "Play" button)
  private audioCtx: AudioContext | null = null;
  private playingNode: AudioBufferSourceNode | null = null;
  // Playhead — offset in seconds from start of file. Visible as a green vertical
  // line on the timeline strip above the LTC waveform. Click/drag to seek.
  private playheadSec = 0;
  private playStartedAt = 0;   // audioCtx.currentTime when last play started
  private playStartOffset = 0; // playheadSec at the moment of play start
  private rafId: number | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ltc-tool";
    this.render();
  }

  // ---- TC mask -----------------------------------------------------------
  /** Pad a partial TC to canonical form on blur (e.g. "1:2" → "00:00:01:02"). */
  private formatTcCanonical(raw: string, slots: 6 | 8): string {
    const digits = raw.replace(/[^\d]/g, "").slice(0, slots).padStart(slots, "0");
    const parts: string[] = [];
    for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
    return parts.join(":");
  }
  /** No live-rewriting — that made editing the middle of an existing TC feel
   *  squishy (backspace would silently get reformatted away). Just block
   *  non-TC characters while typing, then canonicalize on blur. Matches the
   *  MA2 Timecode Cut behaviour. */
  private wireTcInput(
    input: HTMLInputElement, slots: 6 | 8,
    onCommit: (value: string) => void,
  ): void {
    input.addEventListener("input", () => {
      // Strip anything that isn't a digit or colon. Keep length unbounded —
      // blur will normalise.
      const cleaned = input.value.replace(/[^\d:;]/g, "");
      if (cleaned !== input.value) {
        const caret = input.selectionEnd ?? cleaned.length;
        input.value = cleaned;
        try { input.setSelectionRange(caret - 1, caret - 1); } catch {/**/}
      }
      onCommit(input.value);
    });
    input.addEventListener("blur", () => {
      if (!input.value) return;
      const canon = this.formatTcCanonical(input.value, slots);
      input.value = canon;
      onCommit(canon);
    });
  }

  // ---- DOM helpers ----
  private h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    ...children: (Node | string)[]
  ): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of children) e.append(typeof c === "string" ? document.createTextNode(c) : c);
    return e;
  }

  /** Build a `seg-row small` of mutually-exclusive pills. */
  private segRow<T extends string | number>(
    options: ReadonlyArray<{ value: T; label: string }>,
    current: T,
    onPick: (v: T) => void,
    ariaLabel: string,
  ): HTMLElement {
    const row = this.h("div", { class: "seg-row small", role: "group", "aria-label": ariaLabel });
    for (const opt of options) {
      const b = this.h(
        "button",
        { class: "seg" + (opt.value === current ? " active" : ""), type: "button" },
        opt.label,
      );
      b.addEventListener("click", () => onPick(opt.value));
      row.append(b);
    }
    return row;
  }

  // ---- render ----
  private render(): void {
    const h = this.h.bind(this);

    // ---- transport bar ---------------------------------------------------
    this.startReadout = h("span", { class: "tc-disp" }, this.s.startTc);
    this.endReadout = h("span", { class: "tc-disp tc-end" }, "—");
    this.fpsBadge = h("span", { class: "ltc-badge" }, `${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps`);
    this.srBadge = h("span", { class: "ltc-badge" }, `${this.s.sampleRate / 1000} kHz`);
    this.levelBadge = h("span", { class: "ltc-badge" }, `${(20 * Math.log10(this.s.level)).toFixed(1)} dBFS`);
    const transport = h(
      "div",
      { class: "ltc-transport" },
      h("span", { class: "ltc-tx-glyph" }, "▣"),
      this.startReadout,
      h("span", { class: "sep" }, "→"),
      this.endReadout,
      h("span", { class: "ltc-tx-spacer" }),
      h("span", { class: "ltc-badges" }, this.fpsBadge, this.srBadge, this.levelBadge),
    );

    // ---- mode tabs -------------------------------------------------------
    const tabs = h("div", { class: "seg-row" },
      this.makeTab("Single file", "single"),
      this.makeTab("Batch", "batch"),
    );

    // ---- shared output card ---------------------------------------------
    const fpsRow = this.segRow(
      [
        { value: 24, label: "24" },
        { value: 25, label: "25" },
        { value: 29.97, label: "29.97" },
        { value: 30, label: "30" },
      ] as const,
      this.s.fps,
      (v) => { this.s.fps = v as Fps; if (v !== 29.97) this.s.dropFrame = false; this.render(); },
      "Frame rate",
    );

    const dfChk = h("input", { type: "checkbox", id: "ltc-df", "aria-label": "Drop-frame" }) as HTMLInputElement;
    if (this.s.dropFrame) dfChk.setAttribute("checked", "");
    dfChk.addEventListener("change", () => {
      this.s.dropFrame = dfChk.checked;
      // Auto-switch fps to 29.97 when DF is enabled — DF is only meaningful there.
      if (dfChk.checked) this.s.fps = 29.97;
      this.render();
    });
    const dfWrap = h(
      "label",
      { class: "ltc-check", for: "ltc-df" },
      dfChk,
      h("span", {}, "Drop-frame (forces 29.97)"),
    );

    const srRow = this.segRow(
      [
        { value: 22050, label: "22.05" },
        { value: 44100, label: "44.1" },
        { value: 48000, label: "48" },
      ] as const,
      this.s.sampleRate,
      (v) => { this.s.sampleRate = v as SampleRate; this.render(); },
      "Sample rate (kHz)",
    );

    const levelInput = h("input", {
      type: "range", min: "0.05", max: "1", step: "0.05", value: String(this.s.level),
      class: "ltc-range", "aria-label": "Output level",
    }) as HTMLInputElement;
    const levelOut = h("span", { class: "ltc-range-out" }, `${Math.round(this.s.level * 100)}%`);
    levelInput.addEventListener("input", () => {
      this.s.level = parseFloat(levelInput.value);
      levelOut.textContent = `${Math.round(this.s.level * 100)}%`;
      this.levelBadge.textContent = `${(20 * Math.log10(this.s.level)).toFixed(1)} dBFS`;
      this.drawWave();        // amplitude follows the level visually
      this.stopPlay();        // running playback would be stale at the new level
    });

    const optsCard = h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Output"),
      h("div", { class: "ltc-row" }, h("label", {}, "Frame rate"), fpsRow, h("span", { class: "ltc-suffix" }, "fps")),
      h("div", { class: "ltc-row" }, h("label", {}, ""), dfWrap),
      h("div", { class: "ltc-row" }, h("label", {}, "Sample rate"), srRow, h("span", { class: "ltc-suffix" }, "kHz")),
      h("div", { class: "ltc-row" }, h("label", {}, "Level"), levelInput, levelOut),
    );

    // ---- mode-specific card ---------------------------------------------
    const modeCard = this.s.mode === "single" ? this.renderSingle() : this.renderBatch();

    // ---- preview --------------------------------------------------------
    this.preview = h("pre", { class: "ltc-preview" }, "");
    this.waveCanvas = h("canvas", {
      class: "ltc-wave", width: "1200", height: "140",
      "aria-label": "LTC waveform preview with timeline and playhead",
    }) as HTMLCanvasElement;
    // Single mode: canvas is interactive — click/drag the playhead to seek.
    if (this.s.mode === "single") {
      this.waveCanvas.style.cursor = "ew-resize";
      let dragging = false;
      const seek = (e: PointerEvent): void => {
        const rect = this.waveCanvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        this.playheadSec = (x / rect.width) * this.s.durationSec;
        this.drawWave();
      };
      this.waveCanvas.addEventListener("pointerdown", (e) => {
        dragging = true;
        this.waveCanvas.setPointerCapture(e.pointerId);
        seek(e);
      });
      this.waveCanvas.addEventListener("pointermove", (e) => { if (dragging) seek(e); });
      const release = (e: PointerEvent): void => {
        if (!dragging) return;
        dragging = false;
        try { this.waveCanvas.releasePointerCapture(e.pointerId); } catch {/**/}
        // If audio was playing, restart from the new playhead position.
        if (this.playingNode) { this.stopPlay(); void this.togglePlay(); }
      };
      this.waveCanvas.addEventListener("pointerup", release);
      this.waveCanvas.addEventListener("pointercancel", release);
    } else {
      this.waveCanvas.style.cursor = "default";
    }

    // ---- action bar -----------------------------------------------------
    this.status = h("div", { class: "ltc-status" }, "");
    this.genBtn = h("button", { class: "btn-cut", type: "button" },
      this.s.mode === "single" ? "DOWNLOAD WAV" : "DOWNLOAD ZIP",
    );
    this.genBtn.addEventListener("click", () => void this.generate());

    // Play button — Single mode only. Lets you audition the LTC through the
    // browser's audio output (field-test it through a speaker, headphones,
    // or a console reading SMPTE off a 1/4" line input).
    const actionChildren: Node[] = [];
    if (this.s.mode === "single") {
      this.playBtn = h("button", {
        class: "btn-play", type: "button", "aria-label": "Play / stop preview",
      }, "▶ Play") as HTMLButtonElement;
      this.playBtn.addEventListener("click", () => void this.togglePlay());
      actionChildren.push(this.playBtn);
      // If the user navigates away from Single (tab swap), kill any playback.
    } else {
      this.playBtn = undefined;
      this.stopPlay();
    }
    actionChildren.push(this.genBtn, this.status);

    // ---- mount ----------------------------------------------------------
    this.el.replaceChildren(
      transport,
      h("div", { class: "ltc-header" }, tabs),
      h("div", { class: "ltc-grid" }, modeCard, optsCard),
      h(
        "div",
        { class: "ltc-preview-wrap" },
        h("h3", { class: "ltc-card-h" }, "Preview"),
        // Canvas FIRST so the waveform + timeline + playhead stay visible
        // above the fold; the (potentially long) preview text scrolls below.
        this.waveCanvas,
        this.preview,
      ),
      h("div", { class: "ltc-actions" }, ...actionChildren),
    );

    this.updatePreview();
    this.drawWave();
  }

  // ---- Web Audio playback ------------------------------------------------
  private async togglePlay(): Promise<void> {
    if (this.playingNode) { this.stopPlay(); return; }
    try {
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();

      // Snap a stale playhead back to the start (e.g. if user changed startTc
      // while paused; the playhead may now be past the new end).
      if (this.playheadSec >= this.s.durationSec - 0.01) this.playheadSec = 0;

      this.setStatus("Rendering preview…");
      await new Promise((r) => setTimeout(r, 0));

      // Render from the playhead offset, not from the start.
      const fpsActual = Math.abs(this.s.fps - 29.97) < 0.01 ? 30000 / 1001 : this.s.fps;
      const fpsNom = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01 ? 30 : Math.round(this.s.fps);
      const isDf = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01;
      const offsetFrames = Math.round(this.playheadSec * fpsActual);
      const startFr = this.tcToFramesLocal(this.s.startTc, fpsNom, isDf) + offsetFrames;
      const offsetTc = this.framesToTcLocal(startFr, fpsNom, isDf);
      const remainingSec = Math.max(0.05, this.s.durationSec - this.playheadSec);

      const r = renderLtcPcm({
        startTc: offsetTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: remainingSec, sampleRate: this.s.sampleRate, level: this.s.level,
      });
      const buf = this.audioCtx.createBuffer(1, r.pcm.length, r.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < r.pcm.length; i++) ch[i] = r.pcm[i] / 32768;
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      src.onended = () => { if (this.playingNode === src) this.stopPlay(); };
      src.start();
      this.playingNode = src;
      this.playStartedAt = this.audioCtx.currentTime;
      this.playStartOffset = this.playheadSec;
      if (this.playBtn) { this.playBtn.textContent = "◼ Stop"; this.playBtn.classList.add("on"); }
      this.setStatus(`Playing ${offsetTc} → ${r.endTc} (${r.frames} frames)`);
      // Animate the playhead.
      this.tickPlayhead();
    } catch (err) {
      this.setStatus("⚠ " + (err as Error).message);
      this.stopPlay();
    }
  }

  /** RAF loop: advance the playhead based on audioCtx.currentTime, redraw. */
  private tickPlayhead(): void {
    if (!this.audioCtx || !this.playingNode) { this.rafId = null; return; }
    const elapsed = this.audioCtx.currentTime - this.playStartedAt;
    const pos = this.playStartOffset + elapsed;
    if (pos >= this.s.durationSec) {
      this.playheadSec = this.s.durationSec;
      this.drawWave();
      this.rafId = null;
      return;
    }
    this.playheadSec = pos;
    this.drawWave();
    this.rafId = requestAnimationFrame(() => this.tickPlayhead());
  }

  private stopPlay(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.playingNode) {
      try { this.playingNode.stop(); } catch {/**/}
      try { this.playingNode.disconnect(); } catch {/**/}
      this.playingNode = null;
    }
    if (this.playBtn) { this.playBtn.textContent = "▶ Play"; this.playBtn.classList.remove("on"); }
  }

  private makeTab(label: string, mode: "single" | "batch"): HTMLElement {
    const b = this.h("button", {
      class: "seg" + (this.s.mode === mode ? " active" : ""),
      type: "button",
    }, label);
    b.addEventListener("click", () => {
      if (this.s.mode === mode) return;
      this.stopPlay();
      this.playheadSec = 0; // fresh slate on tab switch
      this.s.mode = mode;
      this.render();
    });
    return b;
  }

  /** Number + unit pill row. Stores value internally in SECONDS.
   *  `onSec` runs on every keystroke (no re-render — keeps the input focused).
   *  `onUnit` runs when the user picks a different unit pill — and triggers a
   *  full re-render so the "active" pill switches AND the input value gets
   *  redisplayed in the new unit. */
  private durationField(
    sec: number, unit: DurUnit,
    onSec: (sec: number) => void,
    onUnit: (sec: number, unit: DurUnit) => void,
    ariaLabel: string,
  ): HTMLElement {
    const h = this.h.bind(this);
    const input = h("input", {
      type: "number", class: "tc-input num", min: "0", step: "any",
      value: String(toUnit(sec, unit)), "aria-label": ariaLabel,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      const raw = parseFloat(input.value) || 0;
      onSec(Math.round(raw * UNIT_S[unit]));
    });
    const units = this.segRow(
      [{ value: "s" as DurUnit, label: "s" }, { value: "min", label: "min" }, { value: "h", label: "h" }] as const,
      unit,
      (u) => {
        const raw = parseFloat(input.value) || 0;
        const newSec = Math.round(raw * UNIT_S[unit]);
        onUnit(newSec, u);
      },
      `${ariaLabel} units`,
    );
    return h("div", { class: "ltc-dur" }, input, units);
  }

  private renderSingle(): HTMLElement {
    const h = this.h.bind(this);
    const tcIn = h("input", {
      type: "text", class: "tc-input", value: this.s.startTc, inputmode: "numeric",
      spellcheck: "false", placeholder: "HH:MM:SS:FF", "aria-label": "Start timecode",
    }) as HTMLInputElement;
    this.wireTcInput(tcIn, 8, (v) => { this.s.startTc = v; this.updatePreview(); this.drawWave(); });

    const durField = this.durationField(
      this.s.durationSec, this.s.durationUnit,
      (sec) => { this.s.durationSec = sec; this.updatePreview(); },
      (sec, u) => { this.s.durationSec = sec; this.s.durationUnit = u; this.render(); },
      "Duration",
    );

    const nameIn = h("input", {
      type: "text", class: "tc-input", value: this.s.filename, spellcheck: "false",
      "aria-label": "Filename (without extension)",
    }) as HTMLInputElement;
    const hint = h("p", { class: "ltc-hint" }, `→ saves as ${this.ensureWav(this.s.filename || "ltc")}`);
    nameIn.addEventListener("input", () => {
      this.s.filename = nameIn.value;
      hint.textContent = `→ saves as ${this.ensureWav(this.s.filename || "ltc")}`;
    });

    return h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Single file"),
      h("div", { class: "ltc-row" }, h("label", {}, "Start TC"), tcIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Duration"), durField),
      h("div", { class: "ltc-row" }, h("label", {}, "Filename"), nameIn),
      hint,
    );
  }

  private renderBatch(): HTMLElement {
    const h = this.h.bind(this);
    const startIn = h("input", {
      type: "text", class: "tc-input", value: this.s.rangeStart, inputmode: "numeric",
      placeholder: "HH:MM:SS", "aria-label": "Range start",
    }) as HTMLInputElement;
    this.wireTcInput(startIn, 6, (v) => { this.s.rangeStart = v; this.updatePreview(); this.drawWave(); });
    const endIn = h("input", {
      type: "text", class: "tc-input", value: this.s.rangeEnd, inputmode: "numeric",
      placeholder: "HH:MM:SS", "aria-label": "Range end",
    }) as HTMLInputElement;
    this.wireTcInput(endIn, 6, (v) => { this.s.rangeEnd = v; this.updatePreview(); });

    const intField = this.durationField(
      this.s.intervalSec, this.s.intervalUnit,
      (sec) => { this.s.intervalSec = sec; this.updatePreview(); },
      (sec, u) => { this.s.intervalSec = sec; this.s.intervalUnit = u; this.render(); },
      "Interval",
    );
    const durField = this.durationField(
      this.s.batchDurationSec, this.s.batchDurationUnit,
      (sec) => { this.s.batchDurationSec = sec; this.updatePreview(); },
      (sec, u) => { this.s.batchDurationSec = sec; this.s.batchDurationUnit = u; this.render(); },
      "Length each",
    );

    const patIn = h("input", {
      type: "text", class: "tc-input", value: this.s.filenamePattern, spellcheck: "false",
      "aria-label": "Filename pattern (without extension)",
    }) as HTMLInputElement;
    patIn.addEventListener("input", () => { this.s.filenamePattern = patIn.value; this.updatePreview(); });

    return h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Batch"),
      h("div", { class: "ltc-row" }, h("label", {}, "Range start"), startIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Range end"), endIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Interval"), intField),
      h("div", { class: "ltc-row" }, h("label", {}, "Length each"), durField),
      h("div", { class: "ltc-row" }, h("label", {}, "Filename"), patIn),
      h("p", { class: "ltc-hint" }, "Tokens: {tc} {hh} {mm} {ss} {idx}  ·  .wav appended"),
    );
  }

  // ---- preview text ----------------------------------------------------
  private fmtSec(n: number): string {
    if (n >= 3600 && n % 3600 === 0) return `${n / 3600} h`;
    if (n >= 60 && n % 60 === 0) return `${n / 60} min`;
    return `${n} s`;
  }
  private fmtBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  }
  private ensureWav(name: string): string {
    return /\.wav$/i.test(name) ? name : name + ".wav";
  }

  private updatePreview(): void {
    if (!this.preview) return;
    // Clamp playhead — if duration was shrunk below the current position, the
    // playhead must come back into range or it'd float off the end of the file.
    if (this.s.mode === "single") {
      this.playheadSec = Math.max(0, Math.min(this.s.durationSec, this.playheadSec));
    }
    const sr = this.s.sampleRate;
    try {
      if (this.s.mode === "single") {
        const end = this.estimateEndTc(this.s.startTc, this.s.durationSec);
        const bytes = Math.round(this.s.durationSec * sr * 2 + 44);
        this.startReadout.textContent = this.s.startTc;
        this.endReadout.textContent = end;
        this.fpsBadge.textContent = `${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps`;
        this.srBadge.textContent = `${sr / 1000} kHz`;
        this.preview.textContent = [
          `1 file · ${this.fmtSec(this.s.durationSec)} · ${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps · ${sr / 1000} kHz mono`,
          `${this.s.startTc}   →   ${end}`,
          `≈ ${this.fmtBytes(bytes)}`,
        ].join("\n");
        this.genBtn.disabled = false;
        return;
      }
      // ---- batch ----
      const spec: BatchSpec = {
        rangeStart: this.s.rangeStart, rangeEnd: this.s.rangeEnd,
        intervalSec: this.s.intervalSec, durationSec: this.s.batchDurationSec,
        fps: this.s.fps, dropFrame: this.s.dropFrame, filenamePattern: this.s.filenamePattern,
      };
      const files = planBatch(spec);
      const eachBytes = Math.round(this.s.batchDurationSec * sr * 2 + 44);
      const totalBytes = eachBytes * files.length;

      const sized = files.map((f) => ({ ...f, bytes: eachBytes }));
      const { chunks, truncated } = chunkByBytes(sized, PER_ZIP_LIMIT_BYTES, MAX_ZIPS);

      this.startReadout.textContent = files[0]?.startTc ?? this.s.rangeStart;
      this.endReadout.textContent = files[files.length - 1]?.endTc ?? "—";
      this.fpsBadge.textContent = `${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps`;
      this.srBadge.textContent = `${sr / 1000} kHz`;

      const head = files.slice(0, 5).map((f) => `  ${this.ensureWav(f.filename)}   ${f.startTc} → ${f.endTc}`);
      const tail = files.length > 8
        ? [`  … ${files.length - 6} more …`, `  ${this.ensureWav(files[files.length - 1].filename)}   ${files[files.length - 1].startTc} → ${files[files.length - 1].endTc}`]
        : [];

      const zipLine = chunks.length === 1
        ? `Single ZIP · ${this.fmtBytes(totalBytes)}`
        : `${chunks.length} ZIPs · ≈ ${this.fmtBytes(totalBytes / chunks.length)} each · ${this.fmtBytes(totalBytes)} total`;

      const lines = [
        `${files.length} files · ${this.fmtSec(this.s.batchDurationSec)} each · ${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps · ${sr / 1000} kHz mono`,
        `every ${this.fmtSec(this.s.intervalSec)} from ${this.s.rangeStart} to ${this.s.rangeEnd}`,
        zipLine,
        "",
        ...head, ...tail,
      ];

      if (truncated > 0) {
        lines.push("", `⚠ Over the ${MAX_ZIPS}-ZIP / ~${this.fmtBytes(PER_ZIP_LIMIT_BYTES * MAX_ZIPS)} ceiling. ${truncated} files would be dropped.`, `  Raise the interval, lower the sample rate, or shorten each file.`);
        this.genBtn.disabled = true;
      } else {
        this.genBtn.disabled = false;
      }

      this.preview.textContent = lines.join("\n");
    } catch (err) {
      this.preview.textContent = "⚠ " + (err as Error).message;
      this.genBtn.disabled = true;
    }
    this.drawWave();
  }

  // ---- waveform canvas -------------------------------------------------
  // Layout (DPR-aware): top strip is a TC timeline with tick marks + green
  // playhead handle; bottom strip is an amber LTC square-wave fragment showing
  // BMC at the playhead's TC position. In Single mode the strip is interactive
  // (click/drag to seek); in Batch it's static (start of first file).
  private drawWave(): void {
    if (!this.waveCanvas) return;
    const cv = this.waveCanvas;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 1200;
    const cssH = cv.clientHeight || 140;
    if (cv.width !== Math.round(cssW * dpr)) {
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const TIMELINE_H = 30;
    const waveTop = TIMELINE_H;
    const waveH = cssH - TIMELINE_H;

    // --- timeline strip background ---
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, cssW, TIMELINE_H);
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, waveTop, cssW, waveH);
    // separator
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, waveTop + 0.5); ctx.lineTo(cssW, waveTop + 0.5); ctx.stroke();

    // --- timeline ticks ---
    const isSingle = this.s.mode === "single";
    // In Batch mode, span one file's length — the whole-day range would just
    // be unreadable, and the waveform fragment is the start of file 1 anyway.
    const totalSec = isSingle ? Math.max(0.5, this.s.durationSec) : Math.max(10, this.s.batchDurationSec);
    const tickStep = chooseTickStep(totalSec);
    const majorEvery = chooseMajorEvery(tickStep);
    ctx.font = "10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let t = 0; t <= totalSec + 0.001; t += tickStep) {
      const x = (t / totalSec) * cssW;
      const isMajor = Math.round(t / tickStep) % majorEvery === 0;
      ctx.strokeStyle = isMajor ? "#4a4a4a" : "#2e2e2e";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, isMajor ? 12 : 20);
      ctx.lineTo(x + 0.5, TIMELINE_H - 1);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = "#a5a5a5";
        const lbl = formatTimeShort(t);
        const lblW = ctx.measureText(lbl).width;
        // anchor labels: first stays left-aligned, last right-aligned, middle centred
        let lx = x - lblW / 2;
        if (lx < 2) lx = 2;
        if (lx + lblW > cssW - 2) lx = cssW - lblW - 2;
        ctx.fillText(lbl, lx, 7);
      }
    }

    // --- LTC waveform fragment at playhead TC ---
    const fpsActual = Math.abs(this.s.fps - 29.97) < 0.01 ? 30000 / 1001 : this.s.fps;
    const fpsNom = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01 ? 30 : Math.round(this.s.fps);
    const isDf = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01;
    let pcm: Int16Array | null = null;
    let fragTc = isSingle ? this.s.startTc : this.s.rangeStart + ":00";
    try {
      if (isSingle) {
        const off = Math.round(this.playheadSec * fpsActual);
        const fr = this.tcToFramesLocal(this.s.startTc, fpsNom, isDf) + off;
        fragTc = this.framesToTcLocal(fr, fpsNom, isDf);
      }
      const r = renderLtcPcm({
        startTc: fragTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: 1.5 / fpsActual, sampleRate: 8000,
        level: Math.max(0.05, this.s.level),
      });
      pcm = r.pcm;
    } catch {/**/}

    if (pcm && pcm.length) {
      // sync-word band (right 20%)
      const samplesPerFrameP = 8000 / fpsActual;
      for (let f = 0; (f * samplesPerFrameP) < pcm.length; f++) {
        const xs = ((f + 0.8) * samplesPerFrameP / pcm.length) * cssW;
        const xe = ((f + 1.0) * samplesPerFrameP / pcm.length) * cssW;
        ctx.fillStyle = "rgba(245, 165, 36, 0.08)";
        ctx.fillRect(Math.min(xs, cssW), waveTop, Math.max(0, Math.min(xe, cssW) - xs), waveH);
      }
      // amber waveform
      ctx.strokeStyle = "#f5a524";
      ctx.lineWidth = 1.6;
      ctx.lineCap = "square";
      ctx.lineJoin = "miter";
      ctx.beginPath();
      const margin = 8;
      const amp = (waveH - margin * 2) / 2;
      const mid = waveTop + waveH / 2;
      const step = pcm.length / cssW;
      for (let x = 0; x < cssW; x++) {
        const i = Math.min(pcm.length - 1, Math.floor(x * step));
        const v = pcm[i] / 32767;
        const y = mid - v * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // tiny labels — frame TC bottom-left, "sync" bottom-right (scrim'd)
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "bottom";
      const lbl = `frame ${fragTc}`;
      const lblW = ctx.measureText(lbl).width;
      ctx.fillStyle = "rgba(22, 22, 22, 0.85)";
      ctx.fillRect(4, cssH - 16, lblW + 8, 14);
      ctx.fillRect(cssW - 36, cssH - 16, 32, 14);
      ctx.fillStyle = "#a5a5a5";
      ctx.fillText(lbl, 8, cssH - 4);
      ctx.fillText("sync", cssW - 33, cssH - 4);
    } else {
      ctx.fillStyle = "#6a6a6a";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("waveform unavailable — check TC", 12, waveTop + waveH / 2);
    }

    // --- playhead (Single mode only) ---
    if (isSingle) {
      const phX = Math.round((this.playheadSec / totalSec) * cssW) + 0.5;
      ctx.strokeStyle = this.playingNode ? "#2ebd6b" : "#7ab7ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, cssH); ctx.stroke();
      // handle triangle at the top
      ctx.fillStyle = this.playingNode ? "#2ebd6b" : "#7ab7ff";
      ctx.beginPath();
      ctx.moveTo(phX - 6, 0);
      ctx.lineTo(phX + 6, 0);
      ctx.lineTo(phX, 8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.textBaseline = "alphabetic"; // restore default
  }


  // ---- TC math (mirror of core, kept local for preview labels) ----------
  private estimateEndTc(startTc: string, durationSec: number): string {
    const isDf = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01;
    const fpsNom = isDf ? 30 : Math.round(this.s.fps);
    const fpsActual = isDf ? 30000 / 1001 : this.s.fps;
    try {
      const startFr = this.tcToFramesLocal(startTc, fpsNom, isDf);
      const endFr = startFr + Math.round(durationSec * fpsActual) - 1;
      return this.framesToTcLocal(endFr, fpsNom, isDf);
    } catch {
      return "—";
    }
  }
  private tcToFramesLocal(tc: string, fpsNom: number, df: boolean): number {
    const m = tc.match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/);
    if (!m) throw new Error("bad tc");
    const [hh, mi, s, f] = [+m[1], +m[2], +m[3], +m[4]];
    if (!df) return ((hh * 60 + mi) * 60 + s) * fpsNom + f;
    const tm = hh * 60 + mi;
    return ((hh * 60 + mi) * 60 + s) * 30 + f - 2 * (tm - Math.floor(tm / 10));
  }
  private framesToTcLocal(fr: number, fpsNom: number, df: boolean): string {
    const p2 = (n: number) => String(n).padStart(2, "0");
    if (!df) {
      const f = fr % fpsNom; let total = Math.floor(fr / fpsNom);
      const s = total % 60; total = Math.floor(total / 60);
      const mi = total % 60; const hh = Math.floor(total / 60);
      return `${p2(hh)}:${p2(mi)}:${p2(s)}:${p2(f)}`;
    }
    const FP10 = 17982, FPM = 1798;
    const d = Math.floor(fr / FP10), n = fr % FP10;
    fr = n < 2 ? fr + 9 * 2 * d : fr + 9 * 2 * d + 2 * Math.floor((n - 2) / FPM);
    const f = fr % 30; let total = Math.floor(fr / 30);
    const s = total % 60; total = Math.floor(total / 60);
    const mi = total % 60; const hh = Math.floor(total / 60);
    return `${p2(hh)}:${p2(mi)}:${p2(s)};${p2(f)}`;
  }

  // ---- generate ---------------------------------------------------------
  private setStatus(t: string): void { if (this.status) this.status.textContent = t; }

  private async generate(): Promise<void> {
    this.genBtn.disabled = true;
    try {
      if (this.s.mode === "single") {
        this.setStatus("Rendering…");
        await new Promise((r) => setTimeout(r, 0));
        const r = generateLtcWav({
          startTc: this.s.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
          durationSec: this.s.durationSec, sampleRate: this.s.sampleRate, level: this.s.level,
        });
        const name = this.ensureWav(this.s.filename || "ltc.wav");
        this.download(r.wav, name, "audio/wav");
        this.setStatus(`Saved ${name} · ${r.frames} frames · ends ${r.endTc}`);
        return;
      }

      // ---- batch ----
      const files = planBatch({
        rangeStart: this.s.rangeStart, rangeEnd: this.s.rangeEnd,
        intervalSec: this.s.intervalSec, durationSec: this.s.batchDurationSec,
        fps: this.s.fps, dropFrame: this.s.dropFrame, filenamePattern: this.s.filenamePattern,
      });
      const eachBytes = Math.round(this.s.batchDurationSec * this.s.sampleRate * 2 + 44);
      const sized = files.map((f) => ({ ...f, bytes: eachBytes }));
      const { chunks, truncated } = chunkByBytes(sized, PER_ZIP_LIMIT_BYTES, MAX_ZIPS);
      if (truncated > 0) throw new Error(`Refusing to build — exceeds the ${this.fmtBytes(PER_ZIP_LIMIT_BYTES * MAX_ZIPS)} ceiling.`);
      await this.generateBatch(chunks);
    } catch (err) {
      this.setStatus("⚠ " + (err as Error).message);
    } finally {
      this.genBtn.disabled = false;
    }
  }

  private async generateBatch(chunks: PlannedFile[][]): Promise<void> {
    const dateStamp = new Date().toISOString().slice(0, 10);
    const totalFiles = chunks.reduce((n, c) => n + c.length, 0);
    let doneFiles = 0;

    for (let zi = 0; zi < chunks.length; zi++) {
      const part = chunks[zi];
      const entries: Array<{ name: string; data: Uint8Array }> = [];
      for (const f of part) {
        doneFiles++;
        this.setStatus(`ZIP ${zi + 1}/${chunks.length} · file ${doneFiles}/${totalFiles} · ${f.filename}…`);
        await new Promise((r) => setTimeout(r, 0));
        const r = generateLtcWav({
          startTc: f.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
          durationSec: f.durationSec, sampleRate: this.s.sampleRate, level: this.s.level,
        });
        entries.push({ name: this.ensureWav(f.filename), data: r.wav });
      }
      this.setStatus(`ZIP ${zi + 1}/${chunks.length} · packing…`);
      await new Promise((r) => setTimeout(r, 0));
      const zip = buildZip(entries);
      const suffix = chunks.length === 1 ? "" : `_part${String(zi + 1).padStart(2, "0")}`;
      this.download(zip, `ltc_${dateStamp}${suffix}.zip`, "application/zip");
      // Release the bytes between parts so RAM doesn't pile up.
      entries.length = 0;
      await new Promise((r) => setTimeout(r, 100));
    }
    this.setStatus(`Saved ${totalFiles} files across ${chunks.length} ZIP${chunks.length > 1 ? "s" : ""}.`);
  }

  private download(data: Uint8Array, filename: string, mime: string): void {
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    const blob = new Blob([ab], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
