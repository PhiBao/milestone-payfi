# Milestone PayFi Live Proof

Last updated: 2026-07-24 (v3 — agentic underwriter + settler)

## Arc Testnet Addresses (v3)

```text
Chain ID:        5042002
RPC:             https://rpc.testnet.arc.network
USDC:            0x3600000000000000000000000000000000000000
MilestoneEscrow: 0x605d5f089a27c6a4f7b1271bdc27d03e4336e314
ReceivablePool:  0xc1fdb1507f489b5d426f4da398fd4da9d12e108f
Pool owner:      0x4Ba1e9e275EF61B56C99532D0066506436201D73
Underwriter:     0x3C06bc77b522cf1ee770ac10D910764c934093E2 (delegated agent wallet)
```

Arcscan:

- Escrow: https://testnet.arcscan.app/address/0x605d5f089a27c6a4f7b1271bdc27d03e4336e314
- Pool: https://testnet.arcscan.app/address/0xc1fdb1507f489b5d426f4da398fd4da9d12e108f
- Underwriter agent: https://testnet.arcscan.app/address/0x3C06bc77b522cf1ee770ac10D910764c934093E2

## ERC-8004 Agent Identity

The underwriter agent holds an onchain identity on Arc's ERC-8004 IdentityRegistry:

```text
Registry:    0x8004A818BFB912233c491871b3d84c89A494BD9e
Agent ID:    851709
Owner:       0x3C06bc77b522cf1ee770ac10D910764c934093E2
Register tx: 0xd344557d14b3737404ed7e8845f8e6bf3fa4b52ba6dd58e74ea5573a62493ae3
```

## v3 Deployment Transactions

```text
MilestoneEscrow deploy:  0x1611ff99812e746e61c36d2e25f13610f9f6cfe527bb9c2f320a2996b3d7f2d0
ReceivablePool deploy:   0xd442da402930e71a54436a1f36a2eb1dac9a507ee59cfbfd0b26807fa56def2a
Link pool in escrow:     0x2656fc127d45c88410cb1601ec4f8482dcbd8780b6d3ddcdf2e5ed08d68dd14d
setUnderwriter (agent):  0x8b6ceab71a656a042f8ff630b454fbb2e7288fa64d01194e52caeed4dc75a4cf
Risk limits (45d/caps):  0x8b837c2eeeba21e1b6d9ee2d5a1989e0c92fb58c36ef860d5f82e27b9b392279
Pool seed 45 USDC:       0x5823b70f02100c7a8375e0141471fad8aeb9d487a4e7068981290b8e63796b50
```

## Latest Verified V3 Flow (agent-driven)

`pnpm verify:onchain` passed against the v3 deployment. The risk policy was
published by the **delegated underwriter agent wallet** (not the pool owner),
and settlement was triggered by the **settler agent** through the permissionless
`releaseReceivable` path:

```json
{
  "ok": true,
  "chainId": 5042002,
  "owner": "0x4Ba1e9e275EF61B56C99532D0066506436201D73",
  "client": "0x4Ba1e9e275EF61B56C99532D0066506436201D73",
  "freelancer": "0x0fb5Ea2755B2D4bCdFa61797Ba84b1472cc2C989",
  "usdc": "0x3600000000000000000000000000000000000000",
  "escrow": "0x605d5f089a27c6a4f7b1271bdc27d03e4336e314",
  "pool": "0xc1fdb1507f489b5d426f4da398fd4da9d12e108f",
  "milestoneId": "1",
  "amountUsdc": "1",
  "riskTier": "A",
  "riskHash": "0x5f61d7f24a6ffeba84f2fcb358c81333dfc5e43d70e32caf301c0c2c7d19c982",
  "underwriter": "0x3C06bc77b522cf1ee770ac10D910764c934093E2",
  "riskPolicyPublishedBy": "underwriter agent",
  "settledBy": "settler agent",
  "advanceQuoteUsdc": "0.98",
  "quoteDiscountBps": 80,
  "poolBeforeUsdc": "45",
  "poolAfterUsdc": "45.02",
  "outstandingBeforeUsdc": "0",
  "outstandingAfterUsdc": "0",
  "clientOutstandingBeforeUsdc": "0",
  "clientOutstandingAfterUsdc": "0",
  "freelancerOutstandingBeforeUsdc": "0",
  "freelancerOutstandingAfterUsdc": "0",
  "clientBeforeUsdc": "23.466049",
  "clientAfterUsdc": "22.459452",
  "freelancerBeforeUsdc": "1.5",
  "freelancerAfterUsdc": "2.474006"
}
```

Verifier transactions:

```text
Create milestone:                       0xb46a4aa52436b15610368297f9315eaa9fa2e5f9c894ad3724a9b3ce997e4789
Approve escrow USDC:                    0xd1825cbb70ad9f4f8745cf2edeb70346ac154ea8156c69b74537e6ed3f0d07db
Fund escrow:                            0x7836c3b4a0f88e09fcd2da889e3e94f8a1a9e773285fb1a03a9d192cf44282db
Submit work:                            0x0bcab66c7e7e0bca92b9387bcfc52323301d5da9e93478ea65315ada63dcdb68
Approve receivable:                     0x68ff369c1baa981876d1100046e91328b61b6ce48b1abb3db445ddcf33545378
Publish risk policy (underwriter):      0x3e91ebb11eb98ce94371e96288d8e130bd9ee4b1815466319a94958e69055881
Request early payout:                   0x4edfcbb6ab6d0be350332dcbeb2eb5e758cfe4012e9fac0a1cc1e46f33f6b8c2
Release payout via pool (settler):      0x9732c21013e79f5f65d2107c87fd9c6a9e8dd893f7c5ffc1b6596dec2162ce65
```

## Standalone Agent Run (autonomous scoring)

Milestone 2 was approved onchain with no offchain room attached. The watcher
agent (`pnpm agent:underwrite`) detected it, scored it against real signals,
and autonomously published a policy — honestly flagging the missing evidence
(Tier B instead of Tier A, demonstrating real decision logic):

```text
Agent log: {"message":"scored receivable","milestoneId":"2","tier":"B","score":20,"flags":["No work evidence captured"]}
Policy tx: 0x1c7abb7d1374fa4cc4d4facf248ecfcd561b1d5e3be4aa7fcc539fa1970c186e
Advance:   0xc6c3b57794ad8265caee9c29fe1a29765d365ca3caf5c5d60b26ca0f861d871a (0.9 USDC, Tier B 9000 bps max)
Settlement: milestone 2 released to the pool via pnpm agent:settle (releaseReceivable)
```

## Arc Testnet Proof Commands

Contract unit tests (13/13, Foundry):

```bash
pnpm contracts:test
```

Live verifier (v3, agent-driven):

```bash
POOL_OWNER_PRIVATE_KEY="0x..." \
CLIENT_PRIVATE_KEY="0x..." \
FREELANCER_PRIVATE_KEY="0x..." \
UNDERWRITER_PRIVATE_KEY="0x..." \
VERIFY_AMOUNT_USDC="1" \
pnpm verify:onchain
```

Agents:

```bash
pnpm agent:register     # ERC-8004 identity (one-time)
pnpm agent:underwrite   # watcher: score Approved receivables, publish policies
pnpm agent:settle       # watcher: settle due receivables, repay the pool
# single pass: append -- --once
```

The verifier uses Arc Testnet USDC at `0x3600000000000000000000000000000000000000`. It requires separate client and freelancer wallets (v2+ blocks same-wallet receivable advances). When the pool has a delegated underwriter, `UNDERWRITER_PRIVATE_KEY` proves the agent path; without it the owner publishes directly (backwards compatible).

## Deployment Status

Active v3 behavior:

- owner-delegated underwriter role (`setUnderwriter`, revocable) — risk policies publishable by the autonomous agent
- same-wallet fraud rejection
- max-tenor, utilization, client-exposure, and freelancer-exposure guardrails
- participant-triggered due settlement
- permissionless pool settlement (`releaseReceivable`) — settler agent keeps the pool whole
- LP shares and withdrawals
- time-based discount pricing
- ERC-8004 registered agent identity

Before final submission recording, rerun `pnpm verify:onchain` and replace the verifier output above so the proof is current.
