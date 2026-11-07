// On-chain check of the certified frontier.
//
// The API is for display; the contract is the truth (Squeekchain's own integration
// invariant: "verify before reading"). This module reads SqueekCore on Sepolia with the
// ABI the docs publish, and compares the proxy's own identity answers against the
// published deployment record before trusting a single number.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const RPC = process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
const ABI_URL = process.env.SQUEEK_ABI_URL || 'https://docs.squeekchain.com/assets/abi/SqueekCore.json';
const ABI_CACHE = path.join(__dirname, '..', 'data', 'SqueekCore.abi.json');

// from the published deployment record (core-sepolia-20261103, revision 7)
const EXPECTED = {
  chainId: 11155111,
  proxy: '0xFD6C166D4B8E2962E65746a13e5a0797CD4dE0c4',
  implementation: '0x6869D6102696243Fd17013ab955d99CD0c522ad3',
  implementationRuntimeHash: '0x65b5780a4fccafedeca1260806364d2bb512b4501c097253f792ae2839565a9c',
  proxyAdmin: '0x21b3CB8f00D0d47b246a57D04152D6e11D24aBB3',
};

async function abi() {
  try {
    if (fs.existsSync(ABI_CACHE)) {
      const cached = JSON.parse(fs.readFileSync(ABI_CACHE, 'utf8'));
      const age = Date.now() - fs.statSync(ABI_CACHE).mtimeMs;
      if (age < 24 * 3600 * 1000) return cached;
    }
  } catch { /* refetch below */ }
  const res = await fetch(ABI_URL, { headers: { 'User-Agent': 'wheel-prophet/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`cannot read published ABI (${res.status}) — refusing to read the contract without it`);
  const json = await res.json();
  fs.mkdirSync(path.dirname(ABI_CACHE), { recursive: true });
  fs.writeFileSync(ABI_CACHE, JSON.stringify(json));
  return json;
}

async function verifyFrontier() {
  const network = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const listed = await abi();
  const core = new ethers.Contract(EXPECTED.proxy, listed, network);

  const net = await network.getNetwork();
  if (Number(net.chainId) !== EXPECTED.chainId) throw new Error(`wrong chain: ${net.chainId}`);

  const [implAddr, proxyAdmin, state] = await Promise.all([
    core.implementationCodeAddress(),
    core.proxyAdmin(),
    core.state(),
  ]);

  const identities = {
    implementationMatches: implAddr.toLowerCase() === EXPECTED.implementation.toLowerCase(),
    proxyAdminMatches: proxyAdmin.toLowerCase() === EXPECTED.proxyAdmin.toLowerCase(),
  };
  const code = await network.getCode(EXPECTED.implementation);
  const runtimeHash = ethers.keccak256(code);
  identities.runtimeHashMatches = runtimeHash.toLowerCase() === EXPECTED.implementationRuntimeHash.toLowerCase();

  return {
    ok: identities.implementationMatches && identities.proxyAdminMatches && identities.runtimeHashMatches,
    chainId: Number(net.chainId),
    proxy: EXPECTED.proxy,
    readAt: new Date().toISOString(),
    identities,
    frontier: {
      settledThroughRound: Number(state.settledThroughRound),
      cumulativeWork: Number(state.cumulativeWork),
      blockHeight: BigInt(state.blockHeight).toString(),
      blockProgress: BigInt(state.blockProgress).toString(),
      cumulativeBlockUnits: BigInt(state.cumulativeBlockUnits).toString(),
      workPerThousandBlocks: Number(state.workPerThousandBlocks),
    },
  };
}

module.exports = { verifyFrontier, EXPECTED, ABI_URL };
