// Wallet sign-in for humans who want to call a round. Signature only: no gas, no approval,
// no custody. Same core as any wallet-signin app — nonce, personal_sign, HMAC session.
const crypto = require('crypto');
const { ethers } = require('ethers');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const norm = (a) => String(a || '').trim().toLowerCase();

const nonces = new Map(); // in-memory is right for a single-process app

function challenge(address, domain = 'localhost') {
  const a = norm(address);
  if (!ethers.isAddress(a)) throw Object.assign(new Error('bad address'), { status: 400 });
  const nonce = crypto.randomBytes(16).toString('hex');
  const message =
    `${domain} wants you to sign in with your Ethereum account:\n${ethers.getAddress(a)}\n\n` +
    `Sign in to call a Squeekchain round. A signature, not a transaction: no gas, no funds, no approval.\n\n` +
    `URI: https://${domain}/play\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  nonces.set(a, { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS });
  return { address: ethers.getAddress(a), nonce, message, expiresAt: Date.now() + NONCE_TTL_MS };
}

function verify(address, signature) {
  const a = norm(address);
  const rec = nonces.get(a);
  if (!rec) throw Object.assign(new Error('no challenge for this address'), { status: 400 });
  if (Date.now() > rec.expiresAt) throw Object.assign(new Error('challenge expired'), { status: 400 });
  let signer;
  try { signer = ethers.verifyMessage(rec.message, signature); }
  catch { throw Object.assign(new Error('bad signature'), { status: 400 }); }
  if (norm(signer) !== a) throw Object.assign(new Error('signature is not from this address'), { status: 401 });
  nonces.delete(a); // single use
  return { address: ethers.getAddress(a), token: issue(a), expiresAt: Date.now() + SESSION_TTL_MS };
}

function issue(address) {
  const body = Buffer.from(JSON.stringify({ a: norm(address), exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

function read(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const A = Buffer.from(sig), B = Buffer.from(want);
  if (A.length !== B.length || !crypto.timingSafeEqual(A, B)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Date.now() > p.exp ? null : p.a;
  } catch { return null; }
}

module.exports = { challenge, verify, issue, read, norm };
