# Milestone PayFi

Milestone PayFi turns approved freelance and service work into instant working capital.

A client funds a USDC milestone on Arc, the freelancer submits work, the client approves it, and the freelancer can take a discounted pay-now advance from a receivable pool. When the scheduled release time arrives, escrow repays the pool. If no advance was taken, escrow pays the freelancer directly.

The product wedge is **approved work becomes a programmable USDC receivable**.

## Why It Matters

Freelancers and small service teams often wait after work is accepted before cash arrives. Clients want escrow protection, but freelancers want cash as soon as approved work is no longer delivery risk.

Milestone PayFi compresses that workflow:

1. Client funds the milestone before work starts.
2. Freelancer submits evidence into a shared task room.
3. Client approval creates a funded receivable.
4. Freelancer can take pay-now liquidity.
5. Escrow repays the pool on the scheduled release date.

Arc fits this product because it is USDC-native, EVM-compatible, and designed for programmable money with fast deterministic settlement.

## Current Product Surface

The app is a shared task room, not a developer dashboard.

It includes:

- Guided workflow rail from agreement to settlement.
- Client, freelancer, and liquidity role views.
- Judge-demo preset for fast recording.
- Live Arc Testnet contract and pool snapshot reads.
- Wallet funding readiness for USDC balance and escrow allowance.
- Pay-now quote, risk tier, discount, liquidity, outstanding exposure, and max-advance panels.
- Pool-owner risk publication before any receivable can be advanced.
- Same-wallet fraud block, tenor limit, utilization cap, and client/freelancer exposure caps.
- LP disclosure copy in the liquidity panel.
- Onchain proof panel with Arcscan links.
- Sync-from-Arc endpoint to reconcile local metadata with contract state.
- API-side transaction verification before local receipts are accepted.

## Smart Contracts

### MilestoneEscrow

`contracts/MilestoneEscrow.sol` handles:

- Milestone creation by either participant.
- Client USDC funding.
- Freelancer submission.
- Client approval.
- Pool-marked early payout.
- Due-date release to freelancer or receivable pool.
- Participant-triggered settlement after the release time.
- Cancellation paths for unfunded or expired unsubmitted milestones.

### ReceivablePool

`contracts/ReceivablePool.sol` handles:

- LP deposits with pool-share accounting.
- LP withdrawals when enough liquidity is idle.
- Owner-published receivable risk policies.
- Time-to-maturity advance pricing driven by each risk policy.
- Same-wallet fraud rejection, max-tenor, max-advance, utilization-cap, client-exposure, freelancer-exposure, and pause guardrails.
- Early payout to the freelancer.
- Pool-triggered receivable settlement through `releaseReceivable`.
- Repayment accounting when escrow releases funds back to the pool.

## Current Arc Testnet Deployment

The current Arc Testnet deployment record points to these addresses:

```text
Chain ID:              5042002
USDC ERC-20 interface: 0x3600000000000000000000000000000000000000
MilestoneEscrow:       0x70088f2c0644fba8fe48bbc1310ecd9feda70e7c
ReceivablePool:        0xb9213179af47fb32d57c8e5c5b399afdac6b2dc9
```

That deployment is the v2 Arc Testnet refresh. It has risk-gated receivable policies, same-wallet fraud controls, exposure caps, LP disclosures, participant-triggered due settlement, pool share accounting, and time-based pricing live at the public addresses above.

## Architecture

```text
Next.js task-room app
  -> wagmi/viem wallet flow on Arc Testnet
  -> role-based PayFi workflow
  -> local metadata and receipts API
  -> server-side transaction verification

API routes
  -> POST /api/contracts
  -> GET  /api/contracts
  -> GET  /api/contracts/:id
  -> POST /api/contracts/:id/events
  -> POST /api/contracts/:id/sync

Local persistence
  -> .data/contracts.json

Contracts
  -> MilestoneEscrow.sol
  -> ReceivablePool.sol
  -> USDC ERC-20 interface at 0x3600...
```

The contracts hold settlement state and USDC movement. The local API stores user-facing task metadata and only accepts onchain receipt events after validating Arc transaction receipts.

## Run Locally

```bash
pnpm install
pnpm dev
```

Open the local URL printed by Next.

## Verify

Run static and production checks:

```bash
pnpm typecheck
pnpm lint
pnpm contracts:compile
pnpm build
```

Run the browser smoke test:

```bash
export CHROME_BIN="$HOME/.local/bin/google-chrome"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$HOME/.local/bin/google-chrome"
export MILESTONE_PAYFI_URL="http://127.0.0.1:3000"
pnpm verify:ui
```

Run the live Arc verifier with funded Arc Testnet wallets. v2 intentionally requires separate client and freelancer wallets, plus the pool owner wallet that publishes the risk policy:

```bash
POOL_OWNER_PRIVATE_KEY="0x..." \
CLIENT_PRIVATE_KEY="0x..." \
FREELANCER_PRIVATE_KEY="0x..." \
VERIFY_AMOUNT_USDC="1" \
pnpm verify:onchain
```

The live verifier uses Arc Testnet USDC at `0x3600000000000000000000000000000000000000`. It creates a milestone, approves USDC, funds escrow, submits work, approves the receivable, publishes a Tier A risk policy, requests early payout, releases scheduled payout, and asserts final contract state on Arc.

## Deploy Upgraded Contracts

The deployment script compiles the contracts, deploys escrow and pool to Arc Testnet, links the pool, and optionally seeds liquidity:

```bash
PRIVATE_KEY="0x..." \
USDC_ADDRESS="0x3600000000000000000000000000000000000000" \
POOL_SEED_USDC="1000" \
RISK_MAX_TENOR_DAYS="45" \
RISK_CLIENT_EXPOSURE_CAP_USDC="5000" \
RISK_FREELANCER_EXPOSURE_CAP_USDC="5000" \
pnpm contracts:deploy:arc
```

Then update `.env.local` with the printed addresses:

```text
NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NEXT_PUBLIC_ESCROW_ADDRESS=...
NEXT_PUBLIC_POOL_ADDRESS=...
```

## Hackathon Demo Thesis

Lead with the user outcome:

> Milestone PayFi lets freelancers get paid now after work is approved, while clients keep escrow protection and liquidity providers are repaid from already-funded USDC escrow.

Then prove:

- Arc Testnet contract addresses are configured.
- Client funds USDC escrow.
- Freelancer submits work evidence.
- Client approval creates the receivable.
- Pool owner publishes a receivable risk policy.
- Pool advances USDC at a discount.
- Escrow repays the pool at settlement.
- The API rejects local receipt updates unless the Arc transaction receipt matches the expected event and state.

## Remaining Risks

- Local filesystem persistence is hackathon-grade; production needs durable storage and authentication.
- Work evidence is a URL and note; production needs stronger file integrity and dispute support.
- The risk model is transparent and deterministic for demo review; production needs richer credit data, fraud signals, KYB/KYC policy, signed invoices, dispute flows, and LP term sheets.
- The v2 public deployment has been refreshed and verified; rerun `pnpm verify:onchain` immediately before final submission recording so the proof is current.
