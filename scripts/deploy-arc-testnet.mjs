import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "./compile-contracts.mjs";

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
  "function approve(address spender, uint256 amount) external returns (bool)"
]);

const milestoneEscrowAbi = parseAbi([
  "function setReceivablePool(address receivablePool) external"
]);

const receivablePoolAbi = parseAbi([
  "function deposit(uint256 amount) external",
  "function setRiskLimits(uint256 maxReceivableTenor, uint256 clientExposureCap, uint256 freelancerExposureCap) external",
  "function setUnderwriter(address underwriter) external"
]);

const rpcUrl = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const privateKey = process.env.PRIVATE_KEY;
const usdc = process.env.USDC_ADDRESS;

if (!privateKey) throw new Error("PRIVATE_KEY is required.");
if (!usdc) throw new Error("USDC_ADDRESS is required.");

const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// The public Arc RPC rate-limits aggressively; wait for receipts with
/// patient retries and pace consecutive transactions.
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

async function readArtifact(name) {
  return JSON.parse(await readFile(`artifacts/${name}.json`, "utf8"));
}

async function deploy(name, args) {
  const artifact = await readArtifact(name);
  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args
  });
  console.log(`${name} deploy tx: ${hash}`);
  const receipt = await waitTx(hash); await sleep(1_500);
  console.log(`${name}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

const escrow = await deploy("MilestoneEscrow", [usdc]);
const pool = await deploy("ReceivablePool", [usdc, escrow]);

let hash = await walletClient.writeContract({
  address: escrow,
  abi: milestoneEscrowAbi,
  functionName: "setReceivablePool",
  args: [pool]
});
await waitTx(hash); await sleep(1_500);
console.log(`Linked pool: ${hash}`);

const underwriter = process.env.UNDERWRITER_ADDRESS;
if (underwriter) {
  hash = await walletClient.writeContract({
    address: pool,
    abi: receivablePoolAbi,
    functionName: "setUnderwriter",
    args: [underwriter]
  });
  await waitTx(hash); await sleep(1_500);
  console.log(`Delegated underwriting to ${underwriter}: ${hash}`);
}

const riskMaxTenorDays = process.env.RISK_MAX_TENOR_DAYS;
const riskClientCap = process.env.RISK_CLIENT_EXPOSURE_CAP_USDC;
const riskFreelancerCap = process.env.RISK_FREELANCER_EXPOSURE_CAP_USDC;
if (riskMaxTenorDays || riskClientCap || riskFreelancerCap) {
  const maxTenorSeconds = BigInt(Math.floor(Number(riskMaxTenorDays || "45") * 24 * 60 * 60));
  const clientCapUnits = parseUnits(riskClientCap || "5000", 6);
  const freelancerCapUnits = parseUnits(riskFreelancerCap || "5000", 6);

  hash = await walletClient.writeContract({
    address: pool,
    abi: receivablePoolAbi,
    functionName: "setRiskLimits",
    args: [maxTenorSeconds, clientCapUnits, freelancerCapUnits]
  });
  await waitTx(hash); await sleep(1_500);
  console.log(
    `Risk limits: ${riskMaxTenorDays || "45"} days, client ${riskClientCap || "5000"} USDC, freelancer ${
      riskFreelancerCap || "5000"
    } USDC (${hash})`
  );
}

const seed = process.env.POOL_SEED_USDC;
if (seed && Number(seed) > 0) {
  const seedUnits = parseUnits(seed, 6);
  hash = await walletClient.writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "approve",
    args: [pool, seedUnits]
  });
  await waitTx(hash); await sleep(1_500);

  hash = await walletClient.writeContract({
    address: pool,
    abi: receivablePoolAbi,
    functionName: "deposit",
    args: [seedUnits]
  });
  await waitTx(hash); await sleep(1_500);
  console.log(`Seeded pool with ${seed} USDC: ${hash}`);
}

await mkdir("deployments", { recursive: true });
await writeFile(
  "deployments/arc-testnet.json",
  JSON.stringify(
    {
      chainId: arcTestnet.id,
      rpcUrl,
      usdc,
      escrow,
      pool,
      underwriter: underwriter || null,
      deployedBy: account.address,
      deployedAt: new Date().toISOString(),
      riskLimits: {
        maxReceivableTenorDays: Number(riskMaxTenorDays || "45"),
        clientExposureCapUsdc: riskClientCap || "5000",
        freelancerExposureCapUsdc: riskFreelancerCap || "5000"
      }
    },
    null,
    2
  )
);

console.log("\nAdd these to .env.local and restart Next:");
console.log(`NEXT_PUBLIC_USDC_ADDRESS=${usdc}`);
console.log(`NEXT_PUBLIC_ESCROW_ADDRESS=${escrow}`);
console.log(`NEXT_PUBLIC_POOL_ADDRESS=${pool}`);
if (underwriter) {
  console.log(`NEXT_PUBLIC_UNDERWRITER_ADDRESS=${underwriter}`);
}
