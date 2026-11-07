// Squeekchain public API client (read-only, no key) + the handful of rules we rely on.
const BASE = 'https://api.squeekchain.com';
const UA = 'wheel-prophet/1.0 (+https://github.com/)';

async function get(pathAndQuery, { retries = 2 } = {}) {
  const url = `${BASE}${pathAndQuery}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status === 503) {
        if (attempt >= retries) throw new Error(`${res.status} on ${pathAndQuery}`);
        const wait = Number(res.headers.get('retry-after') || 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathAndQuery}: ${JSON.stringify(body).slice(0, 160)}`);
      return body;
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const status = () => get('/v1/status');
const core = () => get('/v1/core');
const stats = (range = '7d') => get(`/v1/measurement/stats?range=${range}`);
const events = (limit = 40) => get(`/v1/events?limit=${limit}`);
const settlements = (range = '24h') => get(`/v1/settlements?range=${range}`);

// Round arithmetic, straight from SqueekCore's configuration as /v1/core reports it.
function roundMath(config) {
  const genesis = Number(config.genesisTimestamp);
  const duration = Number(config.roundDuration);
  return {
    genesis,
    duration,
    roundAt: (ms) => Math.floor((Math.floor(ms / 1000) - genesis) / duration),
    startOf: (roundId) => (genesis + roundId * duration) * 1000,
    endOf: (roundId) => (genesis + (roundId + 1) * duration) * 1000,
  };
}

module.exports = { get, status, core, stats, events, settlements, roundMath, BASE };
