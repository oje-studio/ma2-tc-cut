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

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ltc-tool";
    this.render();
  }

  // ---- TC mask -----------------------------------------------------------
  /** Live mask: strip non-digits, re-insert colons every 2 digits, cap to slots. */
  private formatTcLive(raw: string, slots: 6 | 8): string {
    const digits = raw.replace(/[^\d]/g, "").slice(0, slots);
    let out = "";
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && i % 2 === 0) out += ":";
      out += digits[i];
    }
    return out;
  }
  /** Pad a partial TC to canonical form on blur (e.g. "1:2" → "00:00:01:02"). */
  private formatTcCanonical(raw: string, slots: 6 | 8): string {
    const digits = raw.replace(/[^\d]/g, "").slice(0, slots).padStart(slots, "0");
    const parts: string[] = [];
    for (let i = 0; i < digits.length; i += 2) parts.push(digits.slice(i, i + 2));
    return parts.join(":");
  }
  /** Wire input mask + blur-normalize. `onCommit` fires on every keystroke. */
  private wireTcInput(
    input: HTMLInputElement, slots: 6 | 8,
    onCommit: (value: string) => void,
  ): void {
    input.addEventListener("input", () => {
      const caretEnd = input.selectionEnd ?? input.value.length;
      const before = input.value;
      const masked = this.formatTcLive(before, slots);
      input.value = masked;
      // best-effort caret restore: keep at the end of the digit run we typed
      const digitsBefore = before.slice(0, caretEnd).replace(/[^\d]/g, "").length;
      const newCaret = Math.min(masked.length, digitsBefore + Math.floor((digitsBefore - 1) / 2));
      try { input.setSelectionRange(newCaret, newCaret); } catch {/**/}
      onCommit(masked);
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
      class: "ltc-wave", width: "1200", height: "120",
      "aria-label": "LTC waveform preview (first 2 frames)",
    }) as HTMLCanvasElement;

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
        this.preview,
        this.waveCanvas,
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

      this.setStatus("Rendering preview…");
      // Yield so the status flushes before the (small) blocking render.
      await new Promise((r) => setTimeout(r, 0));
      const r = renderLtcPcm({
        startTc: this.s.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: this.s.durationSec, sampleRate: this.s.sampleRate, level: this.s.level,
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
      if (this.playBtn) { this.playBtn.textContent = "◼ Stop"; this.playBtn.classList.add("on"); }
      this.setStatus(`Playing ${this.s.startTc} → ${r.endTc} (${r.frames} frames)`);
    } catch (err) {
      this.setStatus("⚠ " + (err as Error).message);
      this.stopPlay();
    }
  }
  private stopPlay(): void {
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
    b.addEventListener("click", () => { this.s.mode = mode; this.render(); });
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
  }

  // ---- waveform canvas -------------------------------------------------
  private drawWave(): void {
    if (!this.waveCanvas) return;
    const cv = this.waveCanvas;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // Sharp pixels on retina
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 1200;
    const cssH = cv.clientHeight || 120;
    if (cv.width !== Math.round(cssW * dpr)) {
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // Background grid: midline + 80 bit markers spanning frame 1.
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, cssW, cssH);

    let pcm: Int16Array | null = null;
    const fpsActual = this.s.fps === 29.97 ? 29.97 : Math.round(this.s.fps);
    // ~1.5 frames at 8 kHz — coarse enough that BMC cells render as crisp
    // square steps (~6 px wide) rather than a noisy barcode.
    const previewSr = 8000;
    const previewSec = 1.5 / fpsActual;
    try {
      const r = renderLtcPcm({
        startTc: this.s.mode === "single" ? this.s.startTc : this.s.rangeStart + ":00",
        fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: previewSec, sampleRate: previewSr,
        level: Math.max(0.05, this.s.level), // mirror the user's level visually
      });
      pcm = r.pcm;
    } catch {
      // Bad TC etc. — just draw the empty canvas.
    }

    // Centerline
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssH / 2);
    ctx.lineTo(cssW, cssH / 2);
    ctx.stroke();

    if (!pcm || pcm.length === 0) {
      ctx.fillStyle = "#6a6a6a";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.fillText("waveform unavailable — check TC", 12, cssH / 2 - 8);
      return;
    }

    // Frame boundary markers (vertical dim line per full frame, sync-word tick at 80%)
    const samplesPerFrameP = previewSr / fpsActual;
    ctx.strokeStyle = "#2a2a2a";
    for (let f = 1; (f * samplesPerFrameP) < pcm.length; f++) {
      const x = (f * samplesPerFrameP / pcm.length) * cssW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    }
    // Sync-word tick (last 16/80 bits of every frame)
    ctx.strokeStyle = "rgba(245, 165, 36, 0.18)";
    for (let f = 0; (f * samplesPerFrameP) < pcm.length; f++) {
      const xs = ((f + 0.8) * samplesPerFrameP / pcm.length) * cssW;
      const xe = ((f + 1.0) * samplesPerFrameP / pcm.length) * cssW;
      ctx.fillStyle = "rgba(245, 165, 36, 0.07)";
      ctx.fillRect(Math.min(xs, cssW), 0, Math.max(0, Math.min(xe, cssW) - xs), cssH);
    }

    // Waveform — amber square wave
    ctx.strokeStyle = "#f5a524";
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "miter";
    ctx.lineCap = "square";
    ctx.beginPath();
    const margin = 12;
    const amp = (cssH - margin * 2) / 2;
    const mid = cssH / 2;
    const step = pcm.length / cssW;
    for (let x = 0; x < cssW; x++) {
      const i = Math.min(pcm.length - 1, Math.floor(x * step));
      const v = pcm[i] / 32767;
      const y = mid - v * amp;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Tiny axis labels, with a dark scrim so the waveform doesn't bleed through.
    ctx.font = "11px ui-monospace, Menlo, monospace";
    const lbl = `frame ${this.s.mode === "single" ? this.s.startTc : this.s.rangeStart + ":00"}`;
    const lblW = ctx.measureText(lbl).width;
    ctx.fillStyle = "rgba(22, 22, 22, 0.85)";
    ctx.fillRect(4, cssH - 18, lblW + 10, 16);
    ctx.fillRect(cssW - 44, cssH - 18, 40, 16);
    ctx.fillStyle = "#a5a5a5";
    ctx.fillText(lbl, 9, cssH - 6);
    ctx.fillText("sync", cssW - 38, cssH - 6);
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
