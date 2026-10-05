/**
 * Join rolling-buffer WebM segments into one playable WebM without re-encoding.
 *
 * Each segment was produced by its own MediaRecorder, so it is a complete file that starts
 * with a keyframe. We demux every segment, shift its packets onto a shared timeline using the
 * segment's wall-clock start, drop the *tail* of a segment where it overlaps the next one
 * (tails are safe to cut; heads are not, because the head holds the keyframe), and remux.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Output, WebMOutputFormat } from 'mediabunny';

export interface StitchSegment {
  blob: Blob;
  /** wall-clock ms when this segment's recorder started */
  start: number;
  end: number;
}

export interface StitchResult {
  blob: Blob;
  start: number;
  end: number;
  packets: number;
  droppedOverlapPackets: number;
}

export async function stitchWebm(segments: StitchSegment[]): Promise<StitchResult> {
  const sorted = [...segments].filter((s) => s.blob.size > 0).sort((a, b) => a.start - b.start);
  if (!sorted.length) throw new Error('no video segments');

  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  let source: EncodedVideoPacketSource | undefined;
  let codec: string | undefined;
  let started = false;
  let packets = 0;
  let dropped = 0;
  const base = sorted[0]!.start;
  let timelineEnd = 0;

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const next = sorted[i + 1];
    const input = new Input({ source: new BlobSource(seg.blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !track.codec) continue;
      if (!source) {
        codec = track.codec;
        source = new EncodedVideoPacketSource(track.codec);
        output.addVideoTrack(source, { frameRate: 10 });
        await output.start();
        started = true;
      } else if (track.codec !== codec) {
        // codec changed between segments (should not happen); stop here rather than produce a broken file
        break;
      }
      const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
      const meta = decoderConfig ? { decoderConfig } : undefined;
      const sink = new EncodedPacketSink(track);
      const offsetSec = (seg.start - base) / 1000;
      // where to stop this segment: the next segment's start, so overlaps are removed once
      const cutSec = next ? (next.start - base) / 1000 : Number.POSITIVE_INFINITY;
      let packet = await sink.getFirstPacket();
      let firstInSegment = true;
      while (packet) {
        const ts = packet.timestamp + offsetSec;
        if (ts >= cutSec && !firstInSegment) {
          dropped++;
        } else if (ts >= timelineEnd || firstInSegment) {
          await source.add(packet.clone({ timestamp: Math.max(ts, timelineEnd) }), firstInSegment ? meta : undefined);
          timelineEnd = Math.max(timelineEnd, ts + (packet.duration || 0.1));
          packets++;
        } else {
          dropped++;
        }
        firstInSegment = false;
        packet = await sink.getNextPacket(packet);
      }
    } finally {
      input.dispose();
    }
  }

  if (!started || !source) throw new Error('no decodable video track in segments');
  source.close();
  await output.finalize();
  if (!target.buffer) throw new Error('muxer produced no output');
  const blob = new Blob([target.buffer], { type: 'video/webm' });
  return { blob, start: base, end: Math.round(base + timelineEnd * 1000), packets, droppedOverlapPackets: dropped };
}
