#!/usr/bin/env python3
"""Само-тест ma2_tc_cut.py на синтетическом examples/demo_tc.xml.

Запуск:  python3 selftest.py     (код возврата 0 = OK, 1 = провал)
Никаких зависимостей, никаких реальных данных шоу.
"""
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'ma2_tc_cut.py')
DEMO = os.path.join(HERE, 'examples', 'demo_tc.xml')
NS = 'http://schemas.malighting.de/grandma2/xml/MA'

CUT_IN, CUT_LEN = 3500, 300          # 00:01:56:20 + 10s @30fps
CUT_END = CUT_IN + CUT_LEN

fails = []
def check(name, ok):
    print(f"  [{'OK' if ok else 'FAIL'}] {name}")
    if not ok:
        fails.append(name)

def run(out, *extra):
    subprocess.run([sys.executable, SCRIPT, DEMO, out, '--cut-in', '00:01:56:20', *extra],
                   check=True, capture_output=True)

def subtracks(path):
    root = ET.parse(path).getroot()
    res = []
    for st in root.iter(f'{{{NS}}}SubTrack'):
        res.append([(int(e.get('index')), int(e.get('time')), e.get('step'),
                     e.find(f'{{{NS}}}Cue').get('name'))
                    for e in st.findall(f'{{{NS}}}Event')])
    return res

tmp = tempfile.mkdtemp(prefix='ma2tc_')
out_dur = os.path.join(tmp, 'd.xml')
out_co = os.path.join(tmp, 'c.xml')

print("ma2_tc_cut selftest")
run(out_dur, '--dur', '10')
run(out_co, '--cut-out', '00:02:06:20')

# 1) --cut-out эквивалентен --dur 10 (байт-в-байт)
check('--cut-out == --dur 10 (байт-в-байт)', open(out_dur, 'rb').read() == open(out_co, 'rb').read())

# 2) well-formed + BOM
ob = open(out_dur, 'rb').read()
try:
    ET.parse(out_dur); wf = True
except Exception:
    wf = False
check('выход — валидный XML', wf)
check('BOM сохранён', ob.startswith(b'\xef\xbb\xbf'))
check('нет CR (LF-only сохранён)', b'\r' not in ob)
check('хвост </MA> без финального \\n', ob.endswith(b'</MA>') and not ob.endswith(b'\n'))

# 3) семантика ripple
st = subtracks(out_dur)
total = sum(len(s) for s in st)
check('событий 8 -> 6', total == 6)
check('SubTrack0 времена = [3000,3300,3600,3900]', [e[1] for e in st[0]] == [3000, 3300, 3600, 3900])
check('SubTrack1 времена = [3000,3750]', [e[1] for e in st[1]] == [3000, 3750])
ok_idx = all([e[0] for e in s] == list(range(len(s))) for s in st)
check('index 0-based и непрерывный', ok_idx)
ok_mono = all([e[1] for e in s] == sorted(e[1] for e in s) for s in st)
check('время монотонно и >= 0', ok_mono and all(e[1] >= 0 for s in st for e in s))
# step едет с событием и НЕ переиндексируется:
# Chorus(step4) уехал 3900->3600, Post(step5) уехал 4200->3900.
# На 3600 теперь index=2, но step=4 — значит step независим от index.
steps0 = {e[1]: e[2] for e in st[0]}
check('step едет с событием, не переиндексирован', steps0[3600] == '4' and steps0[3900] == '5')

# 4) байт-в-байт: вырезать из оригинала окно и сравнить 1:1
def load(p):
    raw = open(p, 'rb').read()
    return raw[3:].decode('utf-8').split('\n') if raw.startswith(b'\xef\xbb\xbf') else raw.decode('utf-8').split('\n')

ol = load(DEMO)
pruned, removed = [], 0
i = 0
while i < len(ol):
    ln = ol[i]
    if re.search(r'<Event\b', ln):
        blk = [ln]; j = i
        while '</Event>' not in ol[j]:
            j += 1; blk.append(ol[j])
        t = int(re.search(r'time="(\d+)"', ln).group(1))
        if CUT_IN <= t < CUT_END:
            removed += 1; i = j + 1; continue
        pruned.extend(blk); i = j + 1; continue
    pruned.append(ln); i += 1
kl = load(out_dur)
norm = lambda s: re.sub(r'\b(index|time)="\d+"', r'\1="_"', s)
stray = sum(1 for a, b in zip(pruned, kl)
            if a != b and not (re.search(r'<Event\b', a) and norm(a) == norm(b)))
check('удалено ровно 2 блока', removed == 2)
check('после вырезания длины совпали', len(pruned) == len(kl))
check('изменились только index/time в <Event> (0 посторонних)', stray == 0)

for f in (out_dur, out_co):
    os.remove(f)
os.rmdir(tmp)

print()
if fails:
    print(f"ПРОВАЛ: {len(fails)} проверок — {fails}")
    sys.exit(1)
print("ВСЁ ЗЕЛЁНОЕ ✓")
