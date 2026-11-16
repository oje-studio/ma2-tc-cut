import { framesToTc } from './frames.ts';
import type { Lane, ShowSummary } from './tcshow.ts';
import type { CutResult, MoveResult } from './cut.ts';
import { readXml, attr, setAttr, patchXml } from './xmlSpans.ts';
import type { XmlNode, Patch } from './xmlSpans.ts';

// MA3 XML times are seconds, NOT frame counts. Keep subframe timestamps intact.
// Integer nanoseconds make comparisons at cut boundaries deterministic.
const TICKS = 1e9;
const FPS = [24, 25, 30, 60];
const ticks = (seconds: number): number => {
  const value = Math.round(seconds * TICKS);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Time is outside the supported range.');
  return value;
};

export function parseMa3Time(value: string): number {
  const s = value.trim();
  const decimal = /^(?:\d+(?:\.\d{1,9})?|\.\d{1,9})s?$/.exec(s);
  if (decimal) return ticks(Number(s.replace(/s$/, '')));
  const units = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d{1,9})?)s?$/.exec(s);
  if (units && /[dhm]/.test(s)) return ticks(Number(units[1] || 0) * 86400 + Number(units[2] || 0) * 3600 + Number(units[3] || 0) * 60 + Number(units[4]));
  const colon = /^(\d+):(\d{2}):(\d{2}(?:\.\d{1,9})?)$/.exec(s);
  if (colon && Number(colon[2]) < 60 && Number(colon[3]) < 60) return ticks(Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]));
  throw new Error(`Unsupported grandMA3 time: "${value}". Export with Frame Readout set to Seconds.`);
}

export function formatMa3Time(time: number): string {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid grandMA3 time.');
  const whole = Math.floor(time / TICKS);
  const fraction = String(time % TICKS).padStart(9, '0').replace(/0+$/, '').padEnd(3, '0');
  return `${whole}.${fraction}`;
}

interface Event { node: XmlNode; time: number; name: string }
interface Range { node: XmlNode; start: number; duration: number | null; marker: boolean }
interface TrackLane { node: XmlNode; range: Range; name: string; events: Event[] }
export interface Ma3Show {
  root: XmlNode;
  ranges: Range[];
  lanes: TrackLane[];
  fps: number | null;
  duration: number | null;
}

function timeAttr(n: XmlNode, key: string, fallback = 0): number {
  const value = attr(n, key);
  return value === undefined ? fallback : parseMa3Time(value);
}
function duration(n: XmlNode): number | null {
  const v = attr(n, 'Duration');
  return v === undefined || v === 'To End' ? null : parseMa3Time(v);
}
function children(n: XmlNode, tags: string[]): void {
  for (const c of n.children) if (!tags.includes(c.tag)) {
    throw new Error(`Unsupported grandMA3 element ${c.tag} inside ${n.tag}. The file has not been changed.`);
  }
}

export function readMa3(text: string): Ma3Show {
  const document = readXml(text)[0];
  if (document.tag !== 'GMA3') throw new Error('Expected a grandMA3 Timecode XML export.');
  const shows = document.children.filter(n => n.tag === 'Timecode');
  if (shows.length !== 1) throw new Error('Export one grandMA3 Timecode pool object at a time.');
  const root = shows[0];
  const readout = (attr(root, 'FrameReadout') || 'Default').replace(/[<>]/g, '');
  const match = /^(24|25|30|60)\s*fps$/i.exec(readout);
  const fps = match ? Number(match[1]) : null;
  if (!fps && !['default', 'seconds'].includes(readout.toLowerCase())) throw new Error(`Unsupported Frame Readout: ${readout}.`);
  const ranges: Range[] = [];
  const lanes: TrackLane[] = [];
  children(root, ['TrackGroup']);
  for (const [gi, group] of root.children.entries()) {
    children(group, ['Track', 'MarkerTrack']);
    for (const [ti, track] of group.children.entries()) {
      children(track, ['TimeRange']);
      for (const [ri, rangeNode] of track.children.entries()) {
        if (Number(attr(rangeNode, 'SpeedFactor') ?? '1') !== 1) {
          throw new Error('Time Ranges with Speed Factor other than 1 are not supported yet.');
        }
        const range: Range = { node: rangeNode, start: timeAttr(rangeNode, 'Start'), duration: duration(rangeNode), marker: track.tag === 'MarkerTrack' };
        ranges.push(range);
        children(rangeNode, range.marker ? [] : ['CmdSubTrack', 'FaderSubTrack']);
        for (const sub of rangeNode.children) {
          children(sub, [sub.tag === 'CmdSubTrack' ? 'CmdEvent' : 'FaderEvent']);
          const events = sub.children.map(node => {
            if (attr(node, 'Time') === undefined) throw new Error(`${node.tag} has no Time attribute.`);
            const time = range.start + timeAttr(node, 'Time');
            const cmd = node.children.find(c => c.tag === 'RealtimeCmd');
            const name = attr(node, 'CueDestination') || (cmd && attr(cmd, 'ValCueDestination')) || attr(node, 'Name') || node.tag;
            return { node, time, name };
          });
          const groupName = attr(group, 'Name') || `Group ${gi + 1}`;
          const trackName = attr(track, 'Name') || attr(track, 'Target') || `Track ${ti + 1}`;
          const rangeName = attr(rangeNode, 'Name') || `Range ${ri + 1}`;
          lanes.push({ node: sub, range, name: `${groupName} / ${trackName} / ${rangeName}${sub.tag === 'FaderSubTrack' ? ' · Fader' : ''}`, events });
        }
      }
    }
  }
  return { root, ranges, lanes, fps, duration: duration(root) };
}

export function ma3Lanes(show: Ma3Show, fps: number): Lane[] {
  return show.lanes.map(l => ({ name: l.name, events: l.events.map(e => [e.time / TICKS * fps, e.name]) }));
}

export function ma3Summary(show: Ma3Show, fps: number): ShowSummary {
  let first = Infinity;
  let last = 0;
  let count = 0;
  for (const lane of show.lanes) for (const event of lane.events) {
    first = Math.min(first, event.time);
    last = Math.max(last, event.time);
    count++;
  }
  first = Number.isFinite(first) ? first : 0;
  // Preserve the tail of a show even if its last cue is erased.
  last = Math.max(last, show.duration ?? 0);
  const firstFrame = first / TICKS * fps;
  const lastFrame = last / TICKS * fps;
  return { fps, name: attr(show.root, 'Name') || '(unnamed)', nEvents: count, nSubtracks: show.lanes.length,
    firstFrame, lastFrame, firstTc: framesToTc(firstFrame, fps), lastTc: framesToTc(lastFrame, fps) };
}

function patchTime(n: XmlNode, key: string, oldTime: number, newTime: number, patches: Patch[]): void {
  if (oldTime === newTime) return;
  if (n.attrs.has(key)) setAttr(n, key, formatMa3Time(newTime), patches);
  else {
    // Omitted Start means zero. Insert only when a ripple changes that default.
    const position = n.start + 1 + n.tag.length;
    patches.push({ start: position, end: position, value: ` ${key}="${formatMa3Time(newTime)}"` });
  }
}

export function editMa3(text: string, mode: 'cut' | 'insert' | 'erase', atFrame: number, lengthFrames: number, fps: number): CutResult {
  if (!FPS.includes(fps) || !Number.isFinite(atFrame) || atFrame < 0 || !Number.isFinite(lengthFrames) || lengthFrames <= 0) throw new Error('Choose a valid time and a positive length.');
  const show = readMa3(text);
  const at = ticks(atFrame / fps);
  const len = ticks(lengthFrames / fps);
  const end = at + len;
  const inside = (t: number): boolean => t >= at && t < end;
  const map = (t: number): number => mode === 'erase' ? t : mode === 'insert' ? (t >= at ? t + len : t) : (t >= end ? t - len : t >= at ? at : t);
  const patches: Patch[] = [];
  const deleted: Array<[number, string]> = [];
  let shifted = 0;
  const removed = new Set<Range>();
  for (const range of show.ranges) {
    if (range.marker && mode !== 'insert' && inside(range.start)) {
      patches.push({ start: range.node.start, end: range.node.end, value: '' });
      removed.add(range);
      continue;
    }
    const start = map(range.start);
    patchTime(range.node, 'Start', range.start, start, patches);
    if (range.duration !== null && mode !== 'erase') {
      const oldEnd = range.start + range.duration;
      // A gap exactly at a range's end belongs to what follows it.
      const newEnd = mode === 'insert' && oldEnd === at && range.start < at ? oldEnd : map(oldEnd);
      patchTime(range.node, 'Duration', range.duration, Math.max(0, newEnd - start), patches);
    }
  }
  for (const lane of show.lanes) {
    if (removed.has(lane.range)) continue;
    for (const e of lane.events) {
      if (mode !== 'insert' && inside(e.time)) {
        patches.push({ start: e.node.start, end: e.node.end, value: '' });
        deleted.push([e.time / TICKS * fps, e.name]);
      } else {
        const time = map(e.time);
        if (time !== e.time) shifted++;
        patchTime(e.node, 'Time', e.time - lane.range.start, time - map(lane.range.start), patches);
      }
    }
  }
  if (show.duration !== null && mode !== 'erase') patchTime(show.root, 'Duration', show.duration, map(show.duration), patches);
  return { text: patchXml(text, patches), deleted, shifted };
}

export function moveMa3Event(text: string, laneIndex: number, from: number, to: number, fps: number): MoveResult {
  if (!FPS.includes(fps) || !Number.isFinite(from) || !Number.isFinite(to) || to < 0) throw new Error('Invalid event time.');
  const show = readMa3(text);
  const lane = show.lanes[laneIndex];
  const event = lane?.events.find(e => e.time === ticks(from / fps));
  if (!lane || !event) return { text, moved: false };
  const time = ticks(to / fps);
  if (time === event.time) return { text, moved: false };
  if (time < lane.range.start) throw new Error('Move this event within its Time Range; it cannot precede the range start.');
  const edits: Patch[] = [];
  patchTime(event.node, 'Time', event.time - lane.range.start, time - lane.range.start, edits);
  const changed = patchXml(text, edits).slice(event.node.start, event.node.end + edits.reduce((sum, p) => sum + p.value.length - (p.end - p.start), 0));
  const sorted = lane.events.map(e => ({ ...e, time: e === event ? time : e.time, xml: e === event ? changed : text.slice(e.node.start, e.node.end) })).sort((a, b) => a.time - b.time);
  const patches: Patch[] = lane.events.map((e, i) => ({ start: e.node.start, end: e.node.end, value: sorted[i].xml }));
  if (lane.range.duration !== null && time > lane.range.start + lane.range.duration) patchTime(lane.range.node, 'Duration', lane.range.duration, time - lane.range.start, patches);
  if (show.duration !== null && time > show.duration) patchTime(show.root, 'Duration', show.duration, time, patches);
  return { text: patchXml(text, patches), moved: true };
}
