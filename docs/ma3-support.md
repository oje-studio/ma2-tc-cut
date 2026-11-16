# grandMA3 Timecode Tools

Browser editor entry: `#tool/ma3`. The existing MA2 entry and the Python CLI/GUI
remain available. This edits a grandMA3 export; it does not convert MA2 shows.

Target: **grandMA3 2.5.1**. Status: **compatibility preview**. The demo and regression
fixtures are synthetic. Neither a real 2.5.1 export nor an onPC/console round-trip
has been validated yet; do not describe this as verified 2.5.1 compatibility.

## Workflow

1. Export one Timecode pool object as XML, for example `Export Timecode 14 "tc_show"`.
2. Load the XML and the song in MA3 Timecode Tools.
3. If Frame Readout is Default or Seconds (or omitted), choose the source FPS.
   Supported editing grids: 24, 25, 30 and 60 fps. An explicit Frame Readout is
   used initially and can be changed. Changing the grid does not retime the XML.
4. Preview and apply Cut, Insert, Erase or drag an event. Undo restores the exact
   previous XML. Audio and cue fades are not edited.
   The original audio/bar-grid origin is retained after MA3 edits, including
   erasing the first events and changing the display FPS.
5. Save the XML to the timecodes library on the selected drive. On USB this is
   `grandMA3/gma3_library/datapools/timecodes`. On Windows onPC the folder is
   `C:\ProgramData\MALightingTechnology\gma3_library\datapools\timecodes`.
   Import into an empty slot, for example:
   `Import Timecode Library "tc_show_cut.xml" At Timecode 40`.
6. Check cue destinations, absolute event times, range boundaries and fader
   transitions in grandMA3 before using the file in a show.

## Timing and preservation

- MA3 event `Time` values are seconds relative to the parent Time Range's `Start`.
  The editor operates on their sum, in show time. `OffsetTCSlot` is left untouched.
- Decimal seconds, `1h02m03.040`, day-prefixed unit notation and `01:02:03.040`
  are accepted. Changed times are written as decimal seconds. Untouched times
  retain their original spelling and subframe precision. Edits round to one
  nanosecond; this avoids forcing all source times onto the selected frame grid.
- Cut deletes events in `[in, out)` and shifts everything at/after `out` left.
  Insert shifts events at/after the insertion point right. Range starts, finite
  durations, markers and the finite show duration follow the same time mapping.
  `Duration="To End"` stays relative to the end of the show.
- Erase removes events and markers starting inside the window without shifting
  later events or changing range/show durations.
- Each command/fader subtrack in each Time Range gets its own timeline lane.
  Moving an event reorders its siblings by time and can extend its range/show
  duration. It cannot move before its range start or into another range.
- Only relevant time attributes and whole removed/reordered elements change.
  GUIDs, cue/sequence destinations, command payloads, unrelated XML, BOM, quotes
  and line endings remain intact. No XML serializer rewrites the document.
- Fader points move/delete as events. The editor does not synthesize interpolated
  boundary points or reconstruct the lighting state across a cut.

## Supported structure and limitations

`GMA3 → Timecode → TrackGroup → Track → TimeRange → CmdSubTrack / FaderSubTrack
→ CmdEvent / FaderEvent`, plus Time Ranges under MarkerTrack.

One Timecode object per export. Time Ranges require Speed Factor 1 (or omitted).
Other speed factors, unknown children in this hierarchy, missing event times,
malformed times/XML, DTDs and ambiguous multi-show exports are rejected before
replacing the current loaded show. This intentionally fails visibly when the
schema is unrecognized. Modern console exports may reveal additional forms that
need fixtures and implementation before support can be claimed.

## Validation

Run `npm ci`, `npm test` and `npm run build` inside `web/`.
Tests cover half-open boundaries, nonzero range starts, cuts crossing range
starts, multiple ranges, faders, markers, fractional seconds, 30 fps rounding,
insert/cut inversion, sorting after a move, empty results, BOM/CRLF, malformed
input, reference preservation and the existing MA2 demo.

Release check still needed on 2.5.1: export a small representative show containing
multiple ranges, Go+/Goto/Off and fader events, edit it, import into an unused
pool slot, compare event counts/times/targets, and play across both edit edges.

## Format evidence

- [MA Lighting: Folder Structure](https://help.malighting.com/grandMA3/2.5/HTML/fm_folder_structure.html)
  documents the current library hierarchy, including `datapools/timecodes`.
- [MA Lighting: Time Ranges](https://help.malighting.com/grandMA3/2.4/HTML/timceode_time_ranges.html)
  documents that events are children of ranges and that absolute time is event
  time plus range start.
- [MA Lighting: Timecode Viewer](https://help.malighting.com/grandMA3/2.4/HTML/timecode_viewer.html)
  describes Start, Duration, Speed Factor and absolute/relative event times.
- [MA Lighting: Import](https://help.malighting.com/grandMA3/2.3/HTML/keyword_import.html)
  documents the `Import [Object] Library ... At ...` syntax.
- [Public generated XML example](https://github.com/edendolev1/Reaper_Markers_GrandMA3/blob/4933ca3a1a23efa9691ca241b4ad7e8e9574ec2e/venv/Example_timecode.xml)
  and [older exported XML](https://github.com/bozi6/hello-world/blob/2ce55daa1b4f5f3ab8b72689527d05d9a9f8af7c/ma3_xmls_factory/orig/vivaldi_timecode.xml)
  informed the attribute/spans adapter. They are older format evidence, not proof
  of 2.5.1 compatibility, and are not copied into the repository.
