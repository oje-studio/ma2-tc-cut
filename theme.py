"""
Design tokens for ØJE CUE MONITOR.

Single source of truth for colors, spacing, radii, and type. Both the
Qt desktop app (via direct imports) and the web remote (via
`to_css_vars()`) read from here so the two surfaces stay in sync.

Conventions:
  * Colors are hex strings ("#rrggbb"); use `with_alpha()` for QSS
    rgba() strings when you need transparency.
  * Spacing / radii are integer pixels.
  * Operator role colors fall back to a cycle palette for unknown
    role names (so old `.ojeshow` files keep rendering).
"""
from __future__ import annotations

from typing import Dict


# ── Backgrounds ───────────────────────────────────────────────────────
BG_APP        = "#0f0f0f"   # window / app background
BG_SURFACE    = "#1a1a1a"   # cards, panels, table bg
BG_RAISED     = "#242424"   # hover, raised buttons
BG_OVERLAY    = "#000000"   # modal backdrop (use with_alpha)
BG_INPUT      = "#1e1e1e"   # text inputs, combos
BG_HEADER     = "#161616"   # status bars, table header

# ── Text ──────────────────────────────────────────────────────────────
TEXT_PRIMARY  = "#f0f0f0"   # body / cue names
TEXT_BRIGHT   = "#ffffff"   # commands in performance view, brand mark
TEXT_MUTED    = "#a5a5a5"   # secondary labels, past cues
TEXT_DIM      = "#6a6a6a"   # tertiary, separators
TEXT_DISABLED = "#4a4a4a"

# ── Borders / dividers ────────────────────────────────────────────────
BORDER_SUBTLE = "#2a2a2a"
BORDER        = "#3a3a3a"
BORDER_STRONG = "#4a4a4a"

# ── Semantic state ────────────────────────────────────────────────────
SEMANTIC_DANGER  = "#E5484D"   # record, stop, errors
SEMANTIC_WARNING = "#F5A524"   # DUP badge, warnings, attention
SEMANTIC_SUCCESS = "#36B37E"   # active cue border, ready, START
SEMANTIC_INFO    = "#7AB7FF"   # info, links, neutral highlight

# Apply button — solid, brighter green than the active-cue green so it
# reads as the primary call-to-action without competing with the
# in-table "this cue is live" signal.
ACTION_PRIMARY      = "#2EBD6B"
ACTION_PRIMARY_HOVER = "#37D079"

# ── Operator role colors ──────────────────────────────────────────────
# Semantic per-role colors. Names are matched case-insensitively; the
# alias map covers common short forms found in existing show files.
OPERATOR_LIGHTING = "#85B7EB"   # blue
OPERATOR_AUDIO    = "#EF9F27"   # amber
OPERATOR_STAGEMGR = "#AFA9EC"   # purple

# Fallback cycle for roles we don't recognise — keeps old files
# rendering with stable, distinct colors.
OPERATOR_FALLBACK_CYCLE = (
    "#E89B6A",  # peach
    "#7AC9A6",  # teal
    "#D78BC1",  # rose
    "#C8B97A",  # tan (matches existing section divider)
    "#9DBE6F",  # olive
)

_OPERATOR_ALIASES: Dict[str, str] = {
    "lighting":       OPERATOR_LIGHTING,
    "lights":         OPERATOR_LIGHTING,
    "lx":             OPERATOR_LIGHTING,
    "light":          OPERATOR_LIGHTING,
    "audio":          OPERATOR_AUDIO,
    "sound":          OPERATOR_AUDIO,
    "snd":            OPERATOR_AUDIO,
    "stage manager":  OPERATOR_STAGEMGR,
    "stage mgr":      OPERATOR_STAGEMGR,
    "sm":             OPERATOR_STAGEMGR,
    "stage":          OPERATOR_STAGEMGR,
}


def operator_color(role: str, all_roles: tuple[str, ...] | list[str] = ()) -> str:
    """
    Resolve a role name to its semantic color, or to a stable fallback
    from the cycle palette based on its position in `all_roles`.

    `all_roles` lets the fallback be deterministic across renders even
    if the same unknown role appears multiple times. Pass the full
    operator list from settings if you have it; otherwise the fallback
    is hash-based (still stable per role name).
    """
    key = (role or "").strip().lower()
    if key in _OPERATOR_ALIASES:
        return _OPERATOR_ALIASES[key]
    if all_roles:
        unknown = [r for r in all_roles
                   if r.strip().lower() not in _OPERATOR_ALIASES]
        if role in unknown:
            return OPERATOR_FALLBACK_CYCLE[
                unknown.index(role) % len(OPERATOR_FALLBACK_CYCLE)
            ]
    return OPERATOR_FALLBACK_CYCLE[
        abs(hash(key)) % len(OPERATOR_FALLBACK_CYCLE)
    ]


# ── Cue row tints (active / past / DUP) ───────────────────────────────
# Subtle 7% tints so the row reads as "category X" without overpowering
# the cue name. Used as table-cell backgrounds.
CUE_TINT_ACTIVE = "rgba(54, 179, 126, 0.14)"   # green, slightly stronger
CUE_TINT_DUP    = "rgba(245, 165, 36, 0.10)"   # amber
CUE_TINT_PAST   = "rgba(255, 255, 255, 0.03)"  # near-zero, just a hint

# Border accents alongside the tints.
CUE_BORDER_ACTIVE = SEMANTIC_SUCCESS    # 3px left/full border
CUE_BORDER_DUP    = SEMANTIC_WARNING    # 3px left border

# ── Section divider ───────────────────────────────────────────────────
# Neutral grey rather than the previous tan — sits quieter under the
# operator color dots and the cue-count chip.
SECTION_BG     = "#262626"
SECTION_BORDER = "#3a3a3a"
SECTION_TEXT   = "#cfcfcf"
SECTION_COUNT_BG   = "#1a1a1a"
SECTION_COUNT_TEXT = "#9a9a9a"

# ── Spacing scale (px) ────────────────────────────────────────────────
SPACE_1  = 2
SPACE_2  = 4
SPACE_3  = 8
SPACE_4  = 12
SPACE_5  = 16
SPACE_6  = 24
SPACE_7  = 32
SPACE_8  = 48

# ── Border radii (px) ─────────────────────────────────────────────────
RADIUS_SM = 4
RADIUS_MD = 6
RADIUS_LG = 10
RADIUS_PILL = 999

# ── Type scale (point sizes for Qt; rem-equivalents for web) ──────────
FONT_XS    = 10
FONT_SM    = 11
FONT_BASE  = 12
FONT_MD    = 14
FONT_LG    = 16
FONT_XL    = 20
FONT_2XL   = 28
FONT_HERO  = 48   # cue card command in performance view
FONT_TC    = 22   # timecode in header

WEIGHT_REGULAR = 400
WEIGHT_MEDIUM  = 500
WEIGHT_SEMIBOLD = 600
WEIGHT_BOLD    = 700

# ── Brand ─────────────────────────────────────────────────────────────
# The brand mark is the studio "Ø" glyph from assets/logo_src.png,
# rendered tinted to BRAND_MARK_COLOR.  No background fill — the
# glyph itself is the mark and lives directly on the dark header.
BRAND_MARK_COLOR = "#ffffff"
BRAND_MARK_SIZE  = 26


# ── Helpers ───────────────────────────────────────────────────────────
def with_alpha(hex_color: str, alpha: float) -> str:
    """`#rrggbb` + alpha → `rgba(r, g, b, a)` for QSS / CSS."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha:g})"


def to_css_vars() -> str:
    """
    Emit a `:root { --token: value; ... }` block for the web remote.
    Keep names kebab-case mirrors of the Python identifiers so a quick
    grep finds both surfaces.
    """
    pairs = {
        "bg-app":        BG_APP,
        "bg-surface":    BG_SURFACE,
        "bg-raised":     BG_RAISED,
        "bg-input":      BG_INPUT,
        "bg-header":     BG_HEADER,

        "text-primary":  TEXT_PRIMARY,
        "text-bright":   TEXT_BRIGHT,
        "text-muted":    TEXT_MUTED,
        "text-dim":      TEXT_DIM,
        "text-disabled": TEXT_DISABLED,

        "border-subtle": BORDER_SUBTLE,
        "border":        BORDER,
        "border-strong": BORDER_STRONG,

        "danger":        SEMANTIC_DANGER,
        "warning":       SEMANTIC_WARNING,
        "success":       SEMANTIC_SUCCESS,
        "info":          SEMANTIC_INFO,

        "action":        ACTION_PRIMARY,
        "action-hover":  ACTION_PRIMARY_HOVER,

        "op-lighting":   OPERATOR_LIGHTING,
        "op-audio":      OPERATOR_AUDIO,
        "op-stagemgr":   OPERATOR_STAGEMGR,

        "section-bg":     SECTION_BG,
        "section-border": SECTION_BORDER,
        "section-text":   SECTION_TEXT,

        "radius-sm":   f"{RADIUS_SM}px",
        "radius-md":   f"{RADIUS_MD}px",
        "radius-lg":   f"{RADIUS_LG}px",
        "radius-pill": f"{RADIUS_PILL}px",

        "space-1": f"{SPACE_1}px",
        "space-2": f"{SPACE_2}px",
        "space-3": f"{SPACE_3}px",
        "space-4": f"{SPACE_4}px",
        "space-5": f"{SPACE_5}px",
        "space-6": f"{SPACE_6}px",
        "space-7": f"{SPACE_7}px",
        "space-8": f"{SPACE_8}px",
    }
    body = "\n".join(f"  --{k}: {v};" for k, v in pairs.items())
    return ":root {\n" + body + "\n}"
