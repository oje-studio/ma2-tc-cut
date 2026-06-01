#!/usr/bin/env python3
"""
MA2 Timecode Cut — desktop GUI (PySide6) on top of the ma2_tc_cut core.

Pick an exported grandMA2 timecode XML, set the cut window (out-timecode or
duration), preview exactly which cues get deleted/shifted before committing,
optionally check it against a BPM (whole-bars warning), then write a byte-exact
cut file ready to import back into MA2.
"""
import os
import re
import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QFontDatabase, QFont
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QGroupBox, QLabel, QLineEdit, QPushButton, QFileDialog, QPlainTextEdit,
    QRadioButton, QButtonGroup, QDoubleSpinBox, QMessageBox,
)

from ma2_tc_cut import ripple_cut, tc_to_frames, frames_to_tc
import tcshow

APP_NAME = "MA2 Timecode Cut"
TC_RE = re.compile(r'^\d{1,2}(:\d{1,2}){1,3}$')


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.setMinimumWidth(620)
        self.in_path = None
        self.text = None
        self.has_bom = False
        self.fps = None
        self.info = None
        self.mono = QFontDatabase.systemFont(QFontDatabase.FixedFont)
        self._build()
        self._set_loaded(False)

    # ---------- UI ----------
    def _build(self):
        root = QWidget()
        self.setCentralWidget(root)
        v = QVBoxLayout(root)
        v.setContentsMargins(16, 16, 16, 16)
        v.setSpacing(12)

        title = QLabel(APP_NAME)
        f = title.font(); f.setPointSize(f.pointSize() + 6); f.setBold(True)
        title.setFont(f)
        sub = QLabel("Ripple-cut a window out of a grandMA2 timecode show — byte-exact.")
        sub.setStyleSheet("color: gray;")
        v.addWidget(title)
        v.addWidget(sub)

        # --- Input ---
        g_in = QGroupBox("1 · Show file")
        gi = QGridLayout(g_in)
        self.in_edit = QLineEdit(); self.in_edit.setReadOnly(True)
        self.in_edit.setPlaceholderText("Exported grandMA2 timecode .xml …")
        b_browse = QPushButton("Browse…"); b_browse.clicked.connect(self.browse_input)
        self.info_label = QLabel("—"); self.info_label.setFont(self.mono)
        self.info_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        gi.addWidget(self.in_edit, 0, 0); gi.addWidget(b_browse, 0, 1)
        gi.addWidget(self.info_label, 1, 0, 1, 2)
        v.addWidget(g_in)

        # --- Cut ---
        g_cut = QGroupBox("2 · Cut window")
        gc = QGridLayout(g_cut)
        gc.addWidget(QLabel("Cut in (TC):"), 0, 0)
        self.cin = QLineEdit(); self.cin.setPlaceholderText("HH:MM:SS:FF")
        self.cin.setFont(self.mono)
        gc.addWidget(self.cin, 0, 1, 1, 2)

        self.rb_out = QRadioButton("End — cut out (TC):")
        self.rb_dur = QRadioButton("End — duration (s):")
        self.rb_out.setChecked(True)
        grp = QButtonGroup(self); grp.addButton(self.rb_out); grp.addButton(self.rb_dur)
        self.cout = QLineEdit(); self.cout.setPlaceholderText("HH:MM:SS:FF"); self.cout.setFont(self.mono)
        self.dur = QDoubleSpinBox(); self.dur.setRange(0.0, 36000.0); self.dur.setDecimals(3)
        self.dur.setSuffix(" s"); self.dur.setValue(0.0)
        self.rb_out.toggled.connect(self._sync_mode)
        gc.addWidget(self.rb_out, 1, 0); gc.addWidget(self.cout, 1, 1, 1, 2)
        gc.addWidget(self.rb_dur, 2, 0); gc.addWidget(self.dur, 2, 1, 1, 2)

        gc.addWidget(QLabel("BPM (optional):"), 3, 0)
        self.bpm = QDoubleSpinBox(); self.bpm.setRange(0.0, 400.0); self.bpm.setDecimals(2)
        self.bpm.setSpecialValueText("—")
        b_est = QPushButton("Estimate"); b_est.clicked.connect(self.estimate_bpm)
        gc.addWidget(self.bpm, 3, 1); gc.addWidget(b_est, 3, 2)
        self.bpm_hint = QLabel(""); self.bpm_hint.setStyleSheet("color: gray;")
        gc.addWidget(self.bpm_hint, 4, 0, 1, 3)

        self.b_prev = QPushButton("Preview"); self.b_prev.clicked.connect(self.preview)
        gc.addWidget(self.b_prev, 5, 0, 1, 3)
        v.addWidget(g_cut)

        # --- Preview / result ---
        self.report = QPlainTextEdit(); self.report.setReadOnly(True)
        self.report.setFont(self.mono); self.report.setMinimumHeight(180)
        v.addWidget(self.report, 1)

        # --- Output + action ---
        g_out = QGroupBox("3 · Save cut as")
        go = QGridLayout(g_out)
        self.out_edit = QLineEdit(); self.out_edit.setPlaceholderText("…_cut.xml")
        b_out = QPushButton("Browse…"); b_out.clicked.connect(self.browse_output)
        self.b_cut = QPushButton("Cut && Save"); self.b_cut.setDefault(True)
        self.b_cut.clicked.connect(self.do_cut)
        go.addWidget(self.out_edit, 0, 0); go.addWidget(b_out, 0, 1)
        go.addWidget(self.b_cut, 1, 0, 1, 2)
        v.addWidget(g_out)

        self.statusBar().showMessage("Open a show file to begin.")
        self._sync_mode()

    def _set_loaded(self, ok):
        for w in (self.cin, self.cout, self.dur, self.bpm, self.b_prev, self.b_cut,
                  self.out_edit, self.rb_out, self.rb_dur):
            w.setEnabled(ok)
        if ok:
            self._sync_mode()

    def _sync_mode(self, *_):
        out = self.rb_out.isChecked()
        self.cout.setEnabled(out and self.in_path is not None)
        self.dur.setEnabled((not out) and self.in_path is not None)

    # ---------- actions ----------
    def browse_input(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Open grandMA2 timecode XML", "", "grandMA2 timecode (*.xml);;All files (*)")
        if path:
            self.load(path)

    def load(self, path):
        try:
            has_bom, text = tcshow.read_show(path)
            info = tcshow.summary(text)
        except Exception as e:
            QMessageBox.critical(self, "Can't read file", str(e))
            return
        self.in_path, self.text, self.has_bom, self.fps, self.info = path, text, has_bom, info['fps'], info
        self.in_edit.setText(path)
        self.info_label.setText(
            f"{info['name']}   ·   {info['fps']} FPS   ·   "
            f"{info['first_tc']} – {info['last_tc']}   ·   "
            f"{info['n_events']} events / {info['n_subtracks']} subtracks")
        base, _ = os.path.splitext(path)
        self.out_edit.setText(base + "_cut.xml")
        self.report.clear()
        self.bpm_hint.setText("")
        self._set_loaded(True)
        self.statusBar().showMessage(f"Loaded {os.path.basename(path)}")

    def browse_output(self):
        start = self.out_edit.text()
        if not start and self.in_path:
            start = os.path.splitext(self.in_path)[0] + "_cut.xml"
        path, _ = QFileDialog.getSaveFileName(
            self, "Save cut as", start, "grandMA2 timecode (*.xml);;All files (*)")
        if path:
            if not path.lower().endswith(".xml"):
                path += ".xml"
            self.out_edit.setText(path)

    def estimate_bpm(self):
        if self.text is None:
            return
        res = tcshow.estimate_beat(self.text)
        if res:
            beat, bpm = res
            self.bpm.setValue(round(bpm, 2))
            self.bpm_hint.setText(f"≈ {bpm:.1f} BPM (rough, from the cue grid — verify against the track)")
        else:
            self.bpm_hint.setText("Couldn't estimate from the cues — enter the track BPM manually.")

    def _params(self):
        """Return (cut_in_frames, cut_len_frames). Raises ValueError with a message."""
        cin = self.cin.text().strip()
        if not TC_RE.match(cin):
            raise ValueError("Cut in must be a timecode like HH:MM:SS:FF.")
        cut_in = tc_to_frames(cin, self.fps)
        if self.rb_out.isChecked():
            cout = self.cout.text().strip()
            if not TC_RE.match(cout):
                raise ValueError("Cut out must be a timecode like HH:MM:SS:FF.")
            cut_out = tc_to_frames(cout, self.fps)
            if cut_out <= cut_in:
                raise ValueError("Cut out must be later than cut in.")
            return cut_in, cut_out - cut_in
        dur = self.dur.value()
        if dur <= 0:
            raise ValueError("Duration must be greater than 0.")
        return cut_in, round(dur * self.fps)

    def _report_text(self, cut_in, cut_len, deleted, shifted):
        fps = self.fps
        out = cut_in + cut_len
        L = [f"Cut window:  {frames_to_tc(cut_in, fps)}  →  {frames_to_tc(out, fps)}",
             f"Length:      {cut_len} frames  /  {cut_len / fps:.3f} s"]
        bpm = self.bpm.value()
        if bpm > 0:
            beat = fps * 60.0 / bpm
            beats = cut_len / beat
            bars = beats / 4.0
            if abs(bars - round(bars)) <= 0.08:
                L.append(f"At {bpm:g} BPM: {beats:.2f} beats ≈ {round(bars)} bars   ✓ whole bars")
            else:
                k = max(1, round(bars))
                sug = round(k * 4 * beat)
                L.append(f"At {bpm:g} BPM: {beats:.2f} beats = {bars:.2f} bars   ⚠ NOT a whole bar count")
                L.append(f"   nearest {k} bars = {sug} frames → set cut out {frames_to_tc(cut_in + sug, fps)}")
        L += ["", f"DELETE {len(deleted)} cues:"]
        L += [f"   {frames_to_tc(t, fps)}  {nm}" for t, nm in sorted(deleted)] or ["   (none)"]
        L += ["", f"SHIFT {shifted} cues left by {cut_len} frames."]
        return "\n".join(L)

    def preview(self):
        try:
            cut_in, cut_len = self._params()
        except ValueError as e:
            QMessageBox.warning(self, "Check the cut", str(e)); return
        _, deleted, shifted = ripple_cut(self.text, cut_in, cut_len)
        self.report.setPlainText(self._report_text(cut_in, cut_len, deleted, shifted))
        self.statusBar().showMessage(f"Preview: {len(deleted)} deleted, {shifted} shifted")

    def do_cut(self):
        try:
            cut_in, cut_len = self._params()
        except ValueError as e:
            QMessageBox.warning(self, "Check the cut", str(e)); return
        out_path = self.out_edit.text().strip()
        if not out_path:
            QMessageBox.warning(self, "Output", "Choose where to save the cut file."); return
        if os.path.abspath(out_path) == os.path.abspath(self.in_path):
            QMessageBox.warning(self, "Output", "Refusing to overwrite the original. Pick a different name."); return
        try:
            new_text, deleted, shifted = ripple_cut(self.text, cut_in, cut_len)
            data = (b'\xef\xbb\xbf' if self.has_bom else b'') + new_text.encode('utf-8')
            with open(out_path, 'wb') as fh:
                fh.write(data)
        except Exception as e:
            QMessageBox.critical(self, "Couldn't save", str(e)); return
        self.report.setPlainText(self._report_text(cut_in, cut_len, deleted, shifted))
        base = os.path.splitext(os.path.basename(out_path))[0]
        QMessageBox.information(
            self, "Saved",
            f"Saved:\n{out_path}\n\n"
            f"Deleted {len(deleted)} cues, shifted {shifted}.\n\n"
            f"Import into grandMA2 (empty slot, filename first, no .xml):\n\n"
            f'    Import \"{base}\" At Timecode <N>')
        self.statusBar().showMessage(f"Saved {os.path.basename(out_path)}")


def make_window():
    return MainWindow()


def main():
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    w = make_window()
    w.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
