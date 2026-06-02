// Rotary volume knob, 0–200% with a center detent at 100%. Canvas-drawn,
// retina-aware. Mirrors VolumeKnob in gui.py.
import * as t from "../theme.ts";

const SIZE = 40;

export class VolumeKnob {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private val = 100;
  private dragY: number | null = null;
  private dragV = 100;
  onChange: (v: number) => void = () => {};

  constructor() {
    const c = document.createElement("canvas");
    c.className = "knob";
    c.tabIndex = 0;
    c.setAttribute("role", "slider");
    c.setAttribute("aria-label", "Volume");
    c.setAttribute("aria-valuemin", "0");
    c.setAttribute("aria-valuemax", "200");
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    c.style.width = `${SIZE}px`;
    c.style.height = `${SIZE}px`;
    this.ctx = c.getContext("2d")!;
    this.ctx.scale(dpr, dpr);
    this.el = c;

    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.dragY = e.clientY;
      this.dragV = this.val;
    });
    c.addEventListener("pointermove", (e) => {
      if (this.dragY !== null) this.set(this.dragV + (this.dragY - e.clientY) * 1.5);
    });
    c.addEventListener("pointerup", () => (this.dragY = null));
    c.addEventListener("dblclick", () => this.set(100));
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.set(this.val + (e.deltaY < 0 ? 5 : -5));
    }, { passive: false });
    c.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        this.set(this.val + 5);
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        this.set(this.val - 5);
        e.preventDefault();
      }
    });
    this.draw();
  }

  value(): number {
    return this.val;
  }

  setValue(v: number): void {
    this.val = Math.max(0, Math.min(200, Math.round(v)));
    this.el.setAttribute("aria-valuenow", String(this.val));
    this.draw();
  }

  private set(v: number): void {
    const nv = Math.max(0, Math.min(200, Math.round(v)));
    if (nv !== this.val) {
      this.val = nv;
      this.el.setAttribute("aria-valuenow", String(this.val));
      this.onChange(this.val);
    }
    this.draw();
  }

  private draw(): void {
    const c = this.ctx;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const r = SIZE / 2 - 4;
    const frac = this.val / 200;
    c.clearRect(0, 0, SIZE, SIZE);

    // track: 270° from 7:30 (225°) clockwise to 4:30 (-45°)
    const a0 = (225 * Math.PI) / 180;
    c.lineCap = "round";
    c.lineWidth = 3;
    c.strokeStyle = t.BORDER;
    c.beginPath();
    c.arc(cx, cy, r, -a0, -a0 + (270 * Math.PI) / 180, false);
    c.stroke();

    // value arc
    const accent = this.val === 100 ? t.SEMANTIC_INFO : this.val < 100 ? t.ACTION_PRIMARY : t.SEMANTIC_WARNING;
    c.strokeStyle = accent;
    c.beginPath();
    c.arc(cx, cy, r, -a0, -a0 + (270 * frac * Math.PI) / 180, false);
    c.stroke();

    // pointer dot
    const ang = (Math.PI / 180) * (225 - 270 * frac);
    const rr = r - 2;
    const px = cx + rr * Math.cos(ang);
    const py = cy - rr * Math.sin(ang);
    c.fillStyle = t.TEXT_BRIGHT;
    c.beginPath();
    c.arc(px, py, 3, 0, Math.PI * 2);
    c.fill();
  }
}
