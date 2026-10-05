// Inspect a WebM produced by TestLens: packet timestamps, key frames, gaps, monotonicity.
// Usage: node e2e/inspect-webm.mjs e2e/.out/recording_*.webm
import fs from 'node:fs';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const input = new Input({ source: new BlobSource(new Blob([buf])), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
if (!track) throw new Error('no video track');
console.log('codec', track.codec, `${track.codedWidth}x${track.codedHeight}`, 'duration', (await input.computeDuration()).toFixed(3));
const sink = new EncodedPacketSink(track);
let p = await sink.getFirstPacket();
let n = 0, keys = 0, nonMonotonic = 0, dup = 0, maxGap = 0, prev = -1, prevType = '';
const gaps = [];
const dups = [];
while (p) {
  n++;
  if (p.type === 'key') keys++;
  if (prev >= 0) {
    const gap = p.timestamp - prev;
    if (gap < 0) nonMonotonic++;
    if (gap === 0) {
      dup++;
      dups.push(`#${n} ${prevType}→${p.type} @${p.timestamp.toFixed(3)}`);
    }
    if (gap > maxGap) maxGap = gap;
    if (gap > 0.5) gaps.push({ at: prev.toFixed(3), gap: gap.toFixed(3) });
  }
  if (n <= 3 || p.type === 'key') console.log(`  #${n} ${p.type.padEnd(5)} ts=${p.timestamp.toFixed(3)} dur=${p.duration.toFixed(3)} bytes=${p.byteLength}`);
  prev = p.timestamp;
  prevType = p.type;
  p = await sink.getNextPacket(p);
}
console.log({ packets: n, keyframes: keys, nonMonotonic, duplicateTimestamps: dup, maxGap: maxGap.toFixed(3), bigGaps: gaps, dups });
input.dispose();
