import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player } from './player.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('audio position after MA3 event edits', () => {
  function setup() {
    const starts: number[][] = [];
    vi.useFakeTimers();
    vi.stubGlobal('window', { setInterval, clearInterval });
    vi.stubGlobal('AudioContext', class {
      currentTime = 100;
      sampleRate = 48000;
      state = 'running';
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
      createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start: (...args: number[]) => starts.push(args) }; }
    });
    const player = new Player();
    player.setAudio({ duration: 60 } as AudioBuffer);
    return { player, starts };
  }
  it('can play events before the audio origin without moving the song', async () => {
    const { player, starts } = setup();
    player.setShow(3590 * 25, 3650 * 25, 25, 3600 * 25);
    player.seekFrame(3595 * 25);
    await player.play();
    expect(starts[0]).toEqual([105, 0]); // 5 seconds of silence, then song sample zero
    player.pause();
  });
  it('seeking to the same show time plays the same audio sample even when the timeline starts earlier', async () => {
    const { player, starts } = setup();
    player.setShow(3590 * 25, 3650 * 25, 25, 3600 * 25);
    player.seekFrame(3612 * 25);
    await player.play();
    expect(starts[0]).toEqual([100, 12]);
    player.pause();
    player.setShow(3600 * 30, 3650 * 30, 30, 3600 * 30);
    player.seekFrame(3612 * 30);
    await player.play();
    expect(starts[1]).toEqual([100, 12]);
    player.pause();
  });
});
