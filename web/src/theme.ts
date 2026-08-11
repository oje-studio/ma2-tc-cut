// Design tokens — vendored from the ØJE CUE MONITOR / desktop app theme.py.
// Canvas drawing reads these as strings; the DOM reads the mirror in styles.css.

export const BG_APP = "#0a0a0a";
export const BG_SURFACE = "#121212";
export const BG_RAISED = "#191919";
export const BG_HOVER = "#1f1f1f";
export const BG_INPUT = "#121212";
export const BG_HEADER = "#000000";

export const TEXT_PRIMARY = "#ffffff";
export const TEXT_BRIGHT = "#ffffff";
export const TEXT_MUTED = "#a8a8a8";
export const TEXT_DIM = "#818181";
export const TEXT_DISABLED = "#5c5c5c";

export const BORDER_SUBTLE = "#1f1f1f";
export const BORDER = "#2b2b2b";
export const BORDER_STRONG = "#5c5c5c";

export const SEMANTIC_DANGER = "#E5484D";
export const SEMANTIC_WARNING = "#F5A524";
export const SEMANTIC_WARNING_HOVER = "#FFBE4D";
export const SEMANTIC_SUCCESS = "#36B37E";
export const SEMANTIC_INFO = "#7AB7FF";
export const SEMANTIC_INFO_HOVER = "#93C5FD";
export const SEMANTIC_INFO_ACTIVE = "#5A96D6";

// Brand accent + primary action — ØJE coral (was green).
export const ACTION_PRIMARY = "#FF6B5E";
export const ACTION_PRIMARY_HOVER = "#FF5647";
export const ACTION_PRIMARY_ACTIVE = "#F04334";

export const OPERATOR_LIGHTING = "#85B7EB"; // cues, active toggles
export const OPERATOR_AUDIO = "#EF9F27"; // metronome / AUTO / audio band

export const GRID_BAR = "#2b2b2b"; // dim bar grid line
export const GRID_PHRASE = BORDER_STRONG; // brighter phrase line (every 4 bars)

export const FONT_MONO = '"SF Mono", "Menlo", "Roboto Mono", ui-monospace, monospace';
export const FONT_SANS = '"Cygre", "Helvetica Neue", "Inter", system-ui, -apple-system, sans-serif';

export function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
