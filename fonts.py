"""Platform-aware font families for monospace and sans-serif text.

PySide6 port of the oje-cue-monitor helper (same families, so the two apps
read identically). Kept dependency-light: only QtGui.
"""
from __future__ import annotations

import platform

from PySide6.QtGui import QFont


def _families(mono: bool) -> list[str]:
    system = platform.system()
    if mono:
        if system == "Darwin":
            return ["Menlo", "Monaco", "Courier New"]
        if system == "Windows":
            return ["Consolas", "Cascadia Mono", "Courier New"]
        return ["DejaVu Sans Mono", "Liberation Mono", "Courier New"]
    if system == "Darwin":
        return ["Helvetica Neue", "Helvetica"]
    if system == "Windows":
        return ["Segoe UI", "Arial"]
    return ["Noto Sans", "DejaVu Sans", "Arial"]


def mono_font(point_size: int = 12, bold: bool = False) -> QFont:
    f = QFont()
    f.setFamilies(_families(mono=True))
    f.setStyleHint(QFont.StyleHint.Monospace)
    f.setPointSize(point_size)
    f.setBold(bold)
    return f


def sans_font(point_size: int = 12, bold: bool = False) -> QFont:
    f = QFont()
    f.setFamilies(_families(mono=False))
    f.setStyleHint(QFont.StyleHint.SansSerif)
    f.setPointSize(point_size)
    f.setBold(bold)
    return f
