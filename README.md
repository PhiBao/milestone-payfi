# Milestone PayFi

Milestone PayFi turns approved freelance work into instant working capital — settled by autonomous agents on Arc.

A client funds a USDC milestone on Arc, the freelancer submits work, the client approves it, and an **underwriter agent** scores the funded receivable and publishes a risk policy onchain. The freelancer can then take a discounted pay-now advance from the receivable pool. At the release time, a **settler agent** repays the pool from escrow — no human in the loop for risk or settlement.

The product wedge is **approved work becomes a programmable USDC receivable**.

## Why It Matters

Freelancers and small service teams wait after work is accepted before cash arrives. Clients want escrow protection, but freelancers want cash as soon as approved work is no longer delivery risk.

Milestone PayFi compresses that workflow:

1. Client funds the milestone before work starts.
2. Freelancer submits evidence into a shared task room.
3. Client approval creates a funded receivable.
4. The underwriter agent scores it against real onchain signals and publishes a risk policy.
5. Freelancer takes pay-now liquidity at a time-based discount.
6. The settler agent repays the pool on the scheduled release date.

Arc fits this product because it is USDC-native, EVM-compatible, and designed for programmable money with fast deterministic settlement.

## Hackathon Track Mapping (Build on Arc)

### DeFi track

| Criterion | Where Milestone PayFi proves it |
|---|---|
| Meaningful use of Arc and USDC | USDC escrow + receivable pool deployed on Arc Testnet; gas and settlement in USDC |
| Advanced programmable money flows | Conditional release (approval + time), multi-step settlement (fund → submit → approve → advance → repay), pool-marked early payout |
| Payment/liquidity workflows with App Kits | "Fund from any chain" panel bridges USDC into Arc via Circle App Kits (CCTPv2) |
| Why stablecoin-native changes what's possible | Approved work becomes an instantly financeable USDC receivable — a factoring product banks won't offer thin-file freelancers |

### Agentic Economy track

| Criterion | Where Milestone PayFi proves it |
|---|---|
| Clear decision logic tied to real signals | Underwriter scores receivables on pool liquidity, utilization, counterparty exposure, tenor, fraud flags (same deterministic engine as the UI) |
| Autonomous payments/settlement in USDC | Agent publishes risk policies from its own wallet; settler agent repays the pool via permissionless `releaseReceivable` |
| Agent Stack / identity | ERC-8004 identity registered on Arc (agent ID `851709`); owner-delegated, revocable onchain role (`setUnderwriter`) |
| No human in the loop | Approved receivable → scored → policy published → advance → settled, all agent-executed (see LIVE_PROOF.md) |

## Current Product Surface

The app is a shared task room, not a developer dashboard.

- Guided workflow rail from agreement to settlement.
- Client, freelancer, and liquidity role views.
- **Agentic layer panel**: underwriter identity (ERC-8004), autonomous decisions, Arcscan links.
- Judge-demo preset for fast recording.
- Live Arc Testnet contract and pool snapshot reads.
- Wallet funding readiness for USDC balance and escrow allowance.
- **Fund-from-any-chain panel** (Circle App Kits / CCTP bridge into Arc).
- Pay-now quote, risk tier, discount, liquidity, outstanding exposure, and max-advance panels.
- Underwriter agent publishes receivable risk policies; pool owner can override and can revoke the agent.
- Same-wallet fraud block, tenor limit, utilization cap, and client/freelancer exposure caps.
- LP disclosure copy in the liquidity panel.
- Onchain proof panel with Arcscan links.
- Sync-from-Arc endpoint to reconcile local metadata with contract state.
- API-side transaction verification before local receipts are accepted.
- Rate-limited write APIs; wallet-signature required for the tx-less cancel path.

## Architecture

```text
Next.js task-room app
  -> wagmi/viem wallet flow on Arc Testnet
  -> role-based PayFi workflow
  -> App Kits bridge panel (CCTP into Arc)
  -> metadata + receipts API (dual-mode store: Postgres or local fs)
  -> server-side transaction verification (ARC_RPC_URL-aware)

Agents (plain TS + viem, run anywhere)
  -> agents/underwriter.ts  scores Approved receivables, publishes policies
  -> agents/settler.ts      settles due receivables, repays the pool
  -> agents/register-identity.ts  ERC-8004 identity registration

Contracts (v3, Arc Testnet)
  -> MilestoneEscrow.sol
  -> ReceivablePool.sol   (owner-delegated underwriter role)
  -> USDC ERC-20 interface at 0x3600...
```

## Current Arc Testnet Deployment (v3)

```text
Chain ID:              5042002
USDC ERC-20 interface: 0x3600000000000000000000000000000000000000
MilestoneEscrow:       0x605d5f089a27c6a4f7b1271bdc27d03e4336e314
ReceivablePool:        0xc1fdb1507f489b5d426f4da398fd4da9d12e108f
Underwriter agent:     0x3C06bc77b522cf1ee770ac10D910764c934093E2
ERC-8004 agent ID:     851709
```

Full proof artifacts, transaction hashes, and verifier output: [LIVE_PROOF.md](./LIVE_PROOF.md).

## Smart Contracts

### MilestoneEscrow

`contracts/MilestoneEscrow.sol` handles milestone creation, client funding, submission, approval, pool-marked early payout, due-date release to freelancer or pool, participant-triggered settlement, and cancellation paths.

### ReceivablePool

`contracts/ReceivablePool.sol` handles LP deposits/withdrawals with pool-share accounting, owner-published **or underwriter-published** risk policies (`onlyRiskPublisher`), time-to-maturity advance pricing, same-wallet fraud rejection, max-tenor/max-advance/utilization/exposure guardrails, early payout, pool-triggered settlement, and repayment accounting.

v3 adds the `underwriter` role: the pool owner delegates risk publication to an autonomous agent wallet (`setUnderwriter`, revocable with `address(0)`).

## Run Locally

```bash
pnpm install
pnpm dev
```

Open the local URL printed by Next.

## Agents

```bash
# one-time: register the underwriter's ERC-8004 identity on Arc
pnpm agent:register

# watcher: detects Approved receivables, scores them, publishes policies
pnpm agent:underwrite

# watcher: settles due receivables, repays the pool
pnpm agent:settle

# single pass (demo/CI): append -- --once
```

Agent env: `UNDERWRITER_PRIVATE_KEY` (must match the delegated `UNDERWRITER_ADDRESS` on the pool), `SETTLER_PRIVATE_KEY`, `AGENT_API_URL`, `AGENT_POLL_INTERVAL_MS`. Use dedicated low-balance wallets; the owner can revoke the role anytime.

## Verify

```bash
pnpm typecheck
pnpm lint
pnpm contracts:compile
pnpm contracts:test    # 13/13 Foundry tests (no external deps)
pnpm build
pnpm verify:ui
```

Live Arc verifier (agent-driven v3 flow):

```bash
POOL_OWNER_PRIVATE_KEY="0x..." \
CLIENT_PRIVATE_KEY="0x..." \
FREELANCER_PRIVATE_KEY="0x..." \
UNDERWRITER_PRIVATE_KEY="0x..." \
VERIFY_AMOUNT_USDC="1" \
pnpm verify:onchain
```

## Deploy

Contracts to Arc Testnet (v3):

```bash
PRIVATE_KEY="0x..." \
USDC_ADDRESS="0x3600000000000000000000000000000000000000" \
POOL_SEED_USDC="45" \
UNDERWRITER_ADDRESS="0x..." \
pnpm contracts:deploy:arc
```

App to Vercel (durable store):

1. Create a Neon/Postgres database; set `DATABASE_URL` in Vercel env. The store auto-creates its table; without `DATABASE_URL` it falls back to local fs (dev mode).
2. Set `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_ESCROW_ADDRESS`, `NEXT_PUBLIC_POOL_ADDRESS`, `NEXT_PUBLIC_UNDERWRITER_ADDRESS`, and `ARC_RPC_URL`.
3. `pnpm build` and deploy (`vercel deploy` or Git integration).
4. Run agents on any always-on host (Railway/Fly/VPS): `pnpm agent:underwrite` + `pnpm agent:settle` with the env above plus `AGENT_API_URL=https://<your-deployment>`.

## Remaining Risks

- The risk model is transparent and deterministic for demo review; production needs richer credit data, fraud signals, KYB/KYC policy, signed invoices, dispute flows, and LP term sheets.
- Work evidence is a URL and note; production needs stronger file integrity and dispute support.
- The in-memory rate limiter throttles per instance; durable abuse control belongs at the edge.
- Agent keys must stay dedicated low-balance testnet wallets; production agents belong in managed key infrastructure (e.g. Circle Wallets).
- The v3 public deployment is verified; rerun `pnpm verify:onchain` immediately before final submission recording so the proof is current.
