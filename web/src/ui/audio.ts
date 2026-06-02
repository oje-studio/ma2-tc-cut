// Decode an audio file and reduce it to waveform peaks, using the browser's
// native codecs via Web Audio (no miniaudio needed). Mirrors audio.py.

export interface DecodedAudio {
  buffer: AudioBuffer; // for playback
  peaks: Float32Array; // nBins of max|sample| in 0..1
  duration: number; // seconds
}

export async function decodeAudio(file: ArrayBuffer, peaksPerSec = 400): Promise<DecodedAudio> {
  // Decode on a throwaway OfflineAudioContext so audio can load before any user
  // gesture — the real (output) AudioContext is created later, on first play.
  const Offline = (window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext) as typeof OfflineAudioContext;
  const ctx = new Offline(1, 1, 44100);
  // decodeAudioData detaches its argument, so hand it a copy.
  const buffer = await ctx.decodeAudioData(file.slice(0));
  // resolution scales with length so the waveform stays detailed when zoomed in
  const nBins = Math.min(80000, Math.max(2000, Math.round(buffer.duration * peaksPerSec)));
  return { buffer, peaks: peaksFrom(buffer, nBins), duration: buffer.duration };
}

export function peaksFrom(buffer: AudioBuffer, nBins: number): Float32Array {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const peaks = new Float32Array(nBins);
  if (len === 0) return peaks;
  const datas: Float32Array[] = [];
  for (let c = 0; c < ch; c++) datas.push(buffer.getChannelData(c));
  const binSize = len / nBins;
  for (let b = 0; b < nBins; b++) {
    const start = Math.floor(b * binSize);
    const end = Math.min(len, Math.floor((b + 1) * binSize));
    let mx = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.abs(datas[c][i]);
        if (v > mx) mx = v;
      }
    }
    peaks[b] = mx;
  }
  return peaks;
}

/** Estimate tempo (BPM) from a peak envelope: autocorrelation of its onset flux,
 *  octave-folded into a musical 90–180 range. null if the clip is too short. */
export function estimateBpmFromPeaks(peaks: Float32Array, rate: number): number | null {
  const n = peaks.length;
  if (rate <= 0 || n < rate * 4) return null;
  // onset strength = positive first difference of the envelope
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = peaks[i] - peaks[i - 1];
    onset[i] = d > 0 ? d : 0;
  }
  const minLag = Math.max(2, Math.round((rate * 60) / 200)); // ≤ 200 BPM
  const maxLag = Math.round((rate * 60) / 60); //               ≥ 60 BPM
  if (maxLag <= minLag) return null;
  const ac = new Float64Array(maxLag + 2);
  let bestLag = minLag;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s;
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (best <= 0) return null;
  // parabolic interpolation around the peak for sub-lag precision
  const y0 = ac[bestLag - 1] ?? 0;
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  let bpm = (rate * 60) / (bestLag + offset);
  while (bpm < 90) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 2) / 2; // nearest 0.5
}
