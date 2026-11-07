// Round accounting, sealed calls and self-grading. Pure functions over the state object
// so the whole rulebook can be unit-tested without the network.
const crypto = require('crypto');
const { BUCKETS, bucketOf } = require('./model');

const CLOSE_GRACE_MS = 45_000; // let the last samples of a round land before sealing it

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A sealed call: we publish sha256(content+nonce) when the round opens and reveal the
// content when it closes. Changing one digit of the call after the fact breaks the hash.
function commitmentOf({ roundId, prediction, nonce }) {
  return sha256(JSON.stringify({ roundId, pActive: prediction.pActive, expectedWork: prediction.expectedWork, bucket: prediction.bucket, nonce }));
}

function seal(prediction, nonce = crypto.randomBytes(16).toString('hex')) {
  const body = { roundId: prediction.roundId, prediction, nonce };
  return { ...body, hash: commitmentOf(body), sealedAt: new Date().toISOString() };
}

function verifySeal(entry) {
  try {
    return commitmentOf({ roundId: entry.roundId, prediction: entry.prediction, nonce: entry.nonce }) === entry.hash;
  } catch {
    return false;
  }
}

// Work added during a round, from our own /v1/status sampling: cumulative work is a
// monotone counter, so the sum of positive deltas inside the window is the round's work.
// Deltas are attributed to the sample that closed them (15 s resolution).
function workInRound(samples, startAt, endAt) {
  let work = 0;
  let activeSamples = 0;
  let prev = null;
  for (const s of samples) {
    const t = Date.parse(s.at);
    const cum = Number(s.cumulativeWorkUnits ?? 0);
    if (prev && t > startAt && t <= endAt) {
      work += Math.max(0, cum - prev.cum);
      if ((s.rpmMilli ?? 0) > 0) activeSamples += 1;
    }
    if (t <= endAt) prev = { cum };
  }
  return { work, activeSamples };
}

function grade(prediction, actualWork, baselineBucket) {
  const actual = bucketOf(actualWork);
  return {
    actualWork,
    actualBucket: actual.id,
    hit: actual.id === prediction.bucket,
    activeCall: prediction.pActive >= 0.5,
    activeHit: (actualWork > 0) === (prediction.pActive >= 0.5),
    absError: Math.abs(actualWork - prediction.expectedWork),
    baselineBucket: baselineBucket ?? null,
    baselineHit: baselineBucket ? baselineBucket === actual.id : null,
  };
}

function closedRounds(state, now = Date.now(), grace = CLOSE_GRACE_MS) {
  const { roundMath } = require('./api');
  const rm = roundMath(state.config);
  const ids = Object.keys(state.rounds).map(Number).sort((a, b) => a - b);
  return ids.filter((id) => now > rm.endOf(id) + grace && !state.rounds[id].closed);
}

function closeRound(state, roundId, now = Date.now()) {
  const { roundMath } = require('./api');
  const rm = roundMath(state.config);
  const r = state.rounds[roundId];
  if (!r) return null;
  const startAt = rm.startOf(roundId);
  const endAt = rm.endOf(roundId);
  const { work, activeSamples } = workInRound(state.samples || [], startAt, endAt);
  r.closed = true;
  r.closedAt = new Date(now).toISOString();
  r.actualWork = work;
  r.activeSamples = activeSamples;
  if (r.prediction) r.grade = grade(r.prediction, work, r.baselineBucket);
  state.events = state.events || [];
  state.events.unshift({
    at: r.closedAt,
    type: 'ROUND_GRADED',
    roundId,
    detail: r.grade ? `${r.grade.hit ? 'HIT' : 'MISS'} — called ${r.prediction.bucket}, saw ${r.grade.actualBucket} (${work} work)` : 'no call was sealed',
  });
  state.events.length = Math.min(state.events.length, 200);
  return r;
}

function scores(state) {
  const rounds = Object.values(state.rounds || {}).filter((r) => r.closed && r.grade);
  const attempts = rounds.length;
  const hits = rounds.filter((r) => r.grade.hit).length;
  const activeHits = rounds.filter((r) => r.grade.activeHit).length;
  const baselineAttempts = rounds.filter((r) => r.grade.baselineHit !== null).length;
  const baselineHits = rounds.filter((r) => r.grade.baselineHit === true).length;

  const byBucket = {};
  for (const b of BUCKETS) {
    const rs = rounds.filter((r) => r.prediction.bucket === b.id);
    const seen = rs.filter((r) => r.grade.actualBucket === b.id).length;
    byBucket[b.id] = { called: rs.length, correct: seen, hitRate: rs.length ? seen / rs.length : null };
  }

  // calibration: does pActive mean what it says?
  const calibBins = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
  const calibration = calibBins.map(([lo, hi]) => {
    const rs = rounds.filter((r) => r.prediction.pActive >= lo && r.prediction.pActive < hi);
    const active = rs.filter((r) => r.grade.actualWork > 0).length;
    return { pActiveBand: `${lo}–${hi === 1.01 ? 1 : hi}`, n: rs.length, observedActive: rs.length ? active / rs.length : null };
  });

  // current streak, newest first
  const ordered = rounds.sort((a, b) => b.roundId - a.roundId);
  let streak = 0;
  for (const r of ordered) { if (r.grade.hit) streak++; else break; }
  let missStreak = 0;
  for (const r of ordered) { if (!r.grade.hit) missStreak++; else break; }

  const errs = rounds.map((r) => r.grade.absError).sort((a, b) => a - b);
  const mae = errs.length ? errs.reduce((s, x) => s + x, 0) / errs.length : null;
  const medErr = errs.length ? errs[errs.length >> 1] : null;

  return {
    attempts,
    hits,
    accuracy: attempts ? hits / attempts : null,
    activeHits,
    activeAccuracy: attempts ? activeHits / attempts : null,
    streak, missStreak,
    mae, medianError: medErr,
    baseline: { attempts: baselineAttempts, hits: baselineHits, accuracy: baselineAttempts ? baselineHits / baselineAttempts : null },
    byBucket,
    calibration,
    lastRound: ordered[0] || null,
  };
}

module.exports = { sha256, commitmentOf, seal, verifySeal, workInRound, grade, closedRounds, closeRound, scores, CLOSE_GRACE_MS };
