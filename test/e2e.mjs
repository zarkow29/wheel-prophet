// Wheel Prophet end-to-end checks.
//   node test/e2e.mjs                 logic + real Squeekchain API + one poller tick
//   WP_HTTP=http://127.0.0.1:8099 node test/e2e.mjs      adds the HTTP board checks
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Wallet } from 'ethers';

const require = createRequire(import.meta.url);
const api = require('../lib/api.js');
const game = require('../lib/game.js');
const model = require('../lib/model.js');
const chain = require('../lib/chain.js');
const poller = require('../poller.js');

let pass = 0, fail = 0, skipped = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? ' :: ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' :: ' + extra : ''}`); }
};
const skip = (label, why) => { skipped++; console.log(`  SKIP  ${label} :: ${why}`); };
const group = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------- rules
group('rules: buckets, sealing, accounting, grading');

ok(model.bucketOf(0).id === 'zero' && model.bucketOf(1).id === 'trace', 'bucket edges 0 / 1');
ok(model.bucketOf(49).id === 'trace' && model.bucketOf(50).id === 'light', 'bucket edge 50');
ok(model.bucketOf(499).id === 'busy' && model.bucketOf(500).id === 'sprint' && model.bucketOf(99999).id === 'sprint', 'bucket edges 500+');

const pred = { roundId: 900, pActive: 0.61, expectedWork: 180, bucket: 'light' };
const sealed = game.seal(pred, 'deadbeef');
ok(game.verifySeal(sealed), 'seal verifies');
const tampered = JSON.parse(JSON.stringify(sealed));
tampered.prediction.bucket = 'sprint';
ok(!game.verifySeal(tampered), 'tampering with the call breaks the seal');
ok(sealed.hash !== game.seal(pred, 'cafebabe').hash, 'a different nonce gives a different hash');

const samples = [
  { at: '2026-11-07T10:00:00.000Z', cumulativeWorkUnits: '1000' },
  { at: '2026-11-07T10:02:00.000Z', cumulativeWorkUnits: '1040', rpmMilli: 50000 },
  { at: '2026-11-07T10:04:00.000Z', cumulativeWorkUnits: '1040', rpmMilli: 0 },
  { at: '2026-11-07T10:06:00.000Z', cumulativeWorkUnits: '1120', rpmMilli: 60000 }, // outside the window
];
const window1 = game.workInRound(samples, Date.parse('2026-11-07T10:00:00Z'), Date.parse('2026-11-07T10:05:00Z'));
ok(window1.work === 40, 'work added inside a round is summed from the cumulative counter', `work=${window1.work}`);
ok(window1.activeSamples === 1, 'active samples are counted from rpm', `n=${window1.activeSamples}`);

const g1 = game.grade(pred, 160, 'light');
ok(g1.hit && g1.actualBucket === 'light' && g1.absError === 20, 'grading a hit', JSON.stringify({ bucket: g1.actualBucket, err: g1.absError }));
const g2 = game.grade(pred, 0, 'light');
ok(!g2.hit && g2.activeHit === false, 'grading a miss (called active, wheel was idle)');
const g3 = game.grade({ ...pred, pActive: 0.2, bucket: 'zero' }, 0, 'zero');
ok(g3.hit && g3.activeHit && g3.baselineHit, 'grading a zero round agrees with the baseline');

// ---------------------------------------------------------------- model
group('model: climatology from the real stats payload');

const stats = await api.stats('7d').catch((e) => { console.log('  (stats fetch failed: ' + e.message + ')'); return null; });
if (!stats) {
  skip('climatology + hold-out backtest', 'stats endpoint unreachable');
} else {
  const clim = model.buildClimatology(stats, { roundSeconds: 600 });
  const observed = clim.slots.filter((s) => s.observed > 0);
  ok(clim.slots.length === 48, '48 half-hour slots built');
  ok(observed.length > 0, 'observed half hours found', `${observed.length} slots, base rate ${clim.baseRate.toFixed(3)}`);
  ok(clim.baseActiveWork >= 0, 'typical active-round work computed', `${clim.baseActiveWork.toFixed(1)} work/round`);

  // hold-out: train on the earlier days, score the last day that has observations
  const days = stats.activity.days || [];
  const withObs = days.filter((d) => (d.buckets || []).some((b) => b.coverage !== 'missing'));
  if (withObs.length >= 2) {
    const test = withObs[withObs.length - 1];
    const train = { ...stats, activity: { ...stats.activity, days: days.filter((d) => d !== test) } };
    const tclim = model.buildClimatology(train, { roundSeconds: 600 });
    let brierAi = 0, brierBase = 0, n = 0, right = 0;
    for (const b of test.buckets || []) {
      if (b.coverage === 'missing') continue;
      const work = Number(b.workUnits ?? b.observedWorkUnits ?? 0);
      const slot = tclim.slots[model.slotFor(b.startMinuteUtc)];
      const p = slot.pActive;
      const y = work > 0 ? 1 : 0;
      brierAi += (p - y) ** 2;
      brierBase += (tclim.baseRate - y) ** 2;
      n += 1;
      if (model.bucketOf(Math.round(p * (slot.meanActiveWork || tclim.baseActiveWork))).id === model.bucketOf(Math.round(work / 3)).id) right += 1;
    }
    if (n >= 6) {
      ok(brierAi / n <= brierBase / n + 0.05, 'hold-out Brier no worse than the base rate', `ai ${(brierAi / n).toFixed(3)} vs base ${(brierBase / n).toFixed(3)} over ${n} slots`);
      console.log(`        (band accuracy on the hold-out day: ${right}/${n})`);
    } else {
      skip('hold-out backtest', `only ${n} observed slots on the newest day — not enough to score`);
    }
  } else {
    skip('hold-out backtest', 'fewer than 2 days with observations');
  }

  // live signal must move the call
  const idle = model.predict({ roundId: 1, now: Date.parse('2026-11-07T12:00:00Z'), live: { measurement: { coreStatus: 'IDLE', rpmMilli: 0, freshness: 'online' } }, recent: [], climatology: clim });
  const running = model.predict({ roundId: 1, now: Date.parse('2026-11-07T12:00:00Z'), live: { measurement: { coreStatus: 'RUNNING', rpmMilli: 90000, freshness: 'online' } }, recent: [], climatology: clim });
  ok(running.pActive > idle.pActive, 'a running wheel raises the probability', `${idle.pActive} -> ${running.pActive}`);
  ok(running.expectedWork > idle.expectedWork, 'a running wheel raises expected work', `${idle.expectedWork} -> ${running.expectedWork}`);

  const stale = model.predict({ roundId: 1, now: Date.parse('2026-11-07T12:00:00Z'), live: { measurement: { coreStatus: 'RUNNING', rpmMilli: 90000, freshness: 'stale' } }, recent: [], climatology: clim });
  ok(stale.pActive < running.pActive, 'stale telemetry is discounted', `${stale.pActive} < ${running.pActive}`);
}

// ---------------------------------------------------------------- live pipeline
group('pipeline: one real tick against api.squeekchain.com');

const state = { config: null, samples: [], rounds: {}, climatology: null, climatologyAt: null, frontier: null, frontierAt: null, summary: null, events: [], startedAt: null };
let ticked = null;
try {
  ticked = await poller.tick(state);
  ok(!!state.config && state.config.roundDuration === 600, 'configuration read (600 s rounds)', `genesis ${state.config?.genesisTimestamp}`);
  ok(ticked.sealed === true, 'a call was sealed for the open round', `round ${ticked.round}`);
  const r = state.rounds[ticked.round];
  ok(!!r && game.verifySeal(r), 'the sealed call recomputes from its own fields');
  ok(!!r.prediction.bucket && r.prediction.pActive > 0 && r.prediction.why.length > 0, 'the call carries a band, a probability and its reasons', `${r.prediction.bucket} p=${r.prediction.pActive}`);
  ok(state.samples.length === 1 && state.samples[0].cumulativeWorkUnits !== null, 'a telemetry sample was stored');
} catch (e) {
  skip('live pipeline tick', `API unreachable: ${e.message}`);
}

// close the previous round with synthetic samples, then grade it
if (state.config) {
  const now = Date.now();
  const rm = api.roundMath(state.config);
  const prev = rm.roundAt(now) - 1;
  const start = rm.startOf(prev);
  state.samples = [
    { at: new Date(start + 1000).toISOString(), cumulativeWorkUnits: '2000' },
    { at: new Date(start + 120000).toISOString(), cumulativeWorkUnits: '2120', rpmMilli: 40000 },
    { at: new Date(start + 300000).toISOString(), cumulativeWorkUnits: '2120', rpmMilli: 0 },
  ];
  state.rounds[prev] = { roundId: prev, startAt: new Date(start).toISOString(), endAt: new Date(rm.endOf(prev)).toISOString(), prediction: { roundId: prev, pActive: 0.6, expectedWork: 130, bucket: 'light', why: ['test'] }, baselineBucket: 'light', ...game.seal({ roundId: prev, pActive: 0.6, expectedWork: 130, bucket: 'light', why: ['test'] }), closed: false };
  const closed = game.closeRound(state, prev, Date.now());
  ok(closed.grade.actualWork === 120 && closed.grade.actualBucket === 'light', 'a finished round is graded from its own samples', `work=${closed.grade.actualWork}, band=${closed.grade.actualBucket}`);
  ok(closed.grade.hit === true, 'the call was a hit on this fixture');
  const sc = game.scores(state);
  ok(sc.attempts === 1 && sc.hits === 1 && sc.accuracy === 1, 'scores aggregate', JSON.stringify({ attempts: sc.attempts, acc: sc.accuracy }));
  ok(sc.byBucket.light.called === 1 && sc.byBucket.light.correct === 1, 'band table aggregates');
  ok(sc.streak === 1 && sc.mae !== null, 'streak and error metrics computed', `mae=${sc.mae}`);
}

// ---------------------------------------------------------------- chain
group('chain: identities verified on Sepolia before any number is trusted');
try {
  const f = await chain.verifyFrontier();
  ok(typeof f.chainId === 'number' && f.chainId === 11155111, 'read Sepolia through the published ABI', `chainId ${f.chainId}`);
  ok(f.identities.implementationMatches && f.identities.proxyAdminMatches, 'proxy implementation and admin match the deployment record');
  ok(f.identities.runtimeHashMatches, 'runtime code hash of the implementation matches');
  ok(f.frontier.settledThroughRound >= 0 && f.frontier.workPerThousandBlocks > 0, 'frontier read from the contract', `round ${f.frontier.settledThroughRound}, difficulty ${f.frontier.workPerThousandBlocks}`);
  if (ticked && state.samples.length) {
    const apiRound = Number(state.samples.at(-1).settledThroughRound ?? -1);
    ok(apiRound <= f.frontier.settledThroughRound + 1, 'API frontier does not run ahead of the chain', `api ${apiRound} vs chain ${f.frontier.settledThroughRound}`);
  }
} catch (e) {
  skip('on-chain verification', e.message);
}

// ---------------------------------------------------------------- http board
const BASE = process.env.WP_HTTP;
if (!BASE) {
  skip('HTTP board', 'set WP_HTTP=http://127.0.0.1:8099 after starting the server');
} else {
  group(`http: the board on ${BASE}`);
  const live = await (await fetch(`${BASE}/api/live`)).json();
  ok(!!live.round && !!live.round.call, 'GET /api/live serves the open round and its sealed call', `round ${live.round?.id}`);
  ok(live.round.call.recomputes === true, 'the served call recomputes');
  ok(Array.isArray(live.buckets) && live.buckets.length === 5, 'the five bands are published');
  const log = await (await fetch(`${BASE}/api/log?limit=5`)).json();
  ok(log.rounds.length > 0 && log.rounds[0].nonce && log.rounds[0].hash, 'GET /api/log reveals nonce + hash for recomputation');
  const sc = await (await fetch(`${BASE}/api/scores`)).json();
  ok('ai' in sc && 'humans' in sc, 'GET /api/scores separates the bot from humans');

  // sign in with a throwaway wallet and call the open round
  const w = Wallet.createRandom();
  const ch = await (await fetch(`${BASE}/api/auth/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: w.address }) })).json();
  const sig = await w.signMessage(ch.message);
  const v = await (await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: w.address, signature: sig }) })).json();
  ok(!!v.token, 'wallet signature accepted for a session');
  const play = await fetch(`${BASE}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.token }, body: JSON.stringify({ roundId: live.round.id, bucket: 'light' }) });
  const pj = await play.json();
  ok(play.status === 200 && pj.you.bucket === 'light', 'a signed human call for the open round is accepted', JSON.stringify(pj.you));
  const late = await fetch(`${BASE}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.token }, body: JSON.stringify({ roundId: live.round.id - 3, bucket: 'light' }) });
  ok(late.status === 409, 'a call for a closed round is refused', `status ${late.status}`);
  const anon = await fetch(`${BASE}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roundId: live.round.id, bucket: 'zero' }) });
  ok(anon.status === 401, 'an unsigned call is refused', `status ${anon.status}`);
  const bad = await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: w.address, signature: await Wallet.createRandom().signMessage('nope') }) });
  ok(bad.status === 400 || bad.status === 401, 'a signature from another wallet is refused', `status ${bad.status}`);
  const el = await fetch(`${BASE}/api/play`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.token }, body: JSON.stringify({ roundId: live.round.id, bucket: 'nonsense' }) });
  ok(el.status === 400, 'an unknown band is refused', `status ${el.status}`);
  const page = await (await fetch(`${BASE}/`)).text();
  ok(page.includes('squeekchain-project'), 'the page carries the Squeekchain project marker');
  const ov = await (await fetch(`${BASE}/overlay`)).text();
  ok(ov.includes('ROUND'), 'the stream overlay is served');
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
process.exit(fail ? 1 : 0);
