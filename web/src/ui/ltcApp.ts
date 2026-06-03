// LTC Generator — single + batch SMPTE timecode WAV exporter.
// Pure DOM, no framework; matches the rest of the site's vanilla style.

import { generateLtcWav, planBatch, buildZip, type BatchSpec, type PlannedFile } from "../core/ltc.ts";

type Fps = 24 | 25 | 29.97 | 30;

interface State {
  mode: "single" | "batch";
  fps: Fps;
  dropFrame: boolean;
  sampleRate: 22050 | 44100 | 48000;
  level: number;
  // single
  startTc: string;
  durationSec: number;
  filename: string;
  // batch
  rangeStart: string;
  rangeEnd: string;
  intervalSec: number;
  batchDurationSec: number;
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
  filename: "ltc_00-00-00.wav",
  rangeStart: "00:00:00",
  rangeEnd: "23:59:00",
  intervalSec: 1800,
  batchDurationSec: 1500,
  filenamePattern: "ltc_{hh}-{mm}.wav",
};

export class LtcApp {
  readonly el: HTMLElement;
  private s: State = { ...DEFAULTS };
  private preview!: HTMLElement;
  private genBtn!: HTMLButtonElement;
  private status!: HTMLElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "ltc-tool";
    this.render();
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

  // ---- render ----
  private render(): void {
    const h = this.h.bind(this);

    // header (like MA2 tool — brand + tabs)
    const tabSingle = h("button", { class: "seg" + (this.s.mode === "single" ? " active" : ""), type: "button" }, "Single file");
    const tabBatch = h("button", { class: "seg" + (this.s.mode === "batch" ? " active" : ""), type: "button" }, "Batch");
    tabSingle.addEventListener("click", () => { this.s.mode = "single"; this.render(); });
    tabBatch.addEventListener("click", () => { this.s.mode = "batch"; this.render(); });
    const tabs = h("div", { class: "seg-row" }, tabSingle, tabBatch);

    // shared options
    const fpsSel = h("select", { class: "ltc-select", "aria-label": "Frame rate" });
    for (const v of [24, 25, 29.97, 30] as const) {
      const o = h("option", { value: String(v) }, v === 29.97 ? "29.97" : String(v));
      if (this.s.fps === v) o.setAttribute("selected", "");
      fpsSel.append(o);
    }
    fpsSel.addEventListener("change", () => {
      this.s.fps = parseFloat(fpsSel.value) as Fps;
      if (this.s.fps !== 29.97) this.s.dropFrame = false;
      this.render();
    });
    const dfChk = h("input", { type: "checkbox", id: "ltc-df" });
    if (this.s.dropFrame) dfChk.setAttribute("checked", "");
    if (this.s.fps !== 29.97) dfChk.setAttribute("disabled", "");
    dfChk.addEventListener("change", () => { this.s.dropFrame = (dfChk as HTMLInputElement).checked; this.updatePreview(); });
    const dfWrap = h("label", { class: "ltc-check", for: "ltc-df" }, dfChk, h("span", {}, "Drop-frame (29.97 only)"));

    const srSel = h("select", { class: "ltc-select", "aria-label": "Sample rate" });
    for (const v of [22050, 44100, 48000] as const) {
      const o = h("option", { value: String(v) }, `${(v / 1000).toFixed(v === 22050 ? 2 : 1)} kHz`);
      if (this.s.sampleRate === v) o.setAttribute("selected", "");
      srSel.append(o);
    }
    srSel.addEventListener("change", () => { this.s.sampleRate = parseInt(srSel.value) as 22050 | 44100 | 48000; this.updatePreview(); });

    const levelInput = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(this.s.level), class: "ltc-range", "aria-label": "Level" });
    const levelOut = h("span", { class: "ltc-range-out" }, `${Math.round(this.s.level * 100)}% (${(20 * Math.log10(this.s.level)).toFixed(1)} dBFS)`);
    levelInput.addEventListener("input", () => {
      this.s.level = parseFloat((levelInput as HTMLInputElement).value);
      levelOut.textContent = `${Math.round(this.s.level * 100)}% (${(20 * Math.log10(this.s.level)).toFixed(1)} dBFS)`;
    });

    const optsCard = h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Output"),
      h("div", { class: "ltc-row" }, h("label", {}, "Frame rate"), fpsSel),
      h("div", { class: "ltc-row" }, h("label", {}, ""), dfWrap),
      h("div", { class: "ltc-row" }, h("label", {}, "Sample rate"), srSel),
      h("div", { class: "ltc-row" }, h("label", {}, "Level"), levelInput, levelOut),
    );

    // mode-specific card
    const modeCard = this.s.mode === "single" ? this.renderSingle() : this.renderBatch();

    // preview
    this.preview = h("pre", { class: "ltc-preview" }, "");
    this.updatePreview();

    // generate button + status
    this.status = h("div", { class: "ltc-status" }, "");
    this.genBtn = h("button", { class: "btn-cut", type: "button" }, this.s.mode === "single" ? "DOWNLOAD WAV" : "DOWNLOAD ZIP");
    this.genBtn.addEventListener("click", () => void this.generate());

    // mount
    this.el.replaceChildren(
      h("div", { class: "ltc-header" }, tabs),
      h("div", { class: "ltc-grid" }, modeCard, optsCard),
      h("div", { class: "ltc-preview-wrap" }, h("h3", { class: "ltc-card-h" }, "Preview"), this.preview),
      h("div", { class: "ltc-actions" }, this.genBtn, this.status),
    );
  }

  private renderSingle(): HTMLElement {
    const h = this.h.bind(this);
    const tcIn = h("input", { type: "text", class: "tc-input", value: this.s.startTc, spellcheck: "false", placeholder: "HH:MM:SS:FF" }) as HTMLInputElement;
    tcIn.addEventListener("input", () => { this.s.startTc = tcIn.value; this.updatePreview(); });
    const durIn = h("input", { type: "number", class: "tc-input", min: "1", step: "1", value: String(this.s.durationSec) }) as HTMLInputElement;
    durIn.addEventListener("input", () => { this.s.durationSec = parseFloat(durIn.value) || 0; this.updatePreview(); });
    const nameIn = h("input", { type: "text", class: "tc-input", value: this.s.filename, spellcheck: "false" }) as HTMLInputElement;
    nameIn.addEventListener("input", () => { this.s.filename = nameIn.value; });

    return h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Single file"),
      h("div", { class: "ltc-row" }, h("label", {}, "Start TC"), tcIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Duration (s)"), durIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Filename"), nameIn),
    );
  }

  private renderBatch(): HTMLElement {
    const h = this.h.bind(this);
    const startIn = h("input", { type: "text", class: "tc-input", value: this.s.rangeStart, placeholder: "HH:MM:SS" }) as HTMLInputElement;
    startIn.addEventListener("input", () => { this.s.rangeStart = startIn.value; this.updatePreview(); });
    const endIn = h("input", { type: "text", class: "tc-input", value: this.s.rangeEnd, placeholder: "HH:MM:SS" }) as HTMLInputElement;
    endIn.addEventListener("input", () => { this.s.rangeEnd = endIn.value; this.updatePreview(); });
    const intIn = h("input", { type: "number", class: "tc-input", min: "1", step: "1", value: String(this.s.intervalSec) }) as HTMLInputElement;
    intIn.addEventListener("input", () => { this.s.intervalSec = parseFloat(intIn.value) || 0; this.updatePreview(); });
    const durIn = h("input", { type: "number", class: "tc-input", min: "1", step: "1", value: String(this.s.batchDurationSec) }) as HTMLInputElement;
    durIn.addEventListener("input", () => { this.s.batchDurationSec = parseFloat(durIn.value) || 0; this.updatePreview(); });
    const patIn = h("input", { type: "text", class: "tc-input", value: this.s.filenamePattern, spellcheck: "false" }) as HTMLInputElement;
    patIn.addEventListener("input", () => { this.s.filenamePattern = patIn.value; this.updatePreview(); });

    return h("div", { class: "ltc-card" },
      h("h3", { class: "ltc-card-h" }, "Batch"),
      h("div", { class: "ltc-row" }, h("label", {}, "Range start"), startIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Range end"), endIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Interval (s)"), intIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Length each (s)"), durIn),
      h("div", { class: "ltc-row" }, h("label", {}, "Filename"), patIn),
      h("p", { class: "ltc-hint" }, "Filename tokens: {tc} {hh} {mm} {ss} {idx}"),
    );
  }

  // ---- preview ----
  private updatePreview(): void {
    if (!this.preview) return;
    const sec = (n: number) => n.toFixed(2).replace(/\.?0+$/, "") + " s";
    const sr = this.s.sampleRate;
    const fmt = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    try {
      if (this.s.mode === "single") {
        const bytes = Math.round(this.s.durationSec * sr * 2 + 44);
        const lines = [
          `1 file · ${sec(this.s.durationSec)} · ${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps · ${sr / 1000} kHz mono`,
          `${this.s.startTc}  →  ends ~${this.estimateEndTc()}`,
          `≈ ${fmt(bytes)} bytes  (${(bytes / 1048576).toFixed(1)} MB)`,
        ];
        this.preview.textContent = lines.join("\n");
        if (this.genBtn) this.genBtn.disabled = false;
        return;
      }
      const spec: BatchSpec = {
        rangeStart: this.s.rangeStart, rangeEnd: this.s.rangeEnd,
        intervalSec: this.s.intervalSec, durationSec: this.s.batchDurationSec,
        fps: this.s.fps, dropFrame: this.s.dropFrame, filenamePattern: this.s.filenamePattern,
      };
      const files = planBatch(spec);
      const eachBytes = Math.round(this.s.batchDurationSec * sr * 2 + 44);
      const totalBytes = eachBytes * files.length;
      const head = files.slice(0, 5).map((f) => `  ${f.filename}   ${f.startTc} → ${f.endTc}`);
      const tail = files.length > 8 ? [`  … ${files.length - 6} more …`, `  ${files[files.length - 1].filename}   ${files[files.length - 1].startTc} → ${files[files.length - 1].endTc}`] : [];
      const lines = [
        `${files.length} files · ${sec(this.s.batchDurationSec)} each · ${this.s.fps}${this.s.dropFrame ? " DF" : ""} fps · ${sr / 1000} kHz mono`,
        `every ${sec(this.s.intervalSec)} from ${this.s.rangeStart} to ${this.s.rangeEnd}`,
        `≈ ${fmt(eachBytes)} B each · ${(totalBytes / 1048576).toFixed(1)} MB total (ZIP, no compression)`,
        "",
        ...head, ...tail,
      ];
      this.preview.textContent = lines.join("\n");
      if (this.genBtn) {
        this.genBtn.disabled = false;
        // warn for >2 GB batches — most browsers struggle past that in memory
        if (totalBytes > 2 * 1024 ** 3) {
          this.preview.textContent += `\n\n⚠ Large total — over 2 GB may run out of memory. Consider a higher interval or a lower sample rate.`;
        }
      }
    } catch (err) {
      this.preview.textContent = "⚠ " + (err as Error).message;
      if (this.genBtn) this.genBtn.disabled = true;
    }
  }

  private estimateEndTc(): string {
    try {
      const r = generateLtcWav({
        startTc: this.s.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: Math.min(this.s.durationSec, 1), sampleRate: 8000, level: 0.01,
      });
      // Re-estimate end manually using the math from the core (avoid rendering full audio for preview)
      void r;
    } catch { /* preview-only */ }
    // Cheaper: just compute end TC inline. Mirror the same nominal-fps math.
    const isDf = this.s.dropFrame && Math.abs(this.s.fps - 29.97) < 0.01;
    const fpsNom = isDf ? 30 : Math.round(this.s.fps);
    const fpsActual = isDf ? 30000 / 1001 : this.s.fps;
    const startFrames = this.tcToFramesLocal(this.s.startTc, fpsNom, isDf);
    const endFr = startFrames + Math.round(this.s.durationSec * fpsActual) - 1;
    return this.framesToTcLocal(endFr, fpsNom, isDf);
  }
  // Local mirrors so we don't expose more from core; small enough.
  private tcToFramesLocal(tc: string, fpsNom: number, df: boolean): number {
    const m = tc.match(/^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/); if (!m) return 0;
    const [h, mi, s, f] = [+m[1], +m[2], +m[3], +m[4]];
    if (!df) return ((h * 60 + mi) * 60 + s) * fpsNom + f;
    const tm = h * 60 + mi;
    return ((h * 60 + mi) * 60 + s) * 30 + f - 2 * (tm - Math.floor(tm / 10));
  }
  private framesToTcLocal(fr: number, fpsNom: number, df: boolean): string {
    const p2 = (n: number) => String(n).padStart(2, "0");
    if (!df) {
      const f = fr % fpsNom; let total = Math.floor(fr / fpsNom);
      const s = total % 60; total = Math.floor(total / 60);
      const mi = total % 60; const h = Math.floor(total / 60);
      return `${p2(h)}:${p2(mi)}:${p2(s)}:${p2(f)}`;
    }
    const FP10 = 17982, FPM = 1798;
    const d = Math.floor(fr / FP10), n = fr % FP10;
    fr = n < 2 ? fr + 9 * 2 * d : fr + 9 * 2 * d + 2 * Math.floor((n - 2) / FPM);
    const f = fr % 30; let total = Math.floor(fr / 30);
    const s = total % 60; total = Math.floor(total / 60);
    const mi = total % 60; const h = Math.floor(total / 60);
    return `${p2(h)}:${p2(mi)}:${p2(s)};${p2(f)}`;
  }

  // ---- generate ----
  private setStatus(t: string): void { if (this.status) this.status.textContent = t; }
  private async generate(): Promise<void> {
    this.genBtn.disabled = true;
    try {
      if (this.s.mode === "single") {
        this.setStatus("Rendering…");
        const r = generateLtcWav({
          startTc: this.s.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
          durationSec: this.s.durationSec, sampleRate: this.s.sampleRate, level: this.s.level,
        });
        this.download(r.wav, this.s.filename || "ltc.wav", "audio/wav");
        this.setStatus(`Saved ${this.s.filename} · ${r.frames} frames · ends ${r.endTc}`);
      } else {
        const files = planBatch({
          rangeStart: this.s.rangeStart, rangeEnd: this.s.rangeEnd,
          intervalSec: this.s.intervalSec, durationSec: this.s.batchDurationSec,
          fps: this.s.fps, dropFrame: this.s.dropFrame, filenamePattern: this.s.filenamePattern,
        });
        await this.generateBatch(files);
      }
    } catch (err) {
      this.setStatus("⚠ " + (err as Error).message);
    } finally {
      this.genBtn.disabled = false;
    }
  }

  private async generateBatch(files: PlannedFile[]): Promise<void> {
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      this.setStatus(`Rendering ${i + 1}/${files.length} · ${f.filename}…`);
      // yield to the UI so the status updates
      await new Promise((r) => setTimeout(r, 0));
      const r = generateLtcWav({
        startTc: f.startTc, fps: this.s.fps, dropFrame: this.s.dropFrame,
        durationSec: f.durationSec, sampleRate: this.s.sampleRate, level: this.s.level,
      });
      entries.push({ name: f.filename, data: r.wav });
    }
    this.setStatus("Packing ZIP…");
    await new Promise((r) => setTimeout(r, 0));
    const zip = buildZip(entries);
    const dateStamp = new Date().toISOString().slice(0, 10);
    this.download(zip, `ltc_${dateStamp}.zip`, "application/zip");
    this.setStatus(`Saved ${entries.length} files in ZIP.`);
  }

  private download(data: Uint8Array, filename: string, mime: string): void {
    // copy bytes into a fresh ArrayBuffer so the Blob always sees a real ArrayBuffer
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
