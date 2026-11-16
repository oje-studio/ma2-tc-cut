// Shared UI contract: each format retains its own XML editor and timing units.
import * as ma2 from './tcshow.ts';
import * as edits from './cut.ts';
import { readMa3, ma3Summary, ma3Lanes, editMa3, moveMa3Event } from './ma3.ts';
import { readXml } from './xmlSpans.ts';
export { decodeShow, encodeShow } from './tcshow.ts';
export type ShowFormat = 'ma2' | 'ma3';

export function inspectShow(text: string, displayFps?: number) {
  const document = readXml(text)[0];
  if (document.tag !== 'GMA3' && document.tag !== 'MA') throw new Error('Expected a grandMA2 or grandMA3 Timecode XML export.');
  const format: ShowFormat = document.tag === 'GMA3' ? 'ma3' : 'ma2';
  if (format === 'ma2') {
    return { format, needsFps: false, info: ma2.summary(text), lanes: ma2.lanes(text), beat: ma2.estimateBeat(text) };
  }
  const show = readMa3(text);
  const fps = displayFps ?? show.fps ?? 30;
  const lanes = ma3Lanes(show, fps);
  return { format, needsFps: displayFps === undefined && show.fps === null, info: ma3Summary(show, fps), lanes,
    beat: ma2.estimateBeatGrid(lanes.map(l => l.events.map(e => e[0])), fps) };
}

export function editShow(text: string, format: ShowFormat, mode: 'cut' | 'insert' | 'erase', at: number, len: number, fps: number): edits.CutResult {
  if (format === 'ma3') return editMa3(text, mode, at, len, fps);
  if (mode === 'insert') return { ...edits.rippleInsert(text, at, len), deleted: [] };
  if (mode === 'erase') return { ...edits.eraseRange(text, at, at + len), shifted: 0 };
  return edits.rippleCut(text, at, len);
}

export function moveShowEvent(text: string, format: ShowFormat, lane: number, from: number, to: number, fps: number): edits.MoveResult {
  return format === 'ma3' ? moveMa3Event(text, lane, from, to, fps) : edits.moveEvent(text, lane, from, to);
}
