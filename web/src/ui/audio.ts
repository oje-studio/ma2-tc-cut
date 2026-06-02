// Decode an audio file and reduce it to waveform peaks, using the browser's
// native codecs via Web Audio (no miniaudio needed). Mirrors audio.py.

export interface DecodedAudio {
  buffer: AudioBuffer; // for playback
  peaks: Float32Array; // nBins of max|sample| in 0..1
  duration: number; // seconds
}

export async function decodeAudio(file: ArrayBuffer, nBins = 2000): Promise<DecodedAudio> {
  // Decode on a throwaway OfflineAudioContext so audio can load before any user
  // gesture — the real (output) AudioContext is created later, on first play.
  const Offline = (window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
      .webkitOfflineAudioContext) as typeof OfflineAudioContext;
  const ctx = new Offline(1, 1, 44100);
  // decodeAudioData detaches its argument, so hand it a copy.
  const buffer = await ctx.decodeAudioData(file.slice(0));
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
