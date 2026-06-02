// Design tokens — vendored from the ØJE CUE MONITOR / desktop app theme.py.
// Canvas drawing reads these as strings; the DOM reads the mirror in styles.css.

export const BG_APP = "#0f0f0f";
export const BG_SURFACE = "#1a1a1a";
export const BG_RAISED = "#242424";
export const BG_HOVER = "#2e2e2e";
export const BG_INPUT = "#1e1e1e";
export const BG_HEADER = "#161616";

export const TEXT_PRIMARY = "#f0f0f0";
export const TEXT_BRIGHT = "#ffffff";
export const TEXT_MUTED = "#a5a5a5";
export const TEXT_DIM = "#6a6a6a";
export const TEXT_DISABLED = "#4a4a4a";

export const BORDER_SUBTLE = "#2a2a2a";
export const BORDER = "#3a3a3a";
export const BORDER_STRONG = "#4a4a4a";

export const SEMANTIC_DANGER = "#E5484D";
export const SEMANTIC_WARNING = "#F5A524";
export const SEMANTIC_WARNING_HOVER = "#FFBE4D";
export const SEMANTIC_SUCCESS = "#36B37E";
export const SEMANTIC_INFO = "#7AB7FF";
export const SEMANTIC_INFO_HOVER = "#93C5FD";
export const SEMANTIC_INFO_ACTIVE = "#5A96D6";

export const ACTION_PRIMARY = "#2EBD6B";
export const ACTION_PRIMARY_HOVER = "#37D079";
export const ACTION_PRIMARY_ACTIVE = "#28A85E";

export const OPERATOR_LIGHTING = "#85B7EB"; // cues, active toggles
export const OPERATOR_AUDIO = "#EF9F27"; // metronome / AUTO / audio band

export const GRID_BAR = "#343434"; // dim bar grid line
export const GRID_PHRASE = BORDER_STRONG; // brighter phrase line (every 4 bars)

export const FONT_MONO = '"Menlo", "SF Mono", "Roboto Mono", ui-monospace, monospace';
export const FONT_SANS = '"Helvetica Neue", "Inter", system-ui, -apple-system, sans-serif';

export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
