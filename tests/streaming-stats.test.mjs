import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_STATS, summarizeStats } from '../src/lib/stats.ts';

test('RTC counters produce measured bitrate, decode time, FPS and interval packet loss', () => {
  const previous = { timestamp: 1000, bytes: 1000, frames: 30, decodeTime: 0.03, packets: 100, lost: 0 };
  const { stats } = summarizeStats([
    { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 2000, bytesReceived: 1001000, framesDecoded: 90,
      totalDecodeTime: 0.15, packetsReceived: 199, packetsLost: 1, frameWidth: 1920, frameHeight: 1080, codecId: 'codec' },
    { id: 'codec', type: 'codec', mimeType: 'video/VP9' },
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'pair', type: 'candidate-pair', currentRoundTripTime: 0.024, localCandidateId: 'local', remoteCandidateId: 'remote' },
    { id: 'local', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
  ], previous);
  assert.equal(stats.bitrateMbps, 8);
  assert.equal(stats.fps, 60);
  assert.equal(stats.decodeMs, 2);
  assert.equal(stats.packetLoss, 1);
  assert.equal(stats.rttMs, 24);
  assert.equal(stats.resolution, '1920 × 1080');
  assert.equal(stats.codec, 'VP9');
  assert.equal(stats.transport, 'Directa · UDP');
});

test('first report does not invent bitrate, decode time, packet loss or FPS', () => {
  const { stats } = summarizeStats([
    { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, bytesReceived: 100000, framesDecoded: 30 },
  ], null);
  assert.equal(stats.bitrateMbps, null);
  assert.equal(stats.decodeMs, null);
  assert.equal(stats.packetLoss, null);
  assert.equal(stats.fps, null);
  assert.equal(stats.rttMs, null);
});

test('relay route is reported explicitly and missing video is not claimed to be streaming', () => {
  const { stats, sample } = summarizeStats([
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local' },
    { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' },
  ], null);
  assert.equal(stats.transport, 'Relay · TCP');
  assert.equal(sample, null);
  assert.equal(stats.codec, EMPTY_STATS.codec);
  assert.equal(stats.resolution, '—');
});
