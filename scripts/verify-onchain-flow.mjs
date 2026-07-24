import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  toHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "USDC",
    symbol: "USDC"
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"]
    }
  },
  blockExplorers: {
    default: {
      name: "Arcscan Testnet",
      url: "https://testnet.arcscan.app"
    }
  },
  testnet: true
});

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
]);

const poolAbi = parseAbi([
  "function owner() external view returns (address)",
  "function underwriter() external view returns (address)",
  "function releaseReceivable(uint256 milestoneId) external",
  "function requestAdvance(uint256 milestoneId) external",
  "function setReceivableRisk(uint256 milestoneId, uint8 riskTier, uint16 maxAdvanceBps, uint16 baseDiscountBps, uint16 annualizedDiscountBps, uint16 maxDiscountBps, bytes32 riskHash) external",
  "function quoteAdvance(uint256 milestoneId) external view returns (uint256)",
  "function quoteDiscountBps(uint256 milestoneId) external view returns (uint256)",
  "function riskPolicies(uint256 milestoneId) external view returns (bool published, uint8 riskTier, uint16 maxAdvanceBps, uint16 baseDiscountBps, uint16 annualizedDiscountBps, uint16 maxDiscountBps, bytes32 riskHash)",
  "function availableLiquidity() external view returns (uint256)",
  "function outstanding() external view returns (uint256)",
  "function outstandingByClient(address client) external view returns (uint256)",
  "function outstandingByFreelancer(address freelancer) external view returns (uint256)",
  "function baseDiscountBps() external view returns (uint256)",
  "function annualizedDiscountBps() external view returns (uint256)",
  "function maxDiscountBps() external view returns (uint256)",
  "function discountBps() external view returns (uint256)"
]);

const ownerPrivateKey = process.env.POOL_OWNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
const clientPrivateKey = process.env.CLIENT_PRIVATE_KEY;
const freelancerPrivateKey = process.env.FREELANCER_PRIVATE_KEY;
if (!ownerPrivateKey) throw new Error("POOL_OWNER_PRIVATE_KEY or PRIVATE_KEY is required.");
if (!clientPrivateKey) throw new Error("CLIENT_PRIVATE_KEY is required for the v2 risk-gated verifier.");
if (!freelancerPrivateKey) throw new Error("FREELANCER_PRIVATE_KEY is required for the v2 risk-gated verifier.");

const deployment = JSON.parse(await readFile("deployments/arc-testnet.json", "utf8"));
const escrowArtifact = JSON.parse(await readFile("artifacts/MilestoneEscrow.json", "utf8"));
const rpcUrl = process.env.ARC_RPC_URL || deployment.rpcUrl || "https://rpc.testnet.arc.network";
const amountInput = process.env.VERIFY_AMOUNT_USDC || "1";

function accountFromKey(privateKey) {
  return privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
}

const owner = accountFromKey(ownerPrivateKey);
const clientAccount = accountFromKey(clientPrivateKey);
const freelancerAccount = accountFromKey(freelancerPrivateKey);
if (clientAccount.address.toLowerCase() === freelancerAccount.address.toLowerCase()) {
  throw new Error("CLIENT_PRIVATE_KEY and FREELANCER_PRIVATE_KEY must be different; v2 blocks same-wallet receivables.");
}

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
const ownerWallet = createWalletClient({ account: owner, chain: arcTestnet, transport: http(rpcUrl) });
const clientWallet = createWalletClient({ account: clientAccount, chain: arcTestnet, transport: http(rpcUrl) });
const freelancerWallet = createWalletClient({ account: freelancerAccount, chain: arcTestnet, transport: http(rpcUrl) });

// v3: when the pool has a delegated underwriter, the agent wallet publishes the
// risk policy and a third-party settler triggers pool repayment.
const underwriterPrivateKey = process.env.UNDERWRITER_PRIVATE_KEY;
const underwriterAccount = underwriterPrivateKey ? accountFromKey(underwriterPrivateKey) : null;
const underwriterWallet = underwriterAccount
  ? createWalletClient({ account: underwriterAccount, chain: arcTestnet, transport: http(rpcUrl) })
  : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The public Arc RPC rate-limits aggressively; retry reads with backoff.
async function read(params, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await publicClient.readContract(params);
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(4_000);
    }
  }
  throw new Error("read failed");
}

/// The public Arc RPC rate-limits aggressively; wait for receipts patiently.
async function waitTx(hash, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await publicClient.waitForTransactionReceipt({ hash });
    } catch (error) {
      if (i === attempts - 1) throw error;
      await sleep(4_000);
    }
  }
  throw new Error(`Receipt not found for ${hash}`);
}

async function writeContract(label, wallet, params) {
  const hash = await wallet.writeContract(params);
  const receipt = await waitTx(hash);
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}: ${hash}`);
  await sleep(1_500);
  return receipt;
}

async function readStatus(milestoneId) {
  const milestone = await read({
    address: deployment.escrow,
    abi: escrowArtifact.abi,
    functionName: "milestones",
    args: [milestoneId]
  });
  return Number(milestone[4]);
}

async function readOptional(label, params) {
  try {
    return await read(params);
  } catch {
    console.warn(`${label}: unavailable on this deployed contract`);
    return null;
  }
}

async function readAll(entries) {
  const results = [];
  for (const entry of entries) {
    results.push(await read(entry));
    await sleep(600);
  }
  return results;
}

function assertStatus(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} status ${actual}, expected ${expected}`);
  }
}

const chainId = await publicClient.getChainId();
if (chainId !== deployment.chainId) {
  throw new Error(`Connected to chain ${chainId}, expected ${deployment.chainId}`);
}

const [
  decimals,
  symbol,
  clientBalanceBefore,
  freelancerBalanceBefore,
  poolBefore,
  outstandingBefore,
  poolOwner,
  clientOutstandingBefore,
  freelancerOutstandingBefore
] = await readAll([
  { address: deployment.usdc, abi: erc20Abi, functionName: "decimals" },
  { address: deployment.usdc, abi: erc20Abi, functionName: "symbol" },
  { address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [clientAccount.address] },
  { address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [freelancerAccount.address] },
  { address: deployment.pool, abi: poolAbi, functionName: "availableLiquidity" },
  { address: deployment.pool, abi: poolAbi, functionName: "outstanding" },
  { address: deployment.pool, abi: poolAbi, functionName: "owner" },
  { address: deployment.pool, abi: poolAbi, functionName: "outstandingByClient", args: [clientAccount.address] },
  { address: deployment.pool, abi: poolAbi, functionName: "outstandingByFreelancer", args: [freelancerAccount.address] }
]);

const amount = parseUnits(amountInput, decimals);
if (poolOwner.toLowerCase() !== owner.address.toLowerCase()) {
  throw new Error(`Owner key ${owner.address} does not own pool ${deployment.pool}; pool owner is ${poolOwner}.`);
}
if (clientBalanceBefore < amount) {
  throw new Error(`Client has ${formatUnits(clientBalanceBefore, decimals)} ${symbol}, needs ${amountInput}.`);
}

const delegatedUnderwriter = await readOptional("delegated underwriter", {
  address: deployment.pool,
  abi: poolAbi,
  functionName: "underwriter"
});
const zeroAddress = "0x0000000000000000000000000000000000000000";
const hasDelegatedUnderwriter = Boolean(
  delegatedUnderwriter && delegatedUnderwriter.toLowerCase() !== zeroAddress
);
if (hasDelegatedUnderwriter && underwriterAccount) {
  if (delegatedUnderwriter.toLowerCase() !== underwriterAccount.address.toLowerCase()) {
    throw new Error(
      `UNDERWRITER_PRIVATE_KEY resolves to ${underwriterAccount.address} but the pool delegated ${delegatedUnderwriter}.`
    );
  }
}
const riskPublisherWallet = hasDelegatedUnderwriter && underwriterWallet ? underwriterWallet : ownerWallet;
const riskPublisherLabel = riskPublisherWallet === underwriterWallet ? "underwriter agent" : "pool owner";
const settlerWallet = underwriterWallet ?? ownerWallet;

const metadataHash = keccak256(
  toHex(
    JSON.stringify({
      product: "Milestone PayFi",
      purpose: "onchain verification",
      amountUsdc: amountInput,
      verifiedAt: new Date().toISOString()
    })
  )
);

const latestBlock = await publicClient.getBlock();
const createReceipt = await writeContract("create milestone", clientWallet, {
  address: deployment.escrow,
  abi: escrowArtifact.abi,
  functionName: "createMilestone",
  args: [freelancerAccount.address, clientAccount.address, amount, latestBlock.timestamp, metadataHash]
});

let milestoneId;
for (const log of createReceipt.logs) {
  try {
    const decoded = decodeEventLog({
      abi: escrowArtifact.abi,
      data: log.data,
      topics: log.topics
    });
    if (decoded.eventName === "MilestoneCreated") {
      milestoneId = decoded.args.milestoneId;
      break;
    }
  } catch {
    // Ignore logs from other contracts.
  }
}

if (milestoneId === undefined) throw new Error("Missing MilestoneCreated event.");
assertStatus(await readStatus(milestoneId), 0, "created");

await writeContract("approve escrow USDC", clientWallet, {
  address: deployment.usdc,
  abi: erc20Abi,
  functionName: "approve",
  args: [deployment.escrow, amount]
});

await writeContract("fund escrow", clientWallet, {
  address: deployment.escrow,
  abi: escrowArtifact.abi,
  functionName: "fund",
  args: [milestoneId]
});
assertStatus(await readStatus(milestoneId), 1, "funded");

await writeContract("submit work", freelancerWallet, {
  address: deployment.escrow,
  abi: escrowArtifact.abi,
  functionName: "submit",
  args: [milestoneId]
});
assertStatus(await readStatus(milestoneId), 2, "submitted");

await writeContract("approve receivable", clientWallet, {
  address: deployment.escrow,
  abi: escrowArtifact.abi,
  functionName: "approve",
  args: [milestoneId]
});
assertStatus(await readStatus(milestoneId), 3, "approved");

const riskHash = keccak256(
  toHex(
    JSON.stringify({
      tier: "A",
      score: 0,
      flags: [],
      hardBlock: false,
      maxAdvanceBps: 9800,
      baseDiscountBps: 80,
      annualizedDiscountBps: 2400,
      maxDiscountBps: 600,
      milestoneId: milestoneId.toString(),
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      amountUsdc: amountInput,
      verifiedAt: new Date().toISOString()
    })
  )
);

await writeContract(`publish risk policy (${riskPublisherLabel})`, riskPublisherWallet, {
  address: deployment.pool,
  abi: poolAbi,
  functionName: "setReceivableRisk",
  args: [milestoneId, 0, 9800, 80, 2400, 600, riskHash]
});

const riskPolicy = await read({
  address: deployment.pool,
  abi: poolAbi,
  functionName: "riskPolicies",
  args: [milestoneId]
});
if (!riskPolicy[0] || Number(riskPolicy[1]) !== 0 || riskPolicy[6].toLowerCase() !== riskHash.toLowerCase()) {
  throw new Error("Published risk policy does not match the verifier payload.");
}

const quote = await read({
  address: deployment.pool,
  abi: poolAbi,
  functionName: "quoteAdvance",
  args: [milestoneId]
});
if (quote <= 0n) throw new Error("Pool returned zero advance quote.");

const quoteDiscountBps = await readOptional("quote discount", {
  address: deployment.pool,
  abi: poolAbi,
  functionName: "quoteDiscountBps",
  args: [milestoneId]
});

await writeContract("request early payout", freelancerWallet, {
  address: deployment.pool,
  abi: poolAbi,
  functionName: "requestAdvance",
  args: [milestoneId]
});
assertStatus(await readStatus(milestoneId), 4, "early paid");

try {
  await writeContract("release scheduled payout via pool (settler agent)", settlerWallet, {
    address: deployment.pool,
    abi: poolAbi,
    functionName: "releaseReceivable",
    args: [milestoneId]
  });
} catch {
  await writeContract("release scheduled payout", clientWallet, {
    address: deployment.escrow,
    abi: escrowArtifact.abi,
    functionName: "release",
    args: [milestoneId]
  });
}
assertStatus(await readStatus(milestoneId), 5, "released");

const [
  poolAfter,
  outstandingAfter,
  clientOutstandingAfter,
  freelancerOutstandingAfter,
  clientBalanceAfter,
  freelancerBalanceAfter
] = await readAll([
  { address: deployment.pool, abi: poolAbi, functionName: "availableLiquidity" },
  { address: deployment.pool, abi: poolAbi, functionName: "outstanding" },
  { address: deployment.pool, abi: poolAbi, functionName: "outstandingByClient", args: [clientAccount.address] },
  { address: deployment.pool, abi: poolAbi, functionName: "outstandingByFreelancer", args: [freelancerAccount.address] },
  { address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [clientAccount.address] },
  { address: deployment.usdc, abi: erc20Abi, functionName: "balanceOf", args: [freelancerAccount.address] }
]);

if (outstandingAfter !== outstandingBefore) {
  throw new Error(
    `Pool outstanding changed from ${formatUnits(outstandingBefore, decimals)} to ${formatUnits(outstandingAfter, decimals)}.`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      chainId,
      owner: owner.address,
      client: clientAccount.address,
      freelancer: freelancerAccount.address,
      usdc: deployment.usdc,
      escrow: deployment.escrow,
      pool: deployment.pool,
      milestoneId: milestoneId.toString(),
      amountUsdc: formatUnits(amount, decimals),
      riskTier: "A",
      riskHash,
      underwriter: hasDelegatedUnderwriter ? delegatedUnderwriter : null,
      riskPolicyPublishedBy: riskPublisherLabel,
      settledBy: settlerWallet === underwriterWallet ? "settler agent" : "pool owner",
      advanceQuoteUsdc: formatUnits(quote, decimals),
      quoteDiscountBps: quoteDiscountBps === null ? "legacy-flat-discount" : Number(quoteDiscountBps),
      poolBeforeUsdc: formatUnits(poolBefore, decimals),
      poolAfterUsdc: formatUnits(poolAfter, decimals),
      outstandingBeforeUsdc: formatUnits(outstandingBefore, decimals),
      outstandingAfterUsdc: formatUnits(outstandingAfter, decimals),
      clientOutstandingBeforeUsdc: formatUnits(clientOutstandingBefore, decimals),
      clientOutstandingAfterUsdc: formatUnits(clientOutstandingAfter, decimals),
      freelancerOutstandingBeforeUsdc: formatUnits(freelancerOutstandingBefore, decimals),
      freelancerOutstandingAfterUsdc: formatUnits(freelancerOutstandingAfter, decimals),
      clientBeforeUsdc: formatUnits(clientBalanceBefore, decimals),
      clientAfterUsdc: formatUnits(clientBalanceAfter, decimals),
      freelancerBeforeUsdc: formatUnits(freelancerBalanceBefore, decimals),
      freelancerAfterUsdc: formatUnits(freelancerBalanceAfter, decimals)
    },
    null,
    2
  )
);
