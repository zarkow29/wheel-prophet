# Wheel Prophet

**An AI that calls every Squeekchain round in public — before the round closes — and grades itself in the open.**

Squeekchain is a proof-of-work toychain where a hamster turns a wheel and its verified work completes 600-second
"rounds" on Sepolia. Every round's work is unknowable until it is over. Wheel Prophet takes that as a challenge:
it samples the live pipeline, calls the next round's band, seals the call with a hash it cannot change afterwards,
then scores every call against what the wheel actually did — next to a climatology-only baseline, so you can see
whether the live signal is worth anything.

Built for the Squeekchain Genesis **Code** lane. Project marker: `squeekchain-project`.
**Live board: https://wheelprophet.duckdns.org** (this repo is the same code that runs there).

## What it does

| Step | How |
| --- | --- |
| Sample | `GET /v1/status` every 15 s: wheel state, milli-rpm, speed, cumulative work |
| Call | in the first 2 minutes of a round, predict a work band from 48 half-hour climatology slots (7 days of `/v1/measurement/stats`), the live wheel state and the last rounds' work |
| Seal | `sha256(roundId \| pActive \| expectedWork \| bucket \| nonce)` is stored and served **while the round is still open** |
| Grade | work added during the round (summed from the cumulative counter in our own samples) decides the band; the call is scored, streaks and calibration tracked, and a climatology-only baseline scored alongside |
| Verify | before trusting a single number, the board reads `SqueekCore` on Sepolia with the published ABI and checks the proxy's implementation address, ProxyAdmin and runtime code hash against the deployment record |

Humans can play: connect a wallet, sign in (signature only — no gas, no transaction, no custody), pick a band
for the open round, and get graded by the same rulebook. The server refuses calls for closed rounds and unsigned
calls outright.

## Run it

```bash
npm install
SESSION_SECRET=$(openssl rand -hex 32) node poller.js   # the bot: samples, seals, grades
SESSION_SECRET=$(openssl rand -hex 32) PORT=8099 node server.js   # the board + API
node test/e2e.mjs                       # 33 checks: rules, real API, one poller tick, on-chain identities
WP_HTTP=http://127.0.0.1:8099 node test/e2e.mjs   # + 13 HTTP checks (live round, play, refusals, marker)
```

Env: `PORT` (8099), `HOST`, `DOMAIN` (shown in the sign-in message), `SESSION_SECRET`, `SAMPLE_MS` (15000),
`SEPOLIA_RPC`, `SQUEEK_ABI_URL`. The poller owns `data/state.json`, the server owns `data/plays.json`;
readers reload on mtime, so the two processes see each other without a lock.

## API

```
GET  /api/live        open round, seconds left, the sealed call, the seal's hash, last graded round, telemetry, chain frontier
GET  /api/log?limit=  every round with its call, nonce, hash and result — recompute the seal yourself
GET  /api/scores      AI accuracy, per-band table, calibration, streaks vs the climatology baseline, human leaderboard
GET  /api/chain       on-chain identity check + certified frontier
GET  /api/summary     poller stats, climatology provenance, 24 h settlement summary
POST /api/auth/challenge | /api/auth/verify      wallet sign-in (nonce, single use, 5 min)
POST /api/play        {roundId, bucket}          a signed human call, refused once the round closes
GET  /overlay         transparent stream overlay: round, call, last hit/miss
```

## Where it is honest about itself

- **The log lives on our server.** The seal makes the call uneditable *relative to the hash we published*, and the
  hash is served to anyone who asks while the round is open — but a stronger build would anchor each hash on-chain
  (or in a public repo commit). The board says this in the same words instead of pretending the seal is
  cryptographic proof of publication time.
- **An identity mismatch stops the read.** If the proxy's implementation, ProxyAdmin or code hash does not match the
  published deployment record, the frontier is reported as unverified and no number from it is shown as trustworthy.
- **No backfilled calls.** A round the poller missed stays without a call, marked `CALL_SKIPPED`. Predicting a round
  after seeing it would make the whole scoreboard worthless.
- **Work per round is our own accounting.** It comes from deltas in `/v1/status`'s cumulative work counter, which is
  derived from the API's accepted measurements (~12 confirmations behind the chain), not from `submitRounds` logs.
  The certified frontier on the board comes from the contract itself.
- **Climatology is thin on purpose.** The deployment is days old, so the per-slot probabilities rest on a handful of
  observed half hours. The hold-out check in `test/e2e.mjs` scores the model on the newest day against the base rate
  and reports the numbers rather than claiming a win.
- **Testnet only.** $SQK and Squeeks on Sepolia have no monetary value, and this tool never touches them: it reads.

## Deploy (systemd + nginx on a small VPS)

```bash
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wheel-prophet-poller wheel-prophet-web
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wheel-prophet && sudo ln -s /etc/nginx/sites-available/wheel-prophet /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.tld        # HTTPS: the site check requires https
```

## Files

```
poller.js        the loop: sample → call → seal → grade → chain check
server.js        board + API (node:http, no framework)
lib/model.js     buckets, climatology builder, the prediction
lib/game.js      seal/verify, round accounting, grading, scores
lib/chain.js     SqueekCore identity check and frontier read (ethers + published ABI)
lib/api.js       api.squeekchain.com client with retries and round math
lib/auth.js      wallet sign-in (challenge → personal_sign → HMAC session)
public/          board, styles, overlay (vanilla JS, window.ethereum)
test/e2e.mjs     46 checks
deploy/          systemd units + nginx site
```

Reads only. Never signs for you, never asks for a key, never sends a transaction.
