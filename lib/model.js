// The prediction model. Deliberately small and readable: every number here can be
// recomputed by anyone from the same public Squeekchain data.
//
// Inputs
//   climatology : per half-hour-of-UTC typical work, built from /v1/measurement/stats
//   live        : the newest /v1/status sample (rpm, speed, coreStatus, freshness)
//   recent      : the last few closed rounds' work, from our own status sampling
// Output
//   a call for ONE round: will the hamster work, and in which work band

const BUCKETS = [
  { id: 'zero', label: 'nothing', min: 0, max: 0 },
  { id: 'trace', label: 'a trace (1–49)', min: 1, max: 49 },
  { id: 'light', label: 'light (50–199)', min: 50, max: 199 },
  { id: 'busy', label: 'busy (200–499)', min: 200, max: 499 },
  { id: 'sprint', label: 'sprint (500+)', min: 500, max: Infinity },
];

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function bucketOf(work) {
  const w = Number(work) || 0;
  return BUCKETS.find((b) => w >= b.min && w <= b.max) || BUCKETS[BUCKETS.length - 1];
}

// /v1/measurement/stats -> 48 half-hour slots of typical work.
// Field names are read defensively: the API ships `workUnits`, older shapes used
// `observedWorkUnits`, and a bucket can be `null` when the half hour was not observed.
function buildClimatology(stats, { roundSeconds = 600 } = {}) {
  const slots = Array.from({ length: 48 }, (_, i) => ({ slot: i, minuteUtc: i * 30, work: [], observed: 0 }));
  const days = stats?.activity?.days || [];
  for (const day of days) {
    for (const b of day.buckets || []) {
      const slot = slots.find((s) => s.minuteUtc === b.startMinuteUtc);
      if (!slot) continue;
      const observed = (b.coverage && b.coverage !== 'missing') || (b.workUnits !== null && b.workUnits !== undefined);
      if (!observed) continue;
      slot.observed += 1;
      const w = Number(b.workUnits ?? b.observedWorkUnits ?? 0);
      slot.work.push(w / Math.max(1, Math.round(1800 / roundSeconds))); // half hour -> per round
    }
  }
  const perSlot = slots.map((s) => {
    const active = s.work.filter((w) => w > 0);
    return {
      slot: s.slot,
      minuteUtc: s.minuteUtc,
      observed: s.observed,
      pActive: s.work.length ? active.length / s.work.length : 0,
      meanActiveWork: mean(active),
      medianActiveWork: median(active),
      meanWork: mean(s.work),
      modeBucket: bucketOf(median(s.work)).id,
    };
  });
  const observedSlots = perSlot.filter((s) => s.observed > 0);
  const baseRate = observedSlots.length ? mean(observedSlots.map((s) => s.pActive)) : 0;
  const baseActiveWork = observedSlots.length ? mean(observedSlots.map((s) => s.meanActiveWork)) : 0;
  return {
    builtFrom: stats?.range || 'n/a',
    generatedAt: stats?.generatedAt || null,
    activeDays: stats?.lifetime?.activeDayCount ?? null,
    slots: perSlot,
    baseRate,
    baseActiveWork,
    baseModeBucket: bucketOf(median(observedSlots.map((s) => s.meanWork))).id,
  };
}

function slotFor(minuteUtc) {
  return Math.floor(((minuteUtc % 1440) + 1440) % 1440 / 30);
}

function predict({ roundId, now, live, recent = [], climatology }) {
  const minuteUtc = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
  const slot = climatology?.slots?.[slotFor(minuteUtc)] || null;
  const why = [];

  let pActive = slot ? slot.pActive : climatology?.baseRate ?? 0.3;
  why.push(slot ? `climatology ${slot.pActive.toFixed(2)} for minute ${slot.minuteUtc}` : 'no climatology for this half hour');

  // live wheel state carries the strongest single signal
  const status = live?.measurement?.coreStatus;
  const rpm = Number(live?.measurement?.rpmMilli ?? 0);
  const fresh = live?.measurement?.freshness === 'online';
  if (!fresh) { pActive *= 0.6; why.push('telemetry stale'); }
  else if (status === 'RUNNING') { pActive = pActive * 0.4 + 0.75; why.push('wheel RUNNING'); }
  else if (status === 'IDLE' && rpm === 0) { pActive *= 0.5; why.push('IDLE, 0 rpm'); }
  else { pActive *= 0.85; why.push(`${status}, ${rpm} rpmMilli`); }

  // streak: a hamster that just worked usually keeps working
  const last2 = recent.slice(-2);
  if (last2.length === 2 && last2.every((r) => r.work > 0)) { pActive += 0.1; why.push('2 active rounds behind'); }
  if (last2.length === 2 && last2.every((r) => r.work === 0)) { pActive -= 0.15; why.push('2 empty rounds behind'); }

  pActive = clamp(pActive, 0.01, 0.98);

  const perRoundActive = slot?.meanActiveWork || climatology?.baseActiveWork || 0;
  let expectedWork = pActive * perRoundActive;
  if (status === 'RUNNING') {
    const rpmRatio = clamp(rpm / 90000, 0.4, 1.6);
    expectedWork *= 0.6 + 0.4 * rpmRatio;
    why.push(`rpm factor ${(0.6 + 0.4 * rpmRatio).toFixed(2)}`);
  }
  const bucket = bucketOf(Math.round(expectedWork));

  return {
    roundId,
    madeAt: new Date(now).toISOString(),
    pActive: Number(pActive.toFixed(3)),
    expectedWork: Math.round(expectedWork),
    bucket: bucket.id,
    bucketLabel: bucket.label,
    why,
    inputs: { coreStatus: status ?? null, rpmMilli: rpm, freshness: live?.measurement?.freshness ?? null, slotMinuteUtc: slot?.minuteUtc ?? null },
  };
}

module.exports = { BUCKETS, bucketOf, buildClimatology, predict, slotFor, clamp, mean, median };
