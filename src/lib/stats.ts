export type SessionStats = {
  rttMs: number | null;
  decodeMs: number | null;
  bitrateMbps: number | null;
  fps: number | null;
  packetLoss: number | null;
  resolution: string;
  transport: string;
  codec: string;
};

export type StatsSample = {
  timestamp: number;
  bytes: number;
  frames: number;
  decodeTime: number;
  packets: number;
  lost: number;
};

type Report = Record<string, unknown>;

export const EMPTY_STATS: SessionStats = {
  rttMs: null,
  decodeMs: null,
  bitrateMbps: null,
  fps: null,
  packetLoss: null,
  resolution: '—',
  transport: 'Sin conexión',
  codec: '—',
};

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Summarises a single live WebRTC statistics report. No estimated display latency. */
export function summarizeStats(
  reports: Report[],
  previous: StatsSample | null,
): { stats: SessionStats; sample: StatsSample | null } {
  const byId = new Map(reports.map((report) => [report.id, report]));
  const stream = reports.find((report) => report.type === 'inbound-rtp' && (report.kind ?? report.mediaType) === 'video')
    ?? reports.find((report) => report.type === 'outbound-rtp' && (report.kind ?? report.mediaType) === 'video');
  const transport = reports.find((report) => report.type === 'transport' && report.selectedCandidatePairId);
  const pair = (transport ? byId.get(transport.selectedCandidatePairId) : undefined)
    ?? reports.find((report) => report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected));
  const localCandidate = pair ? byId.get(pair.localCandidateId) : undefined;
  const remoteCandidate = pair ? byId.get(pair.remoteCandidateId) : undefined;
  const remoteInbound = reports.find((report) => report.type === 'remote-inbound-rtp' && (report.kind ?? report.mediaType) === 'video');
  const rtt = pair?.currentRoundTripTime ?? remoteInbound?.roundTripTime;
  const relay = localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay';
  const protocol = String(localCandidate?.protocol ?? remoteCandidate?.protocol ?? '').toUpperCase();
  const stats: SessionStats = {
    ...EMPTY_STATS,
    rttMs: typeof rtt === 'number' && Number.isFinite(rtt) ? rtt * 1000 : null,
    transport: pair ? `${relay ? 'Relay' : 'Directa'}${protocol ? ` · ${protocol}` : ''}` : 'Negociando ruta',
  };
  if (!stream) return { stats, sample: null };

  const inbound = stream.type === 'inbound-rtp';
  const sample: StatsSample = {
    timestamp: number(stream.timestamp),
    bytes: number(inbound ? stream.bytesReceived : stream.bytesSent),
    frames: number(inbound ? stream.framesDecoded : stream.framesEncoded),
    decodeTime: number(stream.totalDecodeTime),
    packets: number(stream.packetsReceived),
    lost: number(stream.packetsLost),
  };
  const elapsed = previous ? sample.timestamp - previous.timestamp : 0;
  const frames = previous ? sample.frames - previous.frames : 0;
  if (previous && elapsed > 0 && sample.bytes >= previous.bytes) {
    stats.bitrateMbps = ((sample.bytes - previous.bytes) * 8) / (elapsed * 1000);
    stats.fps = frames >= 0 ? (frames * 1000) / elapsed : null;
    if (inbound && frames > 0 && sample.decodeTime >= previous.decodeTime) {
      stats.decodeMs = ((sample.decodeTime - previous.decodeTime) * 1000) / frames;
    }
    const received = sample.packets - previous.packets;
    const lost = Math.max(0, sample.lost - previous.lost);
    if (inbound && received >= 0 && received + lost > 0) stats.packetLoss = (lost / (received + lost)) * 100;
  }
  if (typeof stream.framesPerSecond === 'number') stats.fps = stream.framesPerSecond;
  if (number(stream.frameWidth) > 0 && number(stream.frameHeight) > 0) {
    stats.resolution = `${stream.frameWidth} × ${stream.frameHeight}`;
  }
  const codec = byId.get(stream.codecId);
  if (typeof codec?.mimeType === 'string') stats.codec = codec.mimeType.split('/')[1].toUpperCase();
  return { stats, sample };
}

export async function collectSessionStats(connection: RTCPeerConnection, previous: StatsSample | null) {
  const report = await connection.getStats();
  const entries: Report[] = [];
  report.forEach((entry) => entries.push(entry as Report));
  return summarizeStats(entries, previous);
}
