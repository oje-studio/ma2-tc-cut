#!/usr/bin/env python3
"""
MA2 timecode ripple-cut: вырезает окно [cut_in; cut_out) из тайм-код шоу
grandMA2 и сдвигает все последующие события влево (как cut time в Ableton).

`time` в XML = номер КАДРА при frame_format шоу (напр. 30 FPS), а НЕ миллисекунды.
fps читается из файла автоматически (тег <Timecode frame_format="...">).

Без внешних зависимостей — только стандартная библиотека. Работает на любом
Python 3, в т.ч. на шоу-лэптопе / MA-onPC без pip и компилятора.

Правит ТОЛЬКО строки <Event ...> (атрибуты index/time) и удаляет вырезанные
блоки <Event>...</Event> целиком. Всё остальное — BOM, декларация, stylesheet,
namespace, schemaLocation, отступы (табы), концы строк и отсутствие финального
перевода строки — сохраняется БАЙТ-В-БАЙТ, чтобы импорт в MA2 не капризничал.

ВАЖНО (музыкальная корректность): TC-рез корректен, только если он зеркалит
монтаж аудио — та же точка входа и та же длина. Длину задавай в ЦЕЛЫХ тактах/
долях, а не в круглых секундах: «14.000 с» почти никогда не равно целому числу
тактов, и тогда всё после реза поедет мимо доли. Точку входа сажай на доунбит.
Для покадровой точности используй --cut-out (без округления секунд).
"""
import argparse
import re
import sys

EVENT_OPEN = re.compile(r'<Event\b')
SUBTRACK   = re.compile(r'<SubTrack\b')
TIME_ATTR  = re.compile(r'(\btime=")(\d+)(")')
INDEX_ATTR = re.compile(r'(\bindex=")(\d+)(")')
FRAME_FMT  = re.compile(r'frame_format="[^"]*?(\d+)')
CUE_NAME   = re.compile(r'<Cue\b[^>]*\bname="([^"]*)"')


def tc_to_frames(tc, fps):
    """'HH:MM:SS:FF' -> абсолютный номер кадра. Допускает короткие формы (SS:FF и т.п.)."""
    parts = [int(p) for p in str(tc).split(':')]
    while len(parts) < 4:
        parts = [0] + parts
    h, m, s, f = parts
    return ((h * 3600 + m * 60 + s) * fps) + f


def frames_to_tc(fr, fps):
    s, f = divmod(int(fr), fps)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h:02}:{m:02}:{s:02}:{f:02}"


def ripple_cut(text, cut_in, cut_len):
    """Возвращает (новый_текст, deleted, shifted). text — без BOM. Концы строк сохраняются."""
    eol = '\r\n' if '\r\n' in text else '\n'
    lines = text.split(eol)
    n = len(lines)
    cut_end = cut_in + cut_len

    out, deleted, shifted = [], [], 0
    idx = 0          # счётчик index внутри текущего SubTrack
    i = 0
    while i < n:
        line = lines[i]

        if SUBTRACK.search(line):
            idx = 0
            out.append(line); i += 1; continue

        if EVENT_OPEN.search(line):
            block = [line]
            j = i
            single = ('</Event>' in line) or (re.search(r'/>\s*$', line) is not None)
            if not single:
                j = i + 1
                while j < n:
                    block.append(lines[j])
                    if '</Event>' in lines[j]:
                        break
                    j += 1
            t = int(TIME_ATTR.search(line).group(2))

            if cut_in <= t < cut_end:                    # внутри реза -> удалить
                name = '?'
                for bl in block:
                    cm = CUE_NAME.search(bl)
                    if cm:
                        name = cm.group(1); break
                deleted.append((t, name))
                i = j + 1
                continue

            new_t = t - cut_len if t >= cut_end else t   # за окном -> сдвиг влево
            if new_t != t:
                shifted += 1
            head = TIME_ATTR.sub(lambda z: z.group(1) + str(new_t) + z.group(3), block[0], count=1)
            head = INDEX_ATTR.sub(lambda z: z.group(1) + str(idx) + z.group(3), head, count=1)
            idx += 1
            out.append(head)
            out.extend(block[1:])
            i = j + 1
            continue

        out.append(line); i += 1

    return eol.join(out), deleted, shifted


def main():
    ap = argparse.ArgumentParser(
        description='Ripple-рез окна из тайм-код шоу grandMA2 (байт-в-байт XML).')
    ap.add_argument('infile')
    ap.add_argument('outfile')
    ap.add_argument('--cut-in', required=True,
                    help='начало реза, абсолютный TC HH:MM:SS:FF')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--cut-out',
                   help='конец реза, абсолютный TC HH:MM:SS:FF (покадрово, без округления)')
    g.add_argument('--dur', type=float,
                   help='длина реза в секундах (округляется до кадров). По умолчанию 30')
    args = ap.parse_args()

    raw = open(args.infile, 'rb').read()
    bom = b'\xef\xbb\xbf'
    has_bom = raw.startswith(bom)
    text = (raw[len(bom):] if has_bom else raw).decode('utf-8')

    m = FRAME_FMT.search(text)
    if not m:
        sys.exit('frame_format не найден — это точно TC-шоу grandMA2?')
    fps = int(m.group(1))

    cut_in = tc_to_frames(args.cut_in, fps)
    if args.cut_out is not None:
        cut_out = tc_to_frames(args.cut_out, fps)
        if cut_out <= cut_in:
            sys.exit(f'--cut-out ({args.cut_out}) должен быть позже --cut-in ({args.cut_in})')
        cut_len = cut_out - cut_in
        dur_s = cut_len / fps
    else:
        dur_s = args.dur if args.dur is not None else 30.0
        cut_len = round(dur_s * fps)

    new_text, deleted, shifted = ripple_cut(text, cut_in, cut_len)
    open(args.outfile, 'wb').write((bom if has_bom else b'') + new_text.encode('utf-8'))

    cut_end = cut_in + cut_len
    print(f"fps={fps}  cut {frames_to_tc(cut_in, fps)} .. {frames_to_tc(cut_end, fps)}"
          f"  ({cut_len} кадров / {dur_s:.3f}s)")
    print(f"удалено событий в окне: {len(deleted)}   сдвинуто влево: {shifted}")
    for t, nm in sorted(deleted):
        print(f"  DEL {frames_to_tc(t, fps)}  {nm}")


if __name__ == '__main__':
    main()
