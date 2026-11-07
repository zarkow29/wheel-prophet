// The board. No framework: fetch /api/live every 10 s and render.
let SESSION = localStorage.getItem('wp_session') || '';
let ADDRESS = localStorage.getItem('wp_address') || '';
let LIVE = null;

const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '–');
const pct = (x) => (x === null || x === undefined ? '–' : (x * 100).toFixed(1) + '%');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(SESSION ? { Authorization: 'Bearer ' + SESSION } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
  return j;
}

function renderLive(d) {
  LIVE = d;
  $('roundId').textContent = d.round ? d.round.id : '–';
  $('countdown').textContent = d.round ? d.round.secondsLeft + 's' : '–';
  $('playRound').textContent = d.round ? d.round.id : '–';

  const c = d.round && d.round.call;
  $('callBox').innerHTML = c
    ? `<div class="band">${c.bucket.toUpperCase()}</div>
       <div class="fine">${c.bucketLabel} · p(active) ${c.pActive} · ~${c.expectedWork} work</div>
       <div class="kv"><span>SEALED</span><b>${new Date(c.sealedAt).toLocaleTimeString()}</b></div>`
    : '<em>this round opened before the poller started — no call was sealed, and we will not backfill one</em>';
  $('sealHash').textContent = c ? c.hash.slice(0, 22) + '…' : '–';
  $('recomputes').textContent = c ? (c.recomputes ? 'yes — seal intact' : 'NO — hash mismatch!') : '–';
  $('recomputes').className = c && !c.recomputes ? 'bad' : '';
  $('whyList').innerHTML = c ? c.why.map((w) => `<li>${w}</li>`).join('') : '';

  const l = d.lastGraded;
  $('lastBox').innerHTML = l
    ? `<div class="band ${l.hit ? 'ok' : 'bad'}">${l.hit ? 'HIT' : 'MISS'}</div>
       <div class="fine">round ${l.roundId}: called <b>${l.called}</b>, wheel did <b>${l.saw}</b> (${l.actualWork} work) · error ${l.absError}</div>
       <div class="kv"><span>CLIMATOLOGY BASELINE THAT ROUND</span><b>${l.baselineHit === null ? '–' : l.baselineHit ? 'would have hit' : 'would have missed'}</b></div>`
    : '<em>nothing graded yet</em>';

  const t = (d.telemetry || []).slice(-1)[0] || {};
  $('wheelState').textContent = t.coreStatus ? `${t.coreStatus} (${t.at ? new Date(t.at).toLocaleTimeString() : '?'})` : '–';
  $('wheelRpm').textContent = t.rpmMilli ?? '–';
  $('wheelSpeed').textContent = t.speedMmPerSecond ?? '–';
  $('wheelAt').textContent = t.at ? new Date(t.at).toLocaleTimeString() : '–';

  const f = d.chain;
  $('frontier').textContent = f && f.frontier ? `round ${f.frontier.settledThroughRound} · block ${f.frontier.blockHeight} · difficulty ${f.frontier.workPerThousandBlocks}` : (f && f.error ? 'check failed' : '–');
  $('identities').textContent = f && f.identities ? (f.ok ? 'verified on Sepolia' : 'MISMATCH') : '–';
  $('identities').className = f && f.identities && !f.ok ? 'bad' : '';
  $('chainPill').textContent = f && f.chainId ? `chain ${f.chainId}` : 'chain …';
}

async function renderScores() {
  const s = await api('/api/scores');
  const ai = s.ai;
  $('streak').textContent = ai.attempts ? `${ai.streak} hit / ${ai.missStreak} miss` : '–';
  $('acc').textContent = ai.attempts ? `${ai.hits}/${ai.attempts} (${pct(ai.accuracy)})` : '–';
  $('baseline').textContent = ai.baseline.attempts ? `${ai.baseline.hits}/${ai.baseline.attempts} (${pct(ai.baseline.accuracy)})` : '–';

  $('bucketTable').querySelector('tbody').innerHTML = Object.entries(ai.byBucket)
    .map(([k, v]) => `<tr><td>${k}</td><td>${v.called}</td><td>${v.correct}${v.hitRate === null ? '' : ' · ' + pct(v.hitRate)}</td></tr>`)
    .join('');
  $('calibTable').querySelector('tbody').innerHTML = ai.calibration
    .map((c) => `<tr><td>${c.pActiveBand}</td><td>${c.n}</td><td>${c.observedActive === null ? '–' : pct(c.observedActive)}</td></tr>`)
    .join('');

  $('lb').querySelector('tbody').innerHTML = s.humans.length
    ? s.humans.map((h, i) => `<tr><td>${i + 1}</td><td>${short(h.address)}</td><td>${h.calls}</td><td>${h.hits}</td><td>${h.pending}</td></tr>`).join('')
    : '<tr><td colspan="5"><em>no human calls yet — beat the bot</em></td></tr>';
}

async function renderLog() {
  const d = await api('/api/log?limit=25');
  $('log').querySelector('tbody').innerHTML = d.rounds.length
    ? d.rounds.map((r) => `<tr>
        <td>${r.roundId}</td>
        <td>${r.call ? r.call.bucket : '–'}</td>
        <td>${r.result ? r.result.actualBucket : 'open'}</td>
        <td>${r.result ? r.result.actualWork : '–'}</td>
        <td class="${r.result ? (r.result.hit ? 'ok' : 'bad') : ''}">${r.result ? (r.result.hit ? 'HIT' : 'MISS') : '–'}</td>
        <td><code>${r.hash.slice(0, 12)}…</code> ${r.recomputes ? '' : '⚠'}</td>
      </tr>`).join('')
    : '<tr><td colspan="6"><em>the log starts when the poller does</em></td></tr>';
}

function renderBuckets() {
  if (!LIVE || !LIVE.buckets) return;
  $('bucketRow').innerHTML = LIVE.buckets
    .map((b) => `<button class="btn bucket" data-bucket="${b.id}">${b.id.toUpperCase()}</button>`)
    .join('');
  for (const el of document.querySelectorAll('.bucket')) el.onclick = () => play(el.dataset.bucket);
}

async function play(bucket) {
  if (!SESSION) return ($('playState').textContent = 'connect a wallet first');
  if (!LIVE || !LIVE.round) return;
  try {
    const r = await api('/api/play', { body: { roundId: LIVE.round.id, bucket } });
    $('playState').textContent = `your call: ${bucket.toUpperCase()} for round ${r.you.roundId} — closes ${new Date(r.closesAt).toLocaleTimeString()}`;
    renderScores();
  } catch (e) {
    $('playState').textContent = e.message;
  }
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) return ($('playState').textContent = 'no EVM wallet in this browser — MetaMask, Rabby or a phone wallet');
  const [address] = await eth.request({ method: 'eth_requestAccounts' });
  const ch = await api('/api/auth/challenge', { body: { address } });
  $('playState').textContent = 'approve the signature in your wallet (free, no gas)';
  const signature = await eth.request({ method: 'personal_sign', params: [ch.message, address] });
  const v = await api('/api/auth/verify', { body: { address, signature } });
  SESSION = v.token; ADDRESS = v.address;
  localStorage.setItem('wp_session', SESSION);
  localStorage.setItem('wp_address', ADDRESS);
  $('walletPill').textContent = 'signed in ' + short(ADDRESS);
  $('playState').textContent = 'signed in — pick a band for the open round';
}

$('connect').onclick = () => connect().catch((e) => ($('playState').textContent = e.message));

async function refresh() {
  try {
    renderLive(await api('/api/live'));
    renderBuckets();
    await Promise.all([renderScores(), renderLog()]);
  } catch (e) { /* the board stays up, the poller may not have started */ }
}

if (ADDRESS) $('walletPill').textContent = 'signed in ' + short(ADDRESS);
refresh();
setInterval(refresh, 10000);
