"""
Cue timeline (display + transport + load target). Top ruler = timecode, a bar
ruler sits above the audio band, lanes show cue ticks, the cut window is drawn
over the grid. Click/drop a .xml on the cue area to load a show, click/drop
audio on the waveform area to load audio; once loaded, click/drag seeks. Lane
names flash as the playhead crosses their cues.
"""
from __future__ import annotations

from PySide6.QtCore import Qt, QRectF, QPointF, QTimer, Signal
from PySide6.QtGui import QPainter, QColor, QPen, QFontMetrics, QPolygonF
from PySide6.QtWidgets import QWidget

import theme
from fonts import mono_font, sans_font

LBL_W = 134
AXIS_H = 26
PAD_R = 14
LANE_MIN = 28
AUDIO_H = 54
BARS_H = 18
GRID_BAR = "#343434"
GRID_PHRASE = "#4a4a4a"
AUDIO_EXT = (".wav", ".mp3", ".flac", ".ogg", ".aif", ".aiff", ".m4a")


def _tc(fr, fps):
    s, f = divmod(int(round(fr)), fps)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def _blend(c1, c2, t):
    a, b = QColor(c1), QColor(c2)
    return QColor(int(a.red() + (b.red() - a.red()) * t),
                  int(a.green() + (b.green() - a.green()) * t),
                  int(a.blue() + (b.blue() - a.blue()) * t))


class TimelineWidget(QWidget):
    seekRequested = Signal(int)
    showRequested = Signal()
    audioRequested = Signal()
    fileDropped = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.fps = 30
        self.first = 0
        self.last = 1
        self.lanes = []
        self.cut_in = self.cut_out = None
        self.audio_peaks = []
        self.audio_dur = 0.0
        self.gain = 1.0
        self.bpm = 0.0
        self.anchor = 0
        self.snap_mode = "off"
        self.playhead = None
        self.show_name = ""
        self.audio_name = ""
        self._prev_ph = None
        self._flash = {}
        self._audio_top = None
        self._flash_timer = QTimer(self)
        self._flash_timer.setInterval(45)
        self._flash_timer.timeout.connect(self._decay)
        self.setMinimumHeight(220)
        self.setMouseTracking(True)
        self.setAcceptDrops(True)

    # ---------- data ----------
    def set_show(self, fps, lanes, first, last, name=""):
        self.fps = max(1, int(fps))
        self.lanes = lanes or []
        self.first = int(first)
        self.last = max(int(last), self.first + 1)
        self.anchor = self.first
        self.show_name = name or self.show_name
        self.cut_in = self.cut_out = self.playhead = self._prev_ph = None
        self._flash.clear()
        self._recalc_min_height()
        self.update()

    def set_cut(self, a, b):
        self.cut_in, self.cut_out = a, b
        self.update()

    def set_audio(self, peaks, duration_s, name=""):
        self.audio_peaks = peaks or []
        self.audio_dur = float(duration_s or 0.0)
        if name:
            self.audio_name = name
        self._recalc_min_height()
        self.update()

    def clear_audio(self):
        self.audio_peaks = []
        self.audio_dur = 0.0
        self.audio_name = ""
        self.playhead = self._prev_ph = None
        self.update()

    def set_grid(self, bpm, anchor=None):
        self.bpm = float(bpm or 0.0)
        if anchor is not None:
            self.anchor = int(anchor)
        self._recalc_min_height()
        self.update()

    def set_snap(self, mode):
        self.snap_mode = mode or "off"

    def set_gain(self, g):
        self.gain = max(0.0, float(g))
        self.update()

    def set_playhead(self, frame):
        prev = self._prev_ph
        self._prev_ph = self.playhead = frame
        if prev is not None and frame is not None and 0 < (frame - prev) <= 1.5 * self.fps:
            for i, lane in enumerate(self.lanes):
                if any(prev < f <= frame for (f, _n) in lane['events']):
                    self._flash[i] = 1.0
            if self._flash and not self._flash_timer.isActive():
                self._flash_timer.start()
        self.update()

    def _decay(self):
        for k in list(self._flash):
            self._flash[k] -= 0.12
            if self._flash[k] <= 0:
                del self._flash[k]
        if not self._flash:
            self._flash_timer.stop()
        self.update()

    def _recalc_min_height(self):
        n = max(1, len(self.lanes))
        extra = (AUDIO_H if self.lanes else 0) + (BARS_H if self.bpm > 0 else 0)
        self.setMinimumHeight(AXIS_H + n * LANE_MIN + 14 + extra)

    # ---------- mapping ----------
    def _plot_w(self):
        return max(1, self.width() - LBL_W - PAD_R)

    def _x(self, frame):
        return LBL_W + (frame - self.first) / (self.last - self.first) * self._plot_w()

    def _frame_at(self, x):
        x = min(max(x, LBL_W), LBL_W + self._plot_w())
        return int(round(self.first + (x - LBL_W) / self._plot_w() * (self.last - self.first)))

    def _beat_frames(self):
        return (60.0 / self.bpm) * self.fps if self.bpm > 0 else 0.0

    def _bar_frames(self):
        return 4.0 * self._beat_frames()

    def _snap(self, frame):
        bar, beat = self._bar_frames(), self._beat_frames()
        if self.snap_mode == "bar" and bar > 0:
            return int(round((frame - self.anchor) / bar) * bar + self.anchor)
        if self.snap_mode == "beat" and beat > 0:
            return int(round((frame - self.anchor) / beat) * beat + self.anchor)
        if self.snap_mode == "sec":
            return int(round(frame / self.fps) * self.fps)
        return frame

    # ---------- paint ----------
    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        W, H = self.width(), self.height()
        p.fillRect(self.rect(), QColor(theme.BG_SURFACE))
        p.setPen(QPen(QColor(theme.BORDER_SUBTLE), 1))
        p.drawRect(0, 0, W - 1, H - 1)

        if not self.lanes:
            self._audio_top = None
            p.setPen(QColor(theme.TEXT_DIM)); p.setFont(sans_font(13))
            p.drawText(self.rect(), Qt.AlignCenter, "Click or drop a grandMA2 timecode .xml here")
            p.end(); return

        plot_w = self._plot_w()
        bf = self._bar_frames()
        audio_h = AUDIO_H
        bars_h = BARS_H if bf > 0 else 0
        lanes_bottom = H - 4 - audio_h - bars_h
        grid_bottom = lanes_bottom + bars_h
        self._audio_top = grid_bottom
        n = len(self.lanes)
        lane_h = (lanes_bottom - AXIS_H) / n
        win = self._window()

        if win:
            a, b, _ = win
            xa, xb = self._x(a), self._x(b)
            p.fillRect(QRectF(xb, AXIS_H, (W - PAD_R) - xb, grid_bottom - AXIS_H),
                       QColor(theme.with_alpha(theme.SEMANTIC_INFO, 0.06)))
            p.fillRect(QRectF(xa, AXIS_H, xb - xa, grid_bottom - AXIS_H),
                       QColor(theme.with_alpha(theme.SEMANTIC_DANGER, 0.16)))

        if bf > 0:
            self._draw_grid_lines(p, grid_bottom, bf)
        self._draw_tc_ruler(p, W, plot_w, grid_bottom)

        # show filename in the top-left gutter
        if self.show_name:
            p.setFont(sans_font(theme.FONT_XS)); p.setPen(QColor(theme.TEXT_DIM))
            nm = QFontMetrics(p.font()).elidedText(self.show_name, Qt.ElideMiddle, LBL_W - 14)
            p.drawText(10, 2, LBL_W - 14, AXIS_H - 4, Qt.AlignVCenter | Qt.AlignLeft, nm)

        for i, lane in enumerate(self.lanes):
            y0 = AXIS_H + i * lane_h
            yc = y0 + lane_h / 2
            if i > 0:
                p.setPen(QPen(QColor(theme.BORDER_SUBTLE), 1))
                p.drawLine(LBL_W, int(y0), W - PAD_R, int(y0))
            self._draw_lane_label(p, i, y0, lane_h, lane['name'])
            th = max(6, lane_h * 0.46)
            for (fr, _n) in lane['events']:
                x = self._x(fr)
                inside = win and (win[0] <= fr < win[1])
                p.setPen(QPen(QColor(theme.SEMANTIC_DANGER if inside else theme.OPERATOR_LIGHTING), 2))
                p.drawLine(int(x), int(yc - th / 2), int(x), int(yc + th / 2))

        if bars_h:
            self._draw_bars_ruler(p, W, lanes_bottom, bars_h, bf)

        self._draw_audio_band(p, W, grid_bottom, audio_h, win)

        if win:
            self._draw_cut_labels(p, W, H, win, lanes_bottom)

        if self.playhead is not None and self.first <= self.playhead <= self.last:
            x = self._x(self.playhead)
            p.setPen(QPen(QColor(theme.TEXT_BRIGHT), 1))
            p.drawLine(int(x), AXIS_H, int(x), H - 4)
            p.setBrush(QColor(theme.TEXT_BRIGHT)); p.setPen(Qt.NoPen)
            p.drawPolygon(QPolygonF([QPointF(x - 5, AXIS_H), QPointF(x + 5, AXIS_H), QPointF(x, AXIS_H + 6)]))
        p.end()

    def _draw_grid_lines(self, p, grid_bottom, bf):
        k = 0; fr = self.anchor
        while fr <= self.last + bf:
            if fr >= self.first:
                x = self._x(fr); strong = (k % 4 == 0)
                p.setPen(QPen(QColor(GRID_PHRASE if strong else GRID_BAR), 1))
                p.drawLine(int(x), AXIS_H, int(x), int(grid_bottom))
            k += 1; fr = self.anchor + k * bf

    def _draw_bars_ruler(self, p, W, y, h, bf):
        p.setPen(QPen(QColor(theme.BORDER_SUBTLE), 1)); p.drawLine(LBL_W, int(y), W - PAD_R, int(y))
        p.setFont(sans_font(theme.FONT_XS)); p.setPen(QColor(theme.TEXT_DIM))
        p.drawText(10, int(y), LBL_W - 14, h, Qt.AlignVCenter | Qt.AlignLeft, "BARS")
        bar_px = bf / (self.last - self.first) * self._plot_w()
        step = next((s for s in (1, 2, 4, 8, 16, 32, 64) if s * bar_px >= 34), 64)
        p.setFont(mono_font(theme.FONT_XS))
        k = 0; fr = self.anchor
        while fr <= self.last + bf:
            if fr >= self.first and k % step == 0:
                x = self._x(fr)
                p.setPen(QColor(theme.TEXT_MUTED if k % 4 == 0 else theme.TEXT_DIM))
                p.drawText(int(x) + 3, int(y), 40, h, Qt.AlignVCenter | Qt.AlignLeft, str(k + 1))
            k += 1; fr = self.anchor + k * bf

    def _draw_tc_ruler(self, p, W, plot_w, grid_bottom):
        p.setFont(mono_font(theme.FONT_XS)); fm = QFontMetrics(p.font()); last_right = -1e9
        for i in range(7):
            fr = self.first + (self.last - self.first) * i / 6
            x = LBL_W + plot_w * i / 6
            p.setPen(QPen(QColor(theme.BORDER_SUBTLE), 1)); p.drawLine(int(x), AXIS_H, int(x), int(grid_bottom))
            label = _tc(fr, self.fps); tw = fm.horizontalAdvance(label)
            tx = LBL_W if i == 0 else (int(W - PAD_R - tw) if i == 6 else int(x - tw / 2))
            if tx <= last_right + 6:
                continue
            p.setPen(QColor(theme.TEXT_DIM)); p.drawText(tx, AXIS_H - 9, label); last_right = tx + tw

    def _draw_lane_label(self, p, i, y0, lane_h, name):
        level = self._flash.get(i, 0.0)
        col = _blend(theme.TEXT_MUTED, theme.TEXT_BRIGHT, level) if level > 0 else QColor(theme.TEXT_MUTED)
        p.setFont(sans_font(theme.FONT_SM, bold=level > 0.4)); p.setPen(col)
        nm = QFontMetrics(p.font()).elidedText(name, Qt.ElideRight, LBL_W - 14)
        p.drawText(10, int(y0), LBL_W - 14, int(lane_h), Qt.AlignVCenter | Qt.AlignLeft, nm)

    def _draw_audio_band(self, p, W, top, audio_h, win):
        p.setPen(QPen(QColor(theme.BORDER), 1)); p.drawLine(LBL_W, int(top), W - PAD_R, int(top))
        # gutter: AUDIO + filename underneath
        p.setFont(sans_font(theme.FONT_SM)); p.setPen(QColor(theme.OPERATOR_AUDIO))
        p.drawText(10, int(top) + 4, LBL_W - 14, 16, Qt.AlignLeft, "AUDIO")
        if self.audio_name:
            p.setFont(sans_font(theme.FONT_XS)); p.setPen(QColor(theme.TEXT_DIM))
            nm = QFontMetrics(p.font()).elidedText(self.audio_name, Qt.ElideMiddle, LBL_W - 14)
            p.drawText(10, int(top) + 20, LBL_W - 14, 16, Qt.AlignLeft, nm)
        if not self.audio_peaks:
            p.setFont(sans_font(theme.FONT_SM)); p.setPen(QColor(theme.TEXT_DIM))
            p.drawText(LBL_W, int(top), W - PAD_R - LBL_W, audio_h, Qt.AlignCenter,
                       "click or drop an audio file here")
            return
        yc = top + audio_h / 2; half = audio_h / 2 - 5
        m = len(self.audio_peaks)
        normal = QColor(theme.with_alpha(theme.OPERATOR_AUDIO, 0.78))
        danger = QColor(theme.with_alpha(theme.SEMANTIC_DANGER, 0.9))
        last_x, acc, ins = None, 0.0, False
        for i in range(m):
            fr = self.first + (i / m) * self.audio_dur * self.fps
            x = int(self._x(fr))
            if x < LBL_W or x > W - PAD_R:
                continue
            inside = bool(win and (win[0] <= fr < win[1]))
            if x == last_x:
                acc = max(acc, self.audio_peaks[i]); ins = ins or inside
            else:
                if last_x is not None:
                    p.setPen(QPen(danger if ins else normal, 1)); a = min(1.0, acc * self.gain) * half
                    p.drawLine(last_x, int(yc - a), last_x, int(yc + a))
                last_x, acc, ins = x, self.audio_peaks[i], inside
        if last_x is not None:
            p.setPen(QPen(danger if ins else normal, 1)); a = min(1.0, acc * self.gain) * half
            p.drawLine(last_x, int(yc - a), last_x, int(yc + a))

    def _draw_cut_labels(self, p, W, H, win, lanes_bottom):
        a, b, _ = win
        edge = QColor(theme.SEMANTIC_DANGER); xa, xb = self._x(a), self._x(b)
        for x in (xa, xb):
            p.setPen(QPen(edge, 2)); p.drawLine(int(x), AXIS_H, int(x), H - 4)
        p.setFont(mono_font(theme.FONT_XS, bold=True)); fm = QFontMetrics(p.font()); p.setPen(edge)
        la, lb = _tc(a, self.fps), _tc(b, self.fps)
        ax = int(xa - 4 - fm.horizontalAdvance(la))
        if ax < LBL_W + 2:
            ax = int(xa + 4)
        p.drawText(ax, AXIS_H + 12, la)
        bx = int(xb + 4)
        if bx + fm.horizontalAdvance(lb) > W - PAD_R:
            bx = int(xb - 4 - fm.horizontalAdvance(lb))
        p.drawText(bx, AXIS_H + 12, lb)
        length = b - a; chip = f"-{length}f / {length / self.fps:.2f}s"
        cw = fm.horizontalAdvance(chip)
        cx = min(max((xa + xb) / 2 - cw / 2, LBL_W + 2), W - PAD_R - cw)
        p.drawText(int(cx), int(lanes_bottom) - 4, chip)

    def _window(self):
        if self.cut_in is not None and self.cut_out is not None and self.cut_out > self.cut_in:
            return (self.cut_in, self.cut_out, True)
        return None

    # ---------- interaction ----------
    def mousePressEvent(self, e):
        if not self.lanes:
            self.showRequested.emit(); return
        x, y = e.position().x(), e.position().y()
        if x < LBL_W:
            return
        in_audio = self._audio_top is not None and y >= self._audio_top
        if in_audio and not self.audio_peaks:
            self.audioRequested.emit(); return
        if self.audio_peaks:
            self.seekRequested.emit(self._snap(self._frame_at(x)))

    def mouseMoveEvent(self, e):
        if self.audio_peaks and (e.buttons() & Qt.LeftButton) and e.position().x() >= LBL_W:
            self.seekRequested.emit(self._snap(self._frame_at(e.position().x())))

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):
        for url in e.mimeData().urls():
            path = url.toLocalFile()
            if path:
                self.fileDropped.emit(path); return
