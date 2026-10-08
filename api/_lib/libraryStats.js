// One log line summarising the library's lengths, resolutions and bitrates,
// for sizing highlight analysis against Drive's daily download limit
// (Cloud Logging is the only place the numbers can be read from). Uses the
// same metadata listing as the library walk - no file contents are read.

const LENGTH_BUCKETS = [[5, '<5m'], [10, '5-10m'], [20, '10-20m'], [30, '20-30m'], [60, '30-60m'], [120, '1-2h'], [Infinity, '>2h']];
const CLASSES = [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [1, '<720p']];

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const mins = s => `${Math.round(s / 60)}m`;

export function libraryStats(videos) {
  const withLen = videos.filter(v => v.durationMs > 0);
  const hours = withLen.reduce((a, v) => a + v.durationMs, 0) / 3600e3;
  const tb = videos.reduce((a, v) => a + v.size, 0) / 1e12;

  const lengths = LENGTH_BUCKETS.map(([, label]) => [label, 0]);
  for (const v of withLen) {
    const m = v.durationMs / 60e3;
    lengths[LENGTH_BUCKETS.findIndex(([max]) => m < max)][1]++;
  }
  const allSecs = withLen.map(v => v.durationMs / 1000).sort((a, b) => a - b);

  const classes = CLASSES.map(([, label]) => ({ label, secs: [], mbps: [] }));
  let unknownRes = 0;
  for (const v of videos) {
    const short = Math.min(v.width, v.height);
    if (!short) { unknownRes++; continue; }
    const c = classes[CLASSES.findIndex(([min]) => short >= min)];
    if (v.durationMs > 0) {
      c.secs.push(v.durationMs / 1000);
      if (v.size) c.mbps.push(v.size * 8 / (v.durationMs / 1000) / 1e6);
    } else {
      c.secs.push(null);
    }
  }
  const classText = classes.filter(c => c.secs.length).map(c => {
    const secs = c.secs.filter(x => x !== null).sort((a, b) => a - b);
    const mbps = c.mbps.sort((a, b) => a - b);
    return `${c.label} ${c.secs.length} (length median ${mins(pct(secs, 0.5))}, p90 ${mins(pct(secs, 0.9))}; `
      + `bitrate median ${pct(mbps, 0.5).toFixed(0)} Mbps, p90 ${pct(mbps, 0.9).toFixed(0)})`;
  });

  return `library stats: ${videos.length} videos, ${hours.toFixed(0)} h, ${tb.toFixed(2)} TB`
    + ` | length: ${lengths.map(([l, n]) => `${l} ${n}`).join(', ')}, unknown ${videos.length - withLen.length}`
    + `; median ${mins(pct(allSecs, 0.5))}, p90 ${mins(pct(allSecs, 0.9))}`
    + ` | by resolution: ${classText.join(', ')}${unknownRes ? `, unknown ${unknownRes}` : ''}`;
}
