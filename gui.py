#!/usr/bin/env python3
"""
MA2 Timecode Cut — desktop GUI (PySide6), styled to match ØJE CUE MONITOR.

Drop (or click) a grandMA2 timecode .xml on the cue area and an audio file on
the waveform; set the cut by timecode or by bars; scrub/play with a sample-
accurate metronome (mixed live into the stream — instant on/off); CUT! / UNCUT
to preview the edit on the file, then SAVE FILE.
"""
import os
import sys

import math

from PySide6.QtCore import Qt, QTimer, QPointF, QRectF, Signal
from PySide6.QtGui import (QPixmap, QPainter, QColor, QShortcut, QKeySequence,
                           QIcon, QPolygonF, QPen, QDoubleValidator)
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QGroupBox, QLabel, QLineEdit, QPushButton, QFileDialog, QPlainTextEdit,
    QRadioButton, QButtonGroup, QDoubleSpinBox, QSpinBox, QMessageBox, QFrame,
    QScrollArea, QStackedWidget, QDial,
)

from ma2_tc_cut import ripple_cut, frames_to_tc
import tcshow
import audio
import theme
from fonts import mono_font, sans_font
from timeline import TimelineWidget, AUDIO_EXT
from player import AudioEngine

APP_NAME = "MA2 Timecode Cut"
VERSION = "v0.1.0"
DASH_TC = "––:––:––:––"


class TCField(QLineEdit):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setInputMask("00:00:00:00;0"); self.setFont(mono_font(theme.FONT_MD)); self.setText("00:00:00:00")

    def frames(self, fps):
        parts = self.displayText().split(":")
        if len(parts) != 4 or not all(p.isdigit() for p in parts):
            return None
        h, m, s, f = (int(p) for p in parts)
        return ((h * 3600 + min(m, 59) * 60 + min(s, 59)) * fps) + min(f, fps - 1)

    def set_frames(self, fr, fps):
        s, f = divmod(int(fr), fps); h, s = divmod(s, 3600); m, s = divmod(s, 60)
        self.setText(f"{h:02}:{m:02}:{s:02}:{f:02}")


def asset_path(name):
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "assets", name)


def logo_pixmap(color_hex, size):
    src = QPixmap(asset_path("logo_src.png"))
    if src.isNull():
        return QPixmap()
    scaled = src.scaled(size * 2, size * 2, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    out = QPixmap(scaled.size()); out.fill(Qt.transparent)
    p = QPainter(out); p.drawPixmap(0, 0, scaled)
    p.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceIn)
    p.fillRect(out.rect(), QColor(color_hex)); p.end()
    return out


def metro_icon(color, size=20):
    pm = QPixmap(size, size); pm.fill(Qt.transparent)
    p = QPainter(pm); p.setRenderHint(QPainter.Antialiasing, True)
    c = QColor(color); w = h = size
    p.setPen(QPen(c, 1.5)); p.setBrush(Qt.NoBrush)
    p.drawPolygon(QPolygonF([QPointF(w * 0.34, h * 0.16), QPointF(w * 0.66, h * 0.16),
                             QPointF(w * 0.82, h * 0.88), QPointF(w * 0.18, h * 0.88)]))
    p.drawLine(QPointF(w * 0.5, h * 0.82), QPointF(w * 0.63, h * 0.26))
    p.setBrush(c); p.setPen(Qt.NoPen); p.drawEllipse(QPointF(w * 0.63, h * 0.26), 1.7, 1.7)
    p.end(); return pm


def brand_mark():
    w = QWidget(); lay = QHBoxLayout(w); lay.setContentsMargins(0, 0, 0, 0); lay.setSpacing(8)
    mark = QLabel(); mark.setFixedSize(theme.BRAND_MARK_SIZE, theme.BRAND_MARK_SIZE)
    mark.setPixmap(logo_pixmap(theme.BRAND_MARK_COLOR, theme.BRAND_MARK_SIZE)); mark.setScaledContents(True)
    lay.addWidget(mark, alignment=Qt.AlignVCenter)
    name = QLabel("TIMECODE CUT"); name.setFont(sans_font(13))
    name.setStyleSheet(f"color: {theme.TEXT_BRIGHT}; font-weight: 600; letter-spacing: 1.5px;")
    lay.addWidget(name, alignment=Qt.AlignVCenter)
    ver = QLabel(VERSION); ver.setFont(sans_font(11)); ver.setStyleSheet(f"color: {theme.TEXT_MUTED};")
    lay.addWidget(ver, alignment=Qt.AlignVCenter)
    return w


def dot_sep():
    s = QLabel("·"); s.setStyleSheet(f"color: {theme.TEXT_DIM}; font-size: 18px;"); return s


def panel():
    """A titleless surface card (replaces QGroupBox where the label is redundant)."""
    f = QFrame(); f.setObjectName("panel")
    f.setStyleSheet(f"QFrame#panel {{ background: {theme.BG_SURFACE}; "
                    f"border: 1px solid {theme.BORDER_SUBTLE}; border-radius: {theme.RADIUS_LG}px; }}")
    return f


def build_qss():
    t = theme
    return f"""
    QWidget {{ background: {t.BG_APP}; color: {t.TEXT_PRIMARY}; font-size: {t.FONT_BASE}pt; }}
    QGroupBox {{ background: {t.BG_SURFACE}; border: 1px solid {t.BORDER_SUBTLE};
        border-radius: {t.RADIUS_LG}px; margin-top: 14px; padding: 12px; }}
    QGroupBox::title {{ subcontrol-origin: margin; left: 12px; padding: 0 4px;
        color: {t.TEXT_DIM}; font-weight: 600; letter-spacing: 1px; }}
    QLabel {{ background: transparent; }}
    QLineEdit, QDoubleSpinBox, QSpinBox {{ background: {t.BG_INPUT}; color: {t.TEXT_PRIMARY};
        border: 1px solid {t.BORDER_STRONG}; border-radius: {t.RADIUS_MD}px; padding: 5px 8px;
        selection-background-color: {t.with_alpha(t.SEMANTIC_INFO, 0.35)}; }}
    QLineEdit:focus, QDoubleSpinBox:focus, QSpinBox:focus {{ border: 1px solid {t.SEMANTIC_INFO}; }}
    QPlainTextEdit {{ background: {t.BG_HEADER}; color: {t.TEXT_PRIMARY};
        border: 1px solid {t.BORDER_SUBTLE}; border-radius: {t.RADIUS_MD}px; padding: 8px; }}
    QRadioButton {{ background: transparent; spacing: 6px; }}
    QPushButton {{ background: {t.BG_RAISED}; color: {t.TEXT_PRIMARY};
        border: 1px solid {t.BORDER}; border-radius: {t.RADIUS_MD}px; padding: 7px 14px; }}
    QPushButton:hover {{ background: {t.BG_HOVER}; border-color: {t.BORDER_STRONG}; }}
    QPushButton:pressed {{ background: {t.BG_SURFACE}; }}
    QPushButton:focus {{ border: 1px solid {t.SEMANTIC_INFO}; }}
    QPushButton:disabled {{ color: {t.TEXT_DISABLED}; border-color: {t.BORDER_SUBTLE}; }}
    QScrollBar:vertical {{ background: {t.BG_APP}; width: 12px; margin: 0; }}
    QScrollBar::handle:vertical {{ background: {t.BORDER}; border-radius: {t.RADIUS_MD}px; min-height: 30px; }}
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
    QToolTip {{ background: {t.BG_RAISED}; color: {t.TEXT_PRIMARY}; border: 1px solid {t.BORDER}; }}
    """


def primary_btn_qss(bg, hover, press):
    return (f"QPushButton{{background:{bg};color:{theme.BG_APP};font-weight:700;letter-spacing:1px;"
            f"border:none;border-radius:{theme.RADIUS_MD}px;padding:10px 14px;}}"
            f"QPushButton:hover{{background:{hover};}}QPushButton:pressed{{background:{press};}}"
            f"QPushButton:focus{{border:2px solid {theme.TEXT_BRIGHT};}}"
            f"QPushButton:disabled{{background:{theme.BG_RAISED};color:{theme.TEXT_DISABLED};}}")


def secondary_btn_qss():
    t = theme
    return (f"QPushButton{{background:{t.BG_RAISED};color:{t.TEXT_MUTED};font-weight:600;"
            f"border:1px solid {t.BORDER};border-radius:{t.RADIUS_MD}px;padding:10px 14px;}}"
            f"QPushButton:hover{{background:{t.BG_HOVER};border-color:{t.BORDER_STRONG};}}"
            f"QPushButton:focus{{border-color:{t.SEMANTIC_INFO};}}"
            f"QPushButton:disabled{{color:{t.TEXT_DISABLED};border-color:{t.BORDER_SUBTLE};}}")


def seg_qss():
    t = theme
    return (f"QPushButton{{background:{t.BG_RAISED};color:{t.TEXT_MUTED};"
            f"border:1px solid {t.BORDER};border-radius:{t.RADIUS_SM}px;padding:5px 11px;}}"
            f"QPushButton:hover{{border-color:{t.BORDER_STRONG};}}"
            f"QPushButton:focus{{border-color:{t.SEMANTIC_INFO};}}"
            f"QPushButton:checked{{background:{t.with_alpha(t.SEMANTIC_INFO, 0.16)};"
            f"color:{t.SEMANTIC_INFO};border-color:{t.SEMANTIC_INFO};}}")


def seg_button(text, tip=""):
    b = QPushButton(text); b.setCheckable(True); b.setStyleSheet(seg_qss()); b.setFont(sans_font(theme.FONT_BASE))
    if tip:
        b.setToolTip(tip)
    return b


class VolumeKnob(QWidget):
    """Flat themed rotary knob, 0–200% with a center detent at 100%."""
    valueChanged = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._val = 100
        self.setFixedSize(40, 40)
        self.setCursor(Qt.SizeVerCursor)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setAccessibleName("Volume")
        self._drag_y = None
        self._drag_v = 100

    def value(self):
        return self._val

    def setValue(self, v):
        v = max(0, min(200, int(round(v))))
        if v != self._val:
            self._val = v
            self.valueChanged.emit(v)
        self.update()

    def mousePressEvent(self, e):
        self._drag_y = e.position().y(); self._drag_v = self._val

    def mouseMoveEvent(self, e):
        if self._drag_y is not None:
            self.setValue(self._drag_v + (self._drag_y - e.position().y()) * 1.5)

    def mouseReleaseEvent(self, e):
        self._drag_y = None

    def mouseDoubleClickEvent(self, e):
        self.setValue(100)

    def wheelEvent(self, e):
        self.setValue(self._val + (5 if e.angleDelta().y() > 0 else -5))

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key_Up, Qt.Key_Right):
            self.setValue(self._val + 5)
        elif e.key() in (Qt.Key_Down, Qt.Key_Left):
            self.setValue(self._val - 5)
        else:
            super().keyPressEvent(e)

    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.Antialiasing, True)
        r = QRectF(self.rect()).adjusted(4, 4, -4, -4)
        frac = self._val / 200.0
        # 270° track, 7:30 (225°) clockwise to 4:30 (-45°)
        pen = QPen(QColor(theme.BORDER), 3); pen.setCapStyle(Qt.RoundCap); p.setPen(pen)
        p.drawArc(r, 225 * 16, -270 * 16)
        accent = theme.SEMANTIC_INFO if self._val == 100 else (theme.ACTION_PRIMARY if self._val < 100 else theme.SEMANTIC_WARNING)
        pen2 = QPen(QColor(accent), 3); pen2.setCapStyle(Qt.RoundCap); p.setPen(pen2)
        p.drawArc(r, 225 * 16, int(-270 * frac) * 16)
        ang = math.radians(225 - 270 * frac)
        cx, cy = r.center().x(), r.center().y(); rr = r.width() / 2 - 2
        px, py = cx + rr * math.cos(ang), cy - rr * math.sin(ang)
        p.setBrush(QColor(theme.TEXT_BRIGHT)); p.setPen(Qt.NoPen)
        p.drawEllipse(QPointF(px, py), 3, 3)
        if self.hasFocus():
            p.setBrush(Qt.NoBrush); p.setPen(QPen(QColor(theme.SEMANTIC_INFO), 1.5))
            p.drawEllipse(QRectF(self.rect()).adjusted(1.5, 1.5, -1.5, -1.5))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setMinimumSize(900, 660)
        self.resize(1100, 880)
        self.in_path = self.audio_path = self.text = self.info = None
        self.has_bom = False
        self.fps = None
        self.anchor = 0
        self.applied_bpm = 0.0
        self._song = None
        self._undo = []
        self.setStyleSheet(build_qss())

        self.engine = AudioEngine(self)
        self.engine.positionChanged.connect(self._on_position)
        self.engine.stateChanged.connect(self._on_state)

        self._debounce = QTimer(self); self._debounce.setSingleShot(True)
        self._debounce.setInterval(120); self._debounce.timeout.connect(self._recompute)

        self._build()
        self._build_menu()
        self._set_loaded(False)
        self._sc = QShortcut(QKeySequence(Qt.Key_Space), self); self._sc.activated.connect(self._toggle_play)

    # ---------- UI ----------
    def _build(self):
        root = QWidget(); self.setCentralWidget(root)
        outer = QVBoxLayout(root); outer.setContentsMargins(0, 0, 0, 0); outer.setSpacing(0)

        header = QFrame(); header.setStyleSheet(f"background: {theme.BG_HEADER};")
        hv = QVBoxLayout(header); hv.setContentsMargins(16, 8, 16, 8); hv.setSpacing(8)

        # brand · transport + metronome (left-center) · snap · volume (far right)
        r1 = QHBoxLayout(); r1.setSpacing(8)
        r1.addWidget(brand_mark()); r1.addStretch(1)

        self.play_btn = QPushButton("▶"); self.play_btn.setFixedWidth(44); self.play_btn.clicked.connect(self._toggle_play)
        self.play_btn.setAccessibleName("Play / Pause")
        r1.addWidget(self.play_btn); r1.addWidget(dot_sep())
        self.tc_label = QLabel(DASH_TC); self.tc_label.setFont(mono_font(theme.FONT_TC, bold=True))
        self.tc_label.setStyleSheet(f"color: {theme.TEXT_BRIGHT}; letter-spacing: 2px;")
        r1.addWidget(self.tc_label); r1.addWidget(dot_sep())
        self.bar_label = QLabel(""); self.bar_label.setFont(mono_font(theme.FONT_SM, bold=True))
        self.bar_label.setStyleSheet(f"color: {theme.SEMANTIC_INFO}; letter-spacing: 1px;"); self.bar_label.setMinimumWidth(80)
        r1.addWidget(self.bar_label)
        r1.addSpacing(8)
        self.metro = QPushButton(); self.metro.setCheckable(True); self.metro.setEnabled(False)
        self.metro.setIcon(QIcon(metro_icon(theme.TEXT_MUTED))); self.metro.setToolTip("Metronome (click mixed into the song)")
        self.metro.setAccessibleName("Metronome")
        self.metro.setStyleSheet(
            f"QPushButton{{background:{theme.BG_RAISED};border:1px solid {theme.BORDER};"
            f"border-radius:{theme.RADIUS_SM}px;padding:4px 10px;}}"
            f"QPushButton:focus{{border-color:{theme.SEMANTIC_INFO};}}"
            f"QPushButton:checked{{background:{theme.SEMANTIC_WARNING};border-color:{theme.SEMANTIC_WARNING};}}")
        self.metro.toggled.connect(self._on_metro_toggled); r1.addWidget(self.metro)
        r1.addStretch(1)

        r1.addWidget(self._mk("Snap", theme.TEXT_MUTED))
        self.snap_grp = QButtonGroup(self)
        snapseg = (f"QPushButton{{background:{theme.BG_RAISED};color:{theme.TEXT_MUTED};"
                   f"border:1px solid {theme.BORDER};border-radius:{theme.RADIUS_SM}px;padding:4px 9px;}}"
                   f"QPushButton:hover{{border-color:{theme.BORDER_STRONG};}}"
                   f"QPushButton:focus{{border-color:{theme.SEMANTIC_INFO};}}"
                   f"QPushButton:checked{{background:{theme.with_alpha(theme.SEMANTIC_INFO, 0.16)};"
                   f"color:{theme.SEMANTIC_INFO};border-color:{theme.SEMANTIC_INFO};}}")
        for mode, glyph, tip in [("off", "○", "No snap"), ("bar", "▮", "Snap to bar"),
                                 ("beat", "♩", "Snap to beat"), ("sec", "⏱", "Snap to second")]:
            b = QPushButton(glyph); b.setCheckable(True); b.setToolTip(tip); b.setStyleSheet(snapseg)
            b.setAccessibleName(tip); b.setFont(sans_font(theme.FONT_MD))
            b.clicked.connect(lambda _=False, mm=mode: self.timeline.set_snap(mm))
            self.snap_grp.addButton(b); r1.addWidget(b)
            if mode == "off":
                b.setChecked(True)
        r1.addSpacing(16); r1.addWidget(self._mk("Vol", theme.TEXT_MUTED))
        self.vol = VolumeKnob(); self.vol.valueChanged.connect(self._on_volume); r1.addWidget(self.vol)
        self.vol_lbl = QLabel("100%"); self.vol_lbl.setFont(mono_font(theme.FONT_XS))
        self.vol_lbl.setStyleSheet(f"color: {theme.TEXT_MUTED};"); self.vol_lbl.setFixedWidth(40); r1.addWidget(self.vol_lbl)
        hv.addLayout(r1)
        outer.addWidget(header)

        body = QWidget(); v = QVBoxLayout(body); v.setContentsMargins(16, 12, 16, 10); v.setSpacing(12)
        scroll = QScrollArea(); scroll.setWidgetResizable(True); scroll.setFrameShape(QFrame.NoFrame)
        scroll.setWidget(body); outer.addWidget(scroll, 1)

        self.timeline = TimelineWidget()
        self.timeline.seekRequested.connect(self._seek_to_frame)
        self.timeline.showRequested.connect(self.browse_input)
        self.timeline.audioRequested.connect(lambda: self.load_audio())
        self.timeline.fileDropped.connect(self._on_drop)
        self.timeline.cutDragged.connect(self._on_cut_dragged)
        v.addWidget(self.timeline, 1)

        # info line divides the timeline from the action blocks
        infrow = QHBoxLayout()
        self.info_label = QLabel("No show loaded")
        self.info_label.setFont(mono_font(theme.FONT_SM)); self.info_label.setStyleSheet(f"color: {theme.TEXT_MUTED};")
        infrow.addWidget(self.info_label); infrow.addStretch(1)
        self.tip_label = QLabel("↑ drop a show .xml on the cues, audio on the waveform · or click to browse")
        self.tip_label.setFont(sans_font(10)); self.tip_label.setStyleSheet(f"color: {theme.TEXT_MUTED};")
        infrow.addWidget(self.tip_label)
        v.addLayout(infrow)

        rowL = QHBoxLayout(); rowL.setSpacing(12)
        g_cut = panel(); gc = QVBoxLayout(g_cut); gc.setContentsMargins(22, 18, 22, 18); gc.setSpacing(12)
        modes = QHBoxLayout()
        self.rb_tc = seg_button("By timecode"); self.rb_bars = seg_button("By bars"); self.rb_tc.setChecked(True)
        mg = QButtonGroup(self); mg.addButton(self.rb_tc); mg.addButton(self.rb_bars)
        modes.addWidget(self.rb_tc); modes.addWidget(self.rb_bars); modes.addStretch(1); gc.addLayout(modes)
        self.stack = QStackedWidget()
        pg_tc = QWidget(); ptc = QGridLayout(pg_tc); ptc.setContentsMargins(0, 8, 0, 0)
        ptc.setVerticalSpacing(10); ptc.setHorizontalSpacing(12)
        ptc.addWidget(self._mk("Cut in", theme.TEXT_MUTED), 0, 0)
        self.cin = TCField(); self.cin.setAccessibleName("Cut in"); ptc.addWidget(self.cin, 0, 1)
        lenrow = QHBoxLayout()
        self.rb_out = seg_button("Cut out"); self.rb_dur = seg_button("Duration"); self.rb_out.setChecked(True)
        llg = QButtonGroup(self); llg.addButton(self.rb_out); llg.addButton(self.rb_dur)
        lenrow.addWidget(self.rb_out); lenrow.addWidget(self.rb_dur); lenrow.addStretch(1)
        ptc.addWidget(self._mk("End by", theme.TEXT_MUTED), 1, 0); ptc.addLayout(lenrow, 1, 1)
        self.cout = TCField(); self.cout.setAccessibleName("Cut out")
        self.dur = QDoubleSpinBox(); self.dur.setRange(0.0, 36000.0); self.dur.setDecimals(3); self.dur.setSuffix(" s")
        self.dur.setAccessibleName("Duration seconds")
        self.lenstack = QStackedWidget(); self.lenstack.addWidget(self.cout); self.lenstack.addWidget(self.dur)
        ptc.addWidget(self.lenstack, 2, 1); ptc.setColumnStretch(1, 1)
        self.stack.addWidget(pg_tc)
        pg_b = QWidget(); pb = QGridLayout(pg_b); pb.setContentsMargins(0, 4, 0, 0)
        pb.addWidget(QLabel("From bar"), 0, 0); self.spin_from = QSpinBox(); self.spin_from.setRange(1, 99999); self.spin_from.setValue(1)
        self.spin_from.setAccessibleName("From bar"); pb.addWidget(self.spin_from, 0, 1)
        pb.addWidget(QLabel("Remove bars"), 1, 0); self.spin_count = QSpinBox(); self.spin_count.setRange(1, 99999); self.spin_count.setValue(4)
        self.spin_count.setAccessibleName("Remove bars"); pb.addWidget(self.spin_count, 1, 1)
        self.bars_readout = QLabel(""); self.bars_readout.setFont(mono_font(theme.FONT_SM)); self.bars_readout.setStyleSheet(f"color: {theme.TEXT_DIM};")
        pb.addWidget(self.bars_readout, 2, 0, 1, 2); pb.setColumnStretch(1, 1); self.stack.addWidget(pg_b)
        gc.addWidget(self.stack)
        bpmrow = QHBoxLayout(); bpmrow.addWidget(self._mk("BPM", theme.TEXT_MUTED))
        self.bpm = QLineEdit(); self.bpm.setFont(mono_font(theme.FONT_MD)); self.bpm.setFixedWidth(116)
        self.bpm.setPlaceholderText("—"); self.bpm.setValidator(QDoubleValidator(0.0, 400.0, 2)); self.bpm.setAccessibleName("BPM")
        self.bpm.returnPressed.connect(self._apply_bpm)
        self.b_set = QPushButton("Set"); self.b_set.clicked.connect(self._apply_bpm)
        self.b_autobpm = QPushButton("AUTO"); self.b_autobpm.setToolTip("Re-detect BPM from the cue grid")
        self.b_autobpm.setStyleSheet(
            f"QPushButton{{background:{theme.SEMANTIC_WARNING};color:{theme.BG_APP};font-weight:700;"
            f"border:none;border-radius:{theme.RADIUS_MD}px;padding:7px 12px;}}QPushButton:hover{{background:{theme.SEMANTIC_WARNING_HOVER};}}"
            f"QPushButton:focus{{border:2px solid {theme.TEXT_BRIGHT};}}"
            f"QPushButton:disabled{{background:{theme.BG_RAISED};color:{theme.TEXT_DISABLED};}}")
        self.b_autobpm.clicked.connect(self._auto_bpm_click)
        bpmrow.addWidget(self.bpm); bpmrow.addWidget(self.b_set); bpmrow.addWidget(self.b_autobpm); bpmrow.addStretch(1)
        gc.addLayout(bpmrow)
        self.bpm_hint = QLabel(""); self.bpm_hint.setFont(sans_font(10)); self.bpm_hint.setWordWrap(True)
        self.bpm_hint.setStyleSheet(f"color: {theme.TEXT_MUTED};"); gc.addWidget(self.bpm_hint); gc.addStretch(1)
        rowL.addWidget(g_cut, 0)
        g_prev = panel(); gp = QVBoxLayout(g_prev); gp.setContentsMargins(16, 14, 16, 14)
        self.report = QPlainTextEdit(); self.report.setReadOnly(True); self.report.setFont(mono_font(theme.FONT_SM)); self.report.setMinimumHeight(220)
        gp.addWidget(self.report); rowL.addWidget(g_prev, 1)
        v.addLayout(rowL)

        bar = QFrame(); bl = QHBoxLayout(bar); bl.setContentsMargins(16, 8, 16, 8); bl.setSpacing(10)
        self.b_cut = QPushButton("CUT!"); self.b_cut.clicked.connect(self.apply_cut)
        self.b_cut.setStyleSheet(primary_btn_qss(theme.ACTION_PRIMARY, theme.ACTION_PRIMARY_HOVER, theme.ACTION_PRIMARY_ACTIVE))
        self.b_uncut = QPushButton("UNCUT"); self.b_uncut.clicked.connect(self.uncut); self.b_uncut.setEnabled(False)
        self.b_savefile = QPushButton("SAVE FILE"); self.b_savefile.clicked.connect(self.save_file)
        bl.addWidget(self.b_cut, 2); bl.addWidget(self.b_uncut, 1); bl.addWidget(self.b_savefile, 2)
        self._refresh_save()
        outer.addWidget(bar)

        footer = QFrame(); footer.setStyleSheet(f"background: {theme.BG_HEADER};")
        fl = QHBoxLayout(footer); fl.setContentsMargins(16, 6, 16, 6)
        cr = QLabel("© 2026 ØJE STUDIO · MA2 TIMECODE CUT v0.1.0 · MIT")
        cr.setFont(sans_font(10)); cr.setStyleSheet(f"color: {theme.TEXT_MUTED}; letter-spacing: 1px;")
        fl.addWidget(cr); fl.addStretch(1)
        self.status = QLabel(""); self.status.setFont(mono_font(theme.FONT_SM)); self.status.setStyleSheet(f"color: {theme.TEXT_MUTED};")
        fl.addWidget(self.status); outer.addWidget(footer)

        self.rb_tc.toggled.connect(self._on_mode); self.rb_out.toggled.connect(self._on_len_mode)
        self.cin.textEdited.connect(self._schedule); self.cout.textEdited.connect(self._schedule)
        self.dur.valueChanged.connect(self._schedule)
        self.spin_from.valueChanged.connect(self._schedule); self.spin_count.valueChanged.connect(self._schedule)
        self._on_mode(); self._on_len_mode()

    def _mk(self, txt, col):
        lb = QLabel(txt); lb.setStyleSheet(f"color: {col};"); return lb

    def _build_menu(self):
        m = self.menuBar().addMenu("&File")
        a = m.addAction("Open Show…"); a.setShortcut("Ctrl+O"); a.triggered.connect(self.browse_input)
        a = m.addAction("Open Audio…"); a.setShortcut("Ctrl+Shift+O"); a.triggered.connect(lambda: self.load_audio())
        m.addSeparator()
        a = m.addAction("Save Cut…"); a.setShortcut("Ctrl+S"); a.triggered.connect(self.save_file)

    def _set_loaded(self, ok):
        for w in (self.cin, self.cout, self.dur, self.bpm, self.b_set, self.b_autobpm,
                  self.b_cut, self.b_savefile, self.rb_out, self.rb_dur, self.rb_tc,
                  self.rb_bars, self.spin_from, self.spin_count):
            w.setEnabled(ok)
        if ok:
            self._on_mode(); self._on_len_mode()

    def _fit_height(self):
        """Grow the window's minimum height so the whole layout fits with no scroll
        (the timeline's own minimum grows with the track count)."""
        need = self.timeline.minimumHeight() + 560
        self.setMinimumHeight(need)
        if self.height() < need:
            self.resize(self.width(), need)

    def _on_mode(self, *_):
        self.stack.setCurrentIndex(1 if self.rb_bars.isChecked() else 0); self._schedule()

    def _on_len_mode(self, *_):
        self.lenstack.setCurrentIndex(0 if self.rb_out.isChecked() else 1); self._schedule()

    def _schedule(self, *_):
        if self.text is not None:
            self._debounce.start()

    # ---------- loading ----------
    def _on_drop(self, path):
        pl = path.lower()
        if pl.endswith(".xml"):
            self.load(path)
        elif pl.endswith(AUDIO_EXT):
            self.load_audio(path)
        else:
            QMessageBox.warning(self, "Unsupported file", "Drop a grandMA2 .xml or an audio file.")

    def browse_input(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open grandMA2 timecode XML", "", "grandMA2 timecode (*.xml);;All files (*)")
        if path:
            self.load(path)

    def load(self, path):
        try:
            has_bom, text = tcshow.read_show(path); tcshow.summary(text)
        except Exception as e:
            QMessageBox.critical(self, "Can't read file", str(e)); return
        self.in_path, self.text, self.has_bom = path, text, has_bom
        self._undo = []; self.b_uncut.setEnabled(False); self._refresh_save()
        self._reload_working(reset_audio=(self.audio_path is None))
        self._set_loaded(True); self._auto_bpm()
        self.cin.set_frames(self.anchor, self.fps); self.cout.set_frames(self.anchor, self.fps)
        self._recompute()

    def _reload_working(self, reset_audio=False):
        info = tcshow.summary(self.text); lanes = tcshow.lanes(self.text)
        self.info, self.fps, self.anchor = info, info['fps'], info['first_frame']
        self.info_label.setText(
            f"{info['name']} · {info['fps']} FPS · {info['first_tc']}–{info['last_tc']} · {info['n_events']} cues · {info['n_subtracks']} tracks")
        self.timeline.set_show(info['fps'], lanes, info['first_frame'], info['last_frame'],
                               name=os.path.basename(self.in_path or ""))
        self.timeline.set_grid(self.applied_bpm, self.anchor)
        if reset_audio:
            self.audio_path = None; self._song = None
            self.timeline.clear_audio()
        elif self.audio_path:
            self.timeline.set_audio(self.timeline.audio_peaks, self.timeline.audio_dur)
        self._engine_reload()

    def _engine_reload(self):
        """(Re)build the playback stream: the song if loaded, else silence — always
        as long as max(show, audio) — so Play/metronome/playhead run regardless."""
        if self.info is None:
            return
        if self._song is not None:
            samples, sr, ch = self._song
            self.engine.load(samples, sr, ch, int((self.timeline.last - self.timeline.first) / self.fps * sr))
        else:
            self.engine.load_silent(int((self.timeline.last - self.timeline.first) / self.fps * 44100))
        self.engine.set_volume(min(1.0, self.vol.value() / 100.0))
        self._apply_metro()
        self.play_btn.setEnabled(True)
        self.timeline.set_playhead(self.first_frame()); self._update_head(self.first_frame())

    def load_audio(self, path=None):
        if self.text is None:
            QMessageBox.information(self, "Load a show first", "Open a grandMA2 .xml before adding audio."); return
        if not path:
            path, _ = QFileDialog.getOpenFileName(self, "Load song audio", os.path.dirname(self.in_path or ""),
                                                  "Audio (*.wav *.mp3 *.flac *.ogg *.aif *.aiff *.m4a);;All files (*)")
        if not path:
            return
        self.status.setText("decoding audio…"); QApplication.processEvents()
        try:
            samples, sr, ch = audio.decode(path)
            peaks = audio.peaks_from(samples, ch); dur = (len(samples) / ch) / sr if sr else 0.0
        except Exception as e:
            self.status.setText(""); QMessageBox.warning(self, "Couldn't load audio", str(e)); return
        self.audio_path = path; self._song = (samples, sr, ch)
        self.timeline.set_audio(peaks, dur, name=os.path.basename(path))
        self._update_metro_enabled()
        self._engine_reload()
        self.status.setText("")

    def first_frame(self):
        return self.info['first_frame'] if self.info else 0

    # ---------- BPM ----------
    def _update_metro_enabled(self):
        ok = self.applied_bpm > 0 and self.engine.dev is not None
        self.metro.setEnabled(ok)
        if not ok and self.metro.isChecked():
            self.metro.setChecked(False)

    def _after_bpm(self):
        self.timeline.set_grid(self.applied_bpm, self.anchor)
        self._update_metro_enabled(); self._update_head(self.timeline.playhead); self._apply_metro()
        self._fit_height()

    def _auto_bpm_click(self):
        self._auto_bpm(); self._recompute()

    def _auto_bpm(self):
        res = tcshow.estimate_beat(self.text)
        if res:
            _, bpm = res; self.bpm.setText(f"{bpm:.2f}"); self.applied_bpm = round(bpm, 2)
            self.bpm_hint.setText(f"≈ {bpm:.1f} BPM detected from the cues · type a value + Set to override")
        else:
            self.applied_bpm = 0.0; self.bpm_hint.setText("Couldn't auto-detect BPM — type the track BPM and press Set.")
        self._after_bpm()

    def _apply_bpm(self):
        try:
            self.applied_bpm = float(self.bpm.text().replace(",", ".") or 0)
        except ValueError:
            self.applied_bpm = 0.0
        self.bpm_hint.setText(f"BPM set to {self.applied_bpm:g}"); self._after_bpm(); self._recompute()

    # ---------- compute / preview ----------
    def _beat_frames(self):
        return (60.0 / self.applied_bpm) * self.fps if self.applied_bpm > 0 else 0.0

    def _bar_frames(self):
        return 4.0 * self._beat_frames()

    def _update_head(self, frame):
        if frame is None:
            return
        self.tc_label.setText(frames_to_tc(frame, self.fps))
        bf = self._bar_frames()
        if bf > 0:
            bar = int((frame - self.anchor) / bf) + 1
            beat = int(((frame - self.anchor) / (bf / 4.0)) % 4) + 1
            self.bar_label.setText(f"BAR {bar}·{beat}")
        else:
            self.bar_label.setText("")

    def _params(self):
        if self.rb_bars.isChecked():
            bf = self._bar_frames()
            if bf <= 0:
                raise ValueError("Set a BPM first to cut by bars.")
            return (round(self.anchor + (self.spin_from.value() - 1) * bf), round(self.spin_count.value() * bf))
        cut_in = self.cin.frames(self.fps)
        if cut_in is None:
            raise ValueError("Cut in is not a valid timecode.")
        if self.rb_out.isChecked():
            cut_out = self.cout.frames(self.fps)
            if cut_out is None:
                raise ValueError("Cut out is not a valid timecode.")
            if cut_out <= cut_in:
                raise ValueError("Cut out must be later than cut in.")
            return cut_in, cut_out - cut_in
        if self.dur.value() <= 0:
            raise ValueError("Set a duration greater than 0.")
        return cut_in, round(self.dur.value() * self.fps)

    def _report_text(self, cut_in, cut_len, deleted, shifted, header):
        fps = self.fps
        L = [header, f"Cut window:  {frames_to_tc(cut_in, fps)}  →  {frames_to_tc(cut_in + cut_len, fps)}",
             f"Length:      {cut_len} frames  /  {cut_len / fps:.3f} s"]
        if self.applied_bpm > 0:
            beat = fps * 60.0 / self.applied_bpm; beats = cut_len / beat; bars = beats / 4.0
            if abs(bars - round(bars)) <= 0.08:
                L.append(f"At {self.applied_bpm:g} BPM: {beats:.2f} beats ≈ {round(bars)} bars   ✓ whole bars")
            else:
                k = max(1, round(bars)); sug = round(k * 4 * beat)
                L.append(f"At {self.applied_bpm:g} BPM: {beats:.2f} beats = {bars:.2f} bars   ⚠ not whole bars")
                L.append(f"   nearest {k} bars = {sug}f → cut out {frames_to_tc(cut_in + sug, fps)}")
        L += ["", f"DELETE {len(deleted)} cues:"]
        L += [f"   {frames_to_tc(t, fps)}  {nm}" for t, nm in sorted(deleted)] or ["   (none)"]
        L += ["", f"SHIFT {shifted} cues left by {cut_len} frames."]
        return "\n".join(L)

    def _on_cut_dragged(self, a, b):
        """Cut window moved/resized by its handle → sync the fields, recompute live."""
        if self.rb_bars.isChecked():
            bf = self._bar_frames()
            if bf > 0:
                self.spin_from.setValue(max(1, round((a - self.anchor) / bf) + 1))
                self.spin_count.setValue(max(1, round((b - a) / bf)))
        else:
            self.cin.set_frames(a, self.fps)
            if self.rb_out.isChecked():
                self.cout.set_frames(b, self.fps)
            else:
                self.dur.setValue((b - a) / self.fps)
        self._recompute()

    def _recompute(self):
        if self.text is None:
            return
        try:
            cut_in, cut_len = self._params()
        except ValueError as e:
            self.timeline.set_cut(None, None); self.report.setPlainText(str(e)); self.bars_readout.setText(""); return
        _, deleted, shifted = ripple_cut(self.text, cut_in, cut_len)
        self.timeline.set_cut(cut_in, cut_in + cut_len)
        self.report.setPlainText(self._report_text(cut_in, cut_len, deleted, shifted, "PENDING — press CUT! to apply\n"))
        if self.rb_bars.isChecked():
            self.bars_readout.setText(f"→ {frames_to_tc(cut_in, self.fps)} … {frames_to_tc(cut_in + cut_len, self.fps)}")

    # ---------- CUT! / UNCUT / SAVE ----------
    def apply_cut(self):
        try:
            cut_in, cut_len = self._params()
        except ValueError as e:
            QMessageBox.warning(self, "Check the cut", str(e)); return
        new_text, deleted, shifted = ripple_cut(self.text, cut_in, cut_len)
        self._undo.append(self.text); self.text = new_text
        self._reload_working(); self.timeline.set_cut(None, None)
        self.cin.set_frames(self.anchor, self.fps); self.cout.set_frames(self.anchor, self.fps)
        self.b_uncut.setEnabled(True); self._refresh_save()
        n = len(self._undo)
        self.report.setPlainText(self._report_text(cut_in, cut_len, deleted, shifted,
                                 f"✓ CUT APPLIED · UNCUT to undo ({n} cut{'s' if n != 1 else ''})\n"))
        self.status.setText(f"cut applied · {len(deleted)} deleted · {shifted} shifted")

    def uncut(self):
        if not self._undo:
            return
        self.text = self._undo.pop(); self._reload_working(); self.timeline.set_cut(None, None)
        self.b_uncut.setEnabled(bool(self._undo)); self._refresh_save()
        n = len(self._undo)
        self.report.setPlainText("Reverted last cut." + (f"  ({n} cut{'s' if n != 1 else ''} left)" if n else ""))
        self.status.setText("reverted")

    def _refresh_save(self):
        if self._undo:
            self.b_savefile.setStyleSheet(primary_btn_qss(theme.SEMANTIC_INFO, theme.SEMANTIC_INFO_HOVER, theme.SEMANTIC_INFO_ACTIVE))
        else:
            self.b_savefile.setStyleSheet(secondary_btn_qss())

    def save_file(self):
        if not self._undo and QMessageBox.question(self, "No cut applied",
                "You haven't pressed CUT! yet — save the file unchanged?") != QMessageBox.Yes:
            return
        default = os.path.splitext(self.in_path)[0] + "_cut.xml"
        out_path, _ = QFileDialog.getSaveFileName(self, "Save XML as", default, "grandMA2 timecode (*.xml);;All files (*)")
        if not out_path:
            return
        if not out_path.lower().endswith(".xml"):
            out_path += ".xml"
        if os.path.abspath(out_path) == os.path.abspath(self.in_path):
            QMessageBox.warning(self, "Output", "Won't overwrite the original — choose a different name."); return
        try:
            data = (b'\xef\xbb\xbf' if self.has_bom else b'') + self.text.encode('utf-8')
            with open(out_path, 'wb') as fh:
                fh.write(data)
        except Exception as e:
            QMessageBox.critical(self, "Couldn't save", str(e)); return
        base = os.path.splitext(os.path.basename(out_path))[0]
        QMessageBox.information(self, "Cut saved",
            f"Saved:\n{out_path}\n\nImport into grandMA2 (empty slot, filename first, no .xml):\n\n"
            f'    Import \"{base}\" At Timecode <N>')
        self.status.setText(f"saved {os.path.basename(out_path)}")

    # ---------- playback ----------
    def _toggle_play(self):
        if self.play_btn.isEnabled():
            self.engine.toggle()

    def _on_state(self, playing):
        self.play_btn.setText("⏸" if playing else "▶")

    def _on_position(self, af):
        if self.fps is None or self.engine.dev is None:
            return
        frame = self.first_frame() + af / self.engine.sr * self.fps
        self.timeline.set_playhead(frame); self._update_head(frame)

    def _seek_to_frame(self, frame):
        if self.engine.dev is None:
            return
        af = int((frame - self.first_frame()) / self.fps * self.engine.sr)
        self.engine.seek(af); self.timeline.set_playhead(frame); self._update_head(frame)

    def _on_volume(self, v):
        self.engine.set_volume(min(1.0, v / 100.0)); self.timeline.set_gain(v / 100.0); self.vol_lbl.setText(f"{v}%")

    # ---------- metronome (live mix — instant toggle) ----------
    def _on_metro_toggled(self, on):
        self.metro.setIcon(QIcon(metro_icon(theme.BG_APP if on else theme.TEXT_MUTED)))
        self._apply_metro()

    def _apply_metro(self):
        on = self.metro.isChecked() and self.applied_bpm > 0 and self.engine.dev is not None
        beat_audio = (60.0 / self.applied_bpm) * self.engine.sr if self.applied_bpm > 0 else 0.0
        self.engine.set_metro(on, beat_audio)


def make_window():
    return MainWindow()


def main():
    app = QApplication(sys.argv); app.setApplicationName(APP_NAME); app.setFont(sans_font(theme.FONT_BASE))
    app.setWindowIcon(QIcon(asset_path("icon_1024.png")))
    w = make_window(); w.show()
    for arg in sys.argv[1:]:
        if os.path.isfile(arg):
            w.load(arg); break
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
