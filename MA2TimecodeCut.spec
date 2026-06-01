# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — used unchanged on macOS and Windows.
#   pyinstaller --noconfirm MA2TimecodeCut.spec
# Entry point gui.py imports ma2_tc_cut.py and tcshow.py from the same folder,
# so PyInstaller's analysis picks them up automatically.
import sys

APP = "MA2 Timecode Cut"

a = Analysis(
    ['gui.py'],
    pathex=[],
    binaries=[],
    datas=[('assets/logo_src.png', 'assets')],
    # miniaudio is imported lazily inside functions, so name it explicitly;
    # QtMultimedia + its audio backend are pulled in by the PySide6 hook.
    hiddenimports=['miniaudio', 'PySide6.QtMultimedia'],
    excludes=['tkinter', 'test', 'unittest', 'pydoc_data'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP,
    debug=False,
    strip=False,
    upx=False,
    console=False,          # GUI / windowed app (no console window on Windows)
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name=APP,
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name=f"{APP}.app",
        bundle_identifier="studio.oje.ma2tccut",
        info_plist={
            'NSHighResolutionCapable': True,
            'CFBundleShortVersionString': '0.1.0',
            'CFBundleVersion': '0.1.0',
        },
    )
