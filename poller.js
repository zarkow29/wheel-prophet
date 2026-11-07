// The poller: samples the pipeline, seals a call for every round, grades itself.
// Run it once with `node poller.js --once` (what the tests do) or leave it looping.
const path = require('path');
const { make } = require('./lib/store');
const api = require('./lib/api');
const chain = require('./lib/chain');
const { buildClimatology, predict } = require('./lib/model');
const game = require('./lib/game');

const SAMPLE_MS = Number(process.env.SAMPLE_MS || 15000);
const SEAL_WINDOW_MS = 120000; // a call must be sealed in the first two minutes of its round
const CLIMATOLOGY_MS = 60 * 60 * 1000;
const CHAIN_MS = 5 * 60 * 1000;

const store = make('state.json', {
  startedAt: null,
  config: null,
  samples: [],
  rounds: {},
  climatology: null,
  climatologyAt: null,
  frontier: null,
  frontierAt: null,
  summary: null,
  events: [],
});

function log(state, type, detail) {
  state.events.unshift({ at: new Date().toISOString(), type, detail });
  state.events.length = Math.min(state.events.length, 200);
}

async function ensureConfig(state, now) {
  if (state.config && now - Date.parse(state.config.readAt) < 10 * 60 * 1000) return state.config;
  const core = await api.core();
  if (core.status !== 'available') throw new Error('core state unavailable');
  const c = core.configuration;
  state.config = {
    readAt: new Date().toISOString(),
    genesisTimestamp: Number(c.genesisTimestamp),
    roundDuration: Number(c.roundDuration),
    maxWorkPerRound: Number(c.maxWorkPerRound),
    release: core.releaseId || core.installationId || null,
    settledThroughRound: Number(core.core.settledThroughRound),
  };
  log(state, 'CONFIG', `genesis ${state.config.genesisTimestamp}, ${state.config.roundDuration}s rounds`);
  return state.config;
}

async function sample(state, status) {
  const m = status.measurement || {};
  state.samples.push({
    at: m.observedAt || status.generatedAt,
    receivedAt: new Date().toISOString(),
    cumulativeWorkUnits: m.cumulativeWorkUnits ?? null,
    coreStatus: m.coreStatus ?? null,
    rpmMilli: m.rpmMilli ?? null,
    speedMmPerSecond: m.speedMmPerSecond ?? null,
    distanceMm: m.distanceMm ?? null,
    freshness: m.freshness ?? null,
    blockHeight: status.builder?.anchor?.blockHeight ?? null,
    blockProgress: status.builder?.anchor?.blockProgress ?? null,
    settledThroughRound: status.builder?.anchor?.settledThroughRound ?? null,
    workPerThousandBlocks: status.builder?.anchor?.workPerThousandBlocks ?? null,
    oracleState: status.oracle?.state ?? null,
  });
  if (state.samples.length > 3000) state.samples.splice(0, state.samples.length - 3000);
}

function recentRounds(state, n = 6) {
  return Object.values(state.rounds)
    .filter((r) => r.closed)
    .sort((a, b) => a.roundId - b.roundId)
    .slice(-n)
    .map((r) => ({ roundId: r.roundId, work: r.actualWork }));
}

async function tick(state, { now = Date.now(), status } = {}) {
  const s = status || (await api.status());
  await ensureConfig(state, now);
  const rm = api.roundMath(state.config);

  await sample(state, s);

  if (!state.climatologyAt || now - Date.parse(state.climatologyAt) > CLIMATOLOGY_MS) {
    try {
      const stats = await api.stats('7d');
      state.climatology = buildClimatology(stats, { roundSeconds: state.config.roundDuration });
      state.climatologyAt = new Date().toISOString();
      log(state, 'CLIMATOLOGY', `rebuilt from ${state.climatology.builtFrom}, base rate ${state.climatology.baseRate.toFixed(2)}`);
    } catch (e) {
      log(state, 'CLIMATOLOGY_FAILED', e.message);
    }
  }

  // 1. seal a call for the round that is open now — but only while the round is young.
  //    A round the poller missed is left without a call: no backfilling, ever.
  const current = rm.roundAt(now);
  const sealedInTime = now <= rm.startOf(current) + SEAL_WINDOW_MS;
  if (!state.rounds[current] && !sealedInTime) {
    state.rounds[current] = { roundId: current, startAt: new Date(rm.startOf(current)).toISOString(), endAt: new Date(rm.endOf(current)).toISOString(), closed: false, skipped: `round was already ${Math.round((now - rm.startOf(current)) / 1000)}s old when this poller first saw it` };
    log(state, 'CALL_SKIPPED', `round ${current} was already open — no call sealed, no backfill`);
  }
  if (!state.rounds[current] && sealedInTime) {
    const p = predict({
      roundId: current,
      now,
      live: s,
      recent: recentRounds(state),
      climatology: state.climatology,
    });
    const slot = state.climatology?.slots?.[require('./lib/model').slotFor(new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes())];
    state.rounds[current] = {
      roundId: current,
      startAt: new Date(rm.startOf(current)).toISOString(),
      endAt: new Date(rm.endOf(current)).toISOString(),
      openedAt: new Date(now).toISOString(),
      prediction: p,
      baselineBucket: slot?.modeBucket ?? null,
      ...game.seal(p),
      closed: false,
    };
    log(state, 'CALL_SEALED', `round ${current}: ${p.bucket} (p=${p.pActive}, ~${p.expectedWork} work) hash ${state.rounds[current].hash.slice(0, 12)}…`);
  }

  // 2. close and grade whatever is finished
  for (const id of game.closedRounds(state, now)) {
    const r = game.closeRound(state, id, now);
    if (r?.grade) log(state, 'GRADED', `round ${id}: ${r.grade.hit ? 'hit' : 'miss'} — ${r.actualWork} work`);
  }

  // 3. periodically re-read the certified frontier from the chain itself
  if (!state.frontierAt || now - Date.parse(state.frontierAt) > CHAIN_MS) {
    try {
      state.frontier = await chain.verifyFrontier();
      state.frontierAt = new Date().toISOString();
      log(state, 'CHAIN_CHECK', state.frontier.ok ? `identities verified, settledThroughRound ${state.frontier.frontier.settledThroughRound}` : 'identity mismatch');
    } catch (e) {
      state.frontier = { ok: false, error: e.message, readAt: new Date().toISOString() };
      state.frontierAt = new Date().toISOString();
      log(state, 'CHAIN_CHECK_FAILED', e.message);
    }
  }

  // 4. keep a settlement summary for the board
  try {
    state.summary = await api.settlements('24h');
  } catch (e) {
    log(state, 'SUMMARY_FAILED', e.message);
  }

  state.startedAt = state.startedAt || new Date().toISOString();
  store.mutate((d) => Object.assign(d, state, { samples: state.samples, rounds: state.rounds, events: state.events }));
  return { round: current, sealed: !!state.rounds[current], scores: game.scores(state) };
}

async function main() {
  const once = process.argv.includes('--once');
  const s = store.read((d) => d) || {};
  const state = {
    startedAt: s.startedAt || null,
    config: s.config || null,
    samples: s.samples || [],
    rounds: s.rounds || {},
    climatology: s.climatology || null,
    climatologyAt: s.climatologyAt || null,
    frontier: s.frontier || null,
    frontierAt: s.frontierAt || null,
    summary: s.summary || null,
    events: s.events || [],
  };
  if (once) {
    const out = await tick(state);
    console.log(JSON.stringify({ round: out.round, sealed: out.sealed, scores: { attempts: out.scores.attempts, accuracy: out.scores.accuracy } }, null, 1));
    return;
  }
  console.log(`wheel-prophet poller: sampling every ${SAMPLE_MS} ms`);
  for (;;) {
    try {
      const out = await tick(state);
      if (out.scores.attempts) process.stdout.write(`\rround ${out.round} · ${out.scores.hits}/${out.scores.attempts} calls right · ${(out.scores.accuracy * 100).toFixed(0)}%`);
    } catch (e) {
      console.error(`\ntick failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
}

if (require.main === module) main();
module.exports = { tick, store, SAMPLE_MS, SEAL_WINDOW_MS };
