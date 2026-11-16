import { describe, expect, it } from 'vitest';
import demoMa3 from '../../public/demo/demo_ma3.xml?raw';
import demoMa2 from '../../public/demo/demo_show.xml?raw';
import { parseMa3Time, formatMa3Time, readMa3, ma3Lanes, editMa3, moveMa3Event } from './ma3.ts';
import { inspectShow, editShow } from './show.ts';
import { encodeShow, decodeShow } from './tcshow.ts';
import { framesToTc } from './frames.ts';

// Synthetic fixture, not a claimed onPC round-trip. Deliberately includes offsets,
// subframe times, multiple ranges, command payloads, markers and fader events.
const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<GMA3 DataVersion="2.5.1.0">
  <Timecode Name="Test &amp; show" Duration="1h00m30.000" OffsetTCSlot="5.000" FrameReadout="25 fps">
    <TrackGroup Name="Lighting">
      <MarkerTrack><TimeRange Name="Intro" Start="3600.000" Duration="10.000"/><TimeRange Name="Cut marker" Start="3605.000" Duration="1.000"/></MarkerTrack>
      <Track Name="Key" Target="ShowData.DataPools.Default.Sequences.Key">
        <TimeRange Name="Verse" Start="1h00m00.000" Duration="20.000" SpeedFactor="1">
          <CmdSubTrack>
            <CmdEvent Name="Go+" Time="0.001" CueDestination="Before"><RealtimeCmd Object="keep.object" ValCueDestination="keep.cue"/></CmdEvent>
            <CmdEvent Name="Goto" Time="5.000" CueDestination="At in"><RealtimeCmd Status="On"/></CmdEvent>
            <CmdEvent Name="Goto" Time="9.999" CueDestination="Inside"/>
            <CmdEvent Name="Goto" Time="10.000" CueDestination="At out" Guid="keep.guid"/>
            <CmdEvent Name="Off" Time="15.123456" CueDestination="After"/>
          </CmdSubTrack>
          <FaderSubTrack Name="Master"><FaderEvent Time="3.000" Value="100"/><FaderEvent Time="12.000" Value="20"/></FaderSubTrack>
        </TimeRange>
        <TimeRange Name="Outro" Start="3620.000" Duration="To End"><CmdSubTrack><CmdEvent Time="1.000" Name="Off"/></CmdSubTrack></TimeRange>
      </Track>
    </TrackGroup>
  </Timecode>
</GMA3>`;
const seconds = (xml: string) => readMa3(xml).lanes.map(l => l.events.map(e => e.time / 1e9));

// Synthetic reproduction of the structure observed in a real 2.5.1.1 export.
// The user's show, cue names, destinations and GUIDs are not repository fixtures.
const consoleStyle = `<?xml version="1.0" encoding="UTF-8"?>
<GMA3 DataVersion="2.5.1.1">
  <Timecode Name="Console layout test" Cursor="1h00m30.03" Duration="1h00m25.77" LoopCount="0" TCSlot="1" AutoStop="No" SwitchOff="Keep Playbacks" TimeDisplayFormat="" FrameReadout="30 fps">
    <TrackGroup Name="Test group" Play="" Rec="">
      <MarkerTrack Name="Marker" Guid="synthetic.marker"/>
      <Track Name="Test track" Target="ShowData.DataPools.Default.Sequences.Test" Play="" Rec="">
        <TimeRange Guid="synthetic.range" Duration="To End" Play="" Rec="">
          <CmdSubTrack>
            <CmdEvent Name="Goto" Time="1h00m00.000" CueDestination="A"><RealtimeCmd ExecToken="Goto" ValCueDestination="synthetic.a"/></CmdEvent>
            <CmdEvent Name="Goto" Time="1h00m02.867" CueDestination="B"><RealtimeCmd ExecToken="Goto" ValCueDestination="synthetic.b"/></CmdEvent>
            <CmdEvent Name="Goto" Time="1h00m14.233" CueDestination="C"><RealtimeCmd ExecToken="Goto" ValCueDestination="synthetic.c"/></CmdEvent>
            <CmdEvent Name="Goto" Time="1h00m25.733" CueDestination="D"><RealtimeCmd ExecToken="Goto" ValCueDestination="synthetic.d"/></CmdEvent>
          </CmdSubTrack>
        </TimeRange>
      </Track>
    </TrackGroup>
  </Timecode>
</GMA3>`;

describe('2.5.1.1 console export structure', () => {
  it('reads omitted range starts, empty marker tracks and h/m time strings with mixed precision', () => {
    const parsed = inspectShow(consoleStyle);
    expect(parsed.needsFps).toBe(false);
    expect(parsed.info.fps).toBe(30);
    expect(parsed.info.firstTc).toBe('01:00:00:00');
    expect(parsed.info.nEvents).toBe(4);
    expect(parsed.info.nSubtracks).toBe(1);
    expect(seconds(consoleStyle)).toEqual([[3600, 3602.867, 3614.233, 3625.733]]);
    expect(readMa3(consoleStyle).duration).toBe(3625.77e9);
    expect(editMa3(consoleStyle, 'erase', 3700 * 30, 30, 30).text).toBe(consoleStyle);
  });
  it('cuts in seconds without rounding millisecond timestamps to the display frame grid', () => {
    const result = editMa3(consoleStyle, 'cut', 3610 * 30, 5 * 30, 30);
    expect(result.deleted.map(e => e[1])).toEqual(['C']);
    expect(result.shifted).toBe(1);
    expect(seconds(result.text)).toEqual([[3600, 3602.867, 3620.733]]);
    expect(readMa3(result.text).duration).toBe(3620.77e9);
    expect(result.text).toContain('Time="1h00m02.867"');
    expect(result.text).toContain('<RealtimeCmd ExecToken="Goto" ValCueDestination="synthetic.d"/>');
    expect(result.text).toContain('Duration="To End" Play="" Rec=""');
    expect(result.text).toContain('Cursor="1h00m30.03"');
    expect(result.text).not.toContain('Start=');
  });
  it('finds events from fractional timeline frames and reverses a gap without timing drift', () => {
    const from = ma3Lanes(readMa3(consoleStyle), 30)[0].events[1][0];
    const moved = moveMa3Event(consoleStyle, 0, from, from + 30, 30);
    expect(moved.moved).toBe(true);
    expect(seconds(moved.text)[0][1]).toBe(3603.867);
    const inserted = editMa3(consoleStyle, 'insert', 3610 * 30, 5 * 30, 30).text;
    expect(seconds(editMa3(inserted, 'cut', 3610 * 30, 5 * 30, 30).text)).toEqual(seconds(consoleStyle));
  });
});

describe('MA3 timestamp semantics', () => {
  it('displays decimal-second frame boundaries without losing a frame or showing frame 30', () => {
    expect(framesToTc(3.433333333 * 30, 30)).toBe('00:00:03:13');
    expect(framesToTc(59.999999999 * 30, 30)).toBe('00:01:00:00');
    expect(framesToTc(3.999 * 30, 30)).toBe('00:00:03:29');
  });
  it.each([['0.001', .001], ['12.345678901', 12.345678901], ['1h02m03.040', 3723.04], ['1d01h02m03.004', 90123.004], ['01:02:03.040', 3723.04]])('reads %s as seconds', (input, sec) => {
    expect(parseMa3Time(input)).toBe(Math.round(sec * 1e9));
    expect(parseMa3Time(formatMa3Time(parseMa3Time(input)))).toBe(parseMa3Time(input));
  });
  it.each(['NaN', '-1', '00:00:00:10', 'garbage', '1.1junk', '99999999999999', '01:99:00'])('rejects unsupported time %s', value => {
    expect(() => parseMa3Time(value)).toThrow();
  });
  it('uses absolute event time = range start + event time without baking in TC slot offset', () => {
    const parsed = inspectShow(fixture);
    expect(parsed.info.name).toBe('Test & show');
    expect(parsed.format).toBe('ma3');
    expect(parsed.info.nEvents).toBe(8);
    expect(parsed.info.nSubtracks).toBe(3);
    expect(parsed.lanes[0].events[0][0]).toBeCloseTo(3600.001 * 25);
    expect(parsed.info.lastFrame).toBe(3630 * 25);
  });
  it('requires an explicit editing FPS for Default, Seconds and missing FrameReadout', () => {
    for (const value of ['Default', '&lt;Seconds&gt;', 'Seconds']) {
      const xml = fixture.replace('25 fps', value);
      expect(inspectShow(xml).needsFps).toBe(true);
      expect(inspectShow(xml, 30).needsFps).toBe(false);
      expect(inspectShow(xml, 30).info.fps).toBe(30);
    }
    expect(inspectShow(fixture.replace(' FrameReadout="25 fps"', '')).needsFps).toBe(true);
  });
});

describe('MA3 editing', () => {
  it('cuts a half-open window across ranges and faders, preserving references and exact subframe remainders', () => {
    const result = editMa3(fixture, 'cut', 3605 * 25, 5 * 25, 25);
    expect(result.deleted.map(d => d[1])).toEqual(['At in', 'Inside']);
    expect(result.shifted).toBe(4);
    expect(seconds(result.text)).toEqual([[3600.001, 3605, 3610.123456], [3603, 3607], [3616]]);
    expect(result.text).toContain('OffsetTCSlot="5.000"');
    expect(result.text).toContain('Object="keep.object" ValCueDestination="keep.cue"');
    expect(result.text).toContain('Guid="keep.guid"');
    expect(result.text).toContain('Duration="3625.000"');
    expect(result.text).toContain('Name="Verse" Start="1h00m00.000" Duration="15.000"');
    expect(result.text).not.toContain('Cut marker');
  });
  it('handles a cut crossing a range start without negative local times or double shifts', () => {
    const result = editMa3(fixture, 'cut', 3598 * 25, 10 * 25, 25);
    expect(seconds(result.text)).toEqual([[3599.999, 3600, 3605.123456], [3602], [3611]]);
    expect(readMa3(result.text).lanes[0].range.start / 1e9).toBe(3598);
    expect(result.text).not.toContain('Time="-');
  });
  it('inserts at the boundary, extending crossing ranges and translating later ranges once', () => {
    const result = editMa3(fixture, 'insert', 3605 * 25, 5 * 25, 25);
    expect(result.deleted).toEqual([]);
    expect(result.shifted).toBe(6);
    expect(seconds(result.text)).toEqual([[3600.001, 3610, 3614.999, 3615, 3620.123456], [3603, 3617], [3626]]);
    expect(result.text).toContain('Duration="3635.000"');
    expect(result.text).toContain('Duration="25.000"');
  });
  it('erase removes only events and markers in the window, preserving all remaining time and duration attributes', () => {
    const result = editMa3(fixture, 'erase', 3605 * 25, 5 * 25, 25);
    expect(result.shifted).toBe(0);
    expect(seconds(result.text)).toEqual([[3600.001, 3610, 3615.123456], [3603, 3612], [3621]]);
    expect(result.text).toContain('Duration="1h00m30.000"');
    expect(result.text).toContain('Duration="20.000"');
  });
  it('moves one event, sorts within its subtrack and leaves command data and other ranges intact', () => {
    const result = moveMa3Event(fixture, 0, 3610 * 25, 3602 * 25, 25);
    expect(result.moved).toBe(true);
    expect(seconds(result.text)[0]).toEqual([3600.001, 3602, 3605, 3609.999, 3615.123456]);
    expect(result.text).toContain('CueDestination="At out" Guid="keep.guid"');
    expect(readMa3(result.text).lanes[1].events).toHaveLength(2);
    expect(() => moveMa3Event(fixture, 0, 3610 * 25, 3599 * 25, 25)).toThrow(/range start/);
  });
  it('preserves BOM, CRLF, declaration, comments and no trailing newline', () => {
    const original = '\uFEFF' + fixture.replace('<CmdSubTrack>', '<!-- <CmdEvent Time="99"/> -->\n          <CmdSubTrack>').replaceAll('\n', '\r\n');
    const result = editMa3(original, 'insert', 3605 * 25, 25, 25).text;
    expect(result.startsWith('\uFEFF<?xml')).toBe(true);
    expect(result).toContain('<!-- <CmdEvent Time="99"/> -->');
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(result.endsWith('</GMA3>')).toBe(true);
    const bytes = encodeShow(result.slice(1), true);
    expect(decodeShow(bytes.buffer as ArrayBuffer)).toEqual({ hasBom: true, text: result.slice(1) });
  });
  it('does not quantize untouched events to whole frames', () => {
    const result = editMa3(fixture, 'cut', 3605 * 30, 1, 30).text;
    expect(result).toContain('Time="0.001"');
    expect(seconds(result)[0].at(-1)).toBeCloseTo(3615.123456 - 1 / 30, 8);
  });
  it('supports omitted Start, single quotes, multiline attributes and empty shows', () => {
    const xml = `<GMA3><Timecode FrameReadout='30 fps' Duration='5.000'><TrackGroup><Track><TimeRange Duration='To End'><CmdSubTrack><CmdEvent\nTime='0.000'/></CmdSubTrack></TimeRange></Track></TrackGroup></Timecode></GMA3>`;
    const shifted = editMa3(xml, 'insert', 0, 30, 30).text;
    expect(seconds(shifted)).toEqual([[1]]);
    expect(shifted).toContain('Start="1.000"');
    const erased = editMa3(xml, 'erase', 0, 30, 30).text;
    expect(inspectShow(erased).info.nEvents).toBe(0);
    expect(inspectShow(erased).info.lastFrame).toBe(150);
  });
  it('round-trips an inserted gap with a cut and preserves all event times', () => {
    for (const at of [0, 3599, 3600, 3605, 3620, 3635]) {
      const inserted = editMa3(fixture, 'insert', at * 25, 3 * 25, 25).text;
      const cut = editMa3(inserted, 'cut', at * 25, 3 * 25, 25).text;
      expect(seconds(cut)).toEqual(seconds(fixture));
    }
  });
  it('rejects unsupported structures and malformed XML before editing', () => {
    for (const xml of [fixture.replace('SpeedFactor="1"', 'SpeedFactor="2"'), fixture.replace('<CmdSubTrack>', '<UnknownSubTrack>'), fixture.replace('Time="5.000"', 'Time="NaN"'), fixture.replace('</GMA3>', ''), fixture.replace('Time="5.000"', 'Time="5.000" Time="6.000"')]) {
      expect(() => editMa3(xml, 'cut', 0, 25, 25)).toThrow();
    }
    expect(() => editMa3(fixture, 'cut', 0, 0, 25)).toThrow();
  });
  it('edits the shipped synthetic MA3 demo', () => {
    const xml = demoMa3;
    expect(inspectShow(xml).info.nEvents).toBeGreaterThan(50);
    const edited = editMa3(xml, 'cut', 300, 150, 30).text;
    expect(ma3Lanes(readMa3(edited), 30).length).toBeGreaterThan(1);
  });
});

describe('shared editor regression', () => {
  it('still detects and edits the existing MA2 demo using frame counts', () => {
    const xml = demoMa2;
    const before = inspectShow(xml);
    expect(before.format).toBe('ma2');
    const inserted = editShow(xml, 'ma2', 'insert', 0, 30, before.info.fps);
    const after = inspectShow(inserted.text);
    expect(after.info.nEvents).toBe(before.info.nEvents);
    expect(after.info.firstFrame).toBe(before.info.firstFrame + 30);
    expect(after.info.lastFrame).toBe(before.info.lastFrame + 30);
    expect(editShow(inserted.text, 'ma2', 'cut', 0, 30, 30).text).toBe(xml);
  });
});
