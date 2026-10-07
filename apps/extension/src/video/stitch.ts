/**
 * Join rolling-buffer WebM segments into one playable WebM without re-encoding.
 *
 * Each segment was produced by its own MediaRecorder, so it is a complete file that starts
 * with a keyframe. We demux every segment, shift its packets onto a shared timeline using the
 * segment's wall-clock start, drop the *tail* of a segment where it overlaps the next one
 * (tails are safe to cut; heads are not, because the head holds the keyframe), and remux.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, Input, Output, WebMOutputFormat } from 'mediabunny';

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
  let audioSource: EncodedAudioPacketSource | undefined;
  let codec: string | undefined;
  let audioCodec: string | undefined;
  let started = false;
  let packets = 0;
  let dropped = 0;
  const base = sorted[0]!.start;
  /** timestamp (s) of the last packet written per track; the output must be strictly increasing */
  let lastTs = -1;
  let lastAudioTs = -1;
  const FRAME = 0.1; // nominal frame spacing used for durations and the final end estimate
  const EPS = 0.001;

  // Decide the track layout from the first segment (all segments come from the same recorder setup).
  {
    const probe = new Input({ source: new BlobSource(sorted[0]!.blob), formats: ALL_FORMATS });
    try {
      const v = await probe.getPrimaryVideoTrack();
      const a = await probe.getPrimaryAudioTrack();
      if (!v || !v.codec) throw new Error('no decodable video track in segments');
      codec = v.codec;
      source = new EncodedVideoPacketSource(v.codec);
      // no frameRate hint: it makes the muxer quantise timestamps to the frame grid, which merges close frames
      output.addVideoTrack(source);
      if (a?.codec) {
        audioCodec = a.codec;
        audioSource = new EncodedAudioPacketSource(a.codec);
        output.addAudioTrack(audioSource);
      }
      await output.start();
      started = true;
    } finally {
      probe.dispose();
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const next = sorted[i + 1];
    const input = new Input({ source: new BlobSource(seg.blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !track.codec || track.codec !== codec) continue; // skip segments that do not match the layout
      const decoderConfig = (await track.getDecoderConfig()) ?? undefined;
      const meta = decoderConfig ? { decoderConfig } : undefined;
      const sink = new EncodedPacketSink(track);
      const first = await sink.getFirstPacket();
      if (!first) continue;
      // Place the segment on the shared timeline by its wall-clock start. If that would collide with
      // what is already written (clock skew), shift the WHOLE segment forward: never reorder or drop
      // frames inside a segment, because delta frames depend on their predecessors.
      let offsetSec = (seg.start - base) / 1000;
      const firstTs = first.timestamp + offsetSec;
      if (firstTs <= lastTs) offsetSec += lastTs + EPS - firstTs;
      // Cut this segment's tail where the next segment begins, so each moment is written once.
      const cutSec = next ? (next.start - base) / 1000 : Number.POSITIVE_INFINITY;
      let packet: typeof first | null = first;
      let isFirst = true;
      while (packet) {
        const ts = packet.timestamp + offsetSec;
        if (!isFirst && ts >= cutSec) {
          dropped++;
        } else {
          const outTs = ts <= lastTs ? lastTs + EPS : ts;
          await source!.add(packet.clone({ timestamp: outTs, duration: Math.min(packet.duration || FRAME, 0.5) }), isFirst ? meta : undefined);
          lastTs = outTs;
          packets++;
        }
        isFirst = false;
        packet = await sink.getNextPacket(packet);
      }

      // Audio (microphone narration from the window recorder): same offset and cut, Opus packets are independent.
      if (audioSource && audioCodec) {
        const atrack = await input.getPrimaryAudioTrack();
        if (atrack?.codec === audioCodec) {
          const aconf = (await atrack.getDecoderConfig()) ?? undefined;
          const ameta = aconf ? { decoderConfig: aconf } : undefined;
          const asink = new EncodedPacketSink(atrack);
          let ap = await asink.getFirstPacket();
          let aFirst = true;
          while (ap) {
            const ts = ap.timestamp + offsetSec;
            if (ts < cutSec && ts > lastAudioTs) {
              await audioSource.add(ap.clone({ timestamp: ts }), aFirst ? ameta : undefined);
              lastAudioTs = ts;
              aFirst = false;
            }
            ap = await asink.getNextPacket(ap);
          }
        }
      }
    } finally {
      input.dispose();
    }
  }

  if (!started || !source) throw new Error('no decodable video track in segments');
  source.close();
  audioSource?.close();
  await output.finalize();
  if (!target.buffer) throw new Error('muxer produced no output');
  const blob = new Blob([target.buffer], { type: 'video/webm' });
  return { blob, start: base, end: Math.round(base + (lastTs + FRAME) * 1000), packets, droppedOverlapPackets: dropped };
}
