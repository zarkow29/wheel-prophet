// Wheel Prophet — public board + API for the sealed calls.
// node:http only; the poller owns state.json, this process owns plays.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { make } = require('./lib/store');
const api = require('./lib/api');
const auth = require('./lib/auth');
const game = require('./lib/game');
const { BUCKETS } = require('./lib/model');

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const DOMAIN = process.env.DOMAIN || `localhost:${PORT}`;

const state = make('state.json', {});
const plays = make('plays.json', { rounds: {} });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 32 * 1024) reject(Object.assign(new Error('body too large'), { status: 413 })); });
    req.on('end', () => { if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
  });
}

function session(req) {
  const h = req.headers.authorization || '';
  const addr = auth.read(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!addr) throw Object.assign(new Error('sign in first'), { status: 401 });
  return addr;
}

function view(stateData) {
  const s = stateData;
  const config = s.config;
  const now = Date.now();
  const rm = config ? api.roundMath(config) : null;
  const roundId = rm ? rm.roundAt(now) : null;
  const round = roundId !== null ? s.rounds?.[roundId] : null;
  const last = Object.values(s.rounds || {}).filter((r) => r.closed && r.grade).sort((a, b) => b.roundId - a.roundId)[0] || null;
  const samples = s.samples || [];
  const telemetry = samples.slice(-4).map((x) => ({ at: x.at, coreStatus: x.coreStatus, rpmMilli: x.rpmMilli, speedMmPerSecond: x.speedMmPerSecond, cumulativeWorkUnits: x.cumulativeWorkUnits, blockProgress: x.blockProgress }));

  return {
    now: new Date(now).toISOString(),
    round: roundId === null ? null : {
      id: roundId,
      startAt: new Date(rm.startOf(roundId)).toISOString(),
      endAt: new Date(rm.endOf(roundId)).toISOString(),
      secondsLeft: Math.max(0, Math.round((rm.endOf(roundId) - now) / 1000)),
      openForCalls: !round || Date.parse(round.sealedAt) < rm.startOf(roundId) + 120000,
      call: round ? { bucket: round.prediction.bucket, bucketLabel: round.prediction.bucketLabel, pActive: round.prediction.pActive, expectedWork: round.prediction.expectedWork, why: round.prediction.why, inputs: round.prediction.inputs, hash: round.hash, sealedAt: round.sealedAt, recomputes: game.verifySeal(round) } : null,
      baselineBucket: round?.baselineBucket ?? null,
    },
    lastGraded: last ? { roundId: last.roundId, called: last.prediction.bucket, saw: last.grade.actualBucket, actualWork: last.grade.actualWork, hit: last.grade.hit, activeHit: last.grade.activeHit, absError: last.grade.absError, baselineHit: last.grade.baselineHit, closedAt: last.closedAt } : null,
    telemetry,
    chain: s.frontier || null,
    climatology: s.climatology ? { builtFrom: s.climatology.builtFrom, builtAt: s.climatologyAt, baseRate: s.climatology.baseRate, activeDays: s.climatology.activeDays } : null,
    settlement: s.summary ? { range: s.summary.range, summary: s.summary.summary, recent: (s.summary.recentSettlements || []).slice(0, 3) } : null,
    buckets: BUCKETS.map((b) => ({ id: b.id, label: b.label })),
  };
}

function scoresView() {
  const s = state.read((d) => d) || {};
  const scores = game.scores(s);
  const p = plays.read((d) => d) || { rounds: {} };
  const human = {};
  for (const [roundId, calls] of Object.entries(p.rounds || {})) {
    const r = s.rounds?.[roundId];
    const actual = r?.grade?.actualBucket;
    for (const [addr, call] of Object.entries(calls)) {
      human[addr] = human[addr] || { address: addr, calls: 0, hits: 0, activeHits: 0, pending: 0 };
      human[addr].calls += 1;
      if (!actual) { human[addr].pending += 1; continue; }
      if (call.bucket === actual) human[addr].hits += 1;
      if ((Number(r.actualWork) > 0) === (call.bucket !== 'zero')) human[addr].activeHits += 1;
    }
  }
  const leaderboard = Object.values(human)
    .map((h) => ({ ...h, accuracy: h.calls - h.pending ? h.hits / (h.calls - h.pending) : null }))
    .sort((a, b) => b.hits - a.hits || a.calls - b.calls);
  return { ai: scores, humans: leaderboard, plays: Object.keys(p.rounds || {}).length };
}

function staticFile(res, pathname) {
  const rel = pathname === '/' || pathname === '/play' || pathname === '/log' || pathname === '/scores' ? '/index.html'
    : pathname === '/overlay' ? '/overlay.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || DOMAIN}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    return staticFile(res, p);
  }

  try {
    const b = req.method === 'POST' ? await body(req) : {};
    const m = req.method;

    if (m === 'GET' && p === '/api/live') return send(res, 200, view(state.read((d) => d) || {}));
    if (m === 'GET' && p === '/api/health') {
      const s = state.read((d) => d) || {};
      return send(res, 200, { ok: true, startedAt: s.startedAt || null, rounds: Object.keys(s.rounds || {}).length, samples: (s.samples || []).length, lastSampleAt: (s.samples || []).slice(-1)[0]?.receivedAt || null });
    }
    if (m === 'GET' && p === '/api/scores') return send(res, 200, scoresView());
    if (m === 'GET' && p === '/api/chain') return send(res, 200, state.read((d) => d)?.frontier || { ok: false, error: 'no chain check yet' });
    if (m === 'GET' && p === '/api/buckets') return send(res, 200, { buckets: BUCKETS });

    if (m === 'GET' && p === '/api/log') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
      const s = state.read((d) => d) || {};
      const rows = Object.values(s.rounds || {})
        .sort((a, b2) => b2.roundId - a.roundId)
        .slice(0, limit)
        .map((r) => ({
          roundId: r.roundId,
          startAt: r.startAt,
          sealedAt: r.sealedAt,
          call: r.prediction,
          nonce: r.nonce,
          hash: r.hash,
          recomputes: game.verifySeal(r),
          closed: !!r.closed,
          result: r.grade || null,
          baselineBucket: r.baselineBucket ?? null,
        }));
      return send(res, 200, { count: rows.length, rounds: rows, how: 'sha256(roundId|pActive|expectedWork|bucket|nonce) is published at sealing time; recompute it from these fields to check nothing was edited' });
    }

    if (m === 'GET' && p === '/api/summary') {
      const s = state.read((d) => d) || {};
      return send(res, 200, {
        startedAt: s.startedAt,
        rounds: Object.keys(s.rounds || {}).length,
        samples: (s.samples || []).length,
        climatology: s.climatology ? { builtFrom: s.climatology.builtFrom, baseRate: s.climatology.baseRate, activeDays: s.climatology.activeDays, generatedAt: s.climatology.generatedAt } : null,
        chain: s.frontier || null,
        settlement: s.summary ? { range: s.summary.range, summary: s.summary.summary } : null,
        source: api.BASE,
      });
    }

    if (m === 'POST' && p === '/api/auth/challenge') return send(res, 200, auth.challenge(b.address, DOMAIN));
    if (m === 'POST' && p === '/api/auth/verify') {
      const v = auth.verify(b.address, b.signature);
      return send(res, 200, { address: v.address, token: v.token, expiresAt: v.expiresAt });
    }

    if (m === 'POST' && p === '/api/play') {
      const addr = session(req);
      const s = state.read((d) => d) || {};
      const rm = s.config ? api.roundMath(s.config) : null;
      if (!rm) throw Object.assign(new Error('poller has not read the configuration yet'), { status: 503 });
      const roundId = Number(b.roundId);
      if (!Number.isInteger(roundId)) throw Object.assign(new Error('roundId required'), { status: 400 });
      const open = rm.roundAt(Date.now());
      if (roundId !== open) throw Object.assign(new Error(`round ${roundId} is not open (open: ${open})`), { status: 409 });
      if (!BUCKETS.some((x) => x.id === b.bucket)) throw Object.assign(new Error('unknown bucket'), { status: 400 });
      const record = plays.mutate((d) => {
        d.rounds[roundId] = d.rounds[roundId] || {};
        d.rounds[roundId][addr.toLowerCase()] = { bucket: b.bucket, at: new Date().toISOString(), address: addr };
        return d.rounds[roundId][addr.toLowerCase()];
      });
      return send(res, 200, { you: { roundId, ...record }, closesAt: new Date(rm.endOf(roundId)).toISOString() });
    }

    return send(res, 404, { error: 'no such endpoint' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`wheel-prophet board on http://${HOST}:${PORT} · domain ${DOMAIN} · ethers ${ethers.version}`);
});
