# Milestone PayFi Video Demo Guide

Target length: 3 minutes (hard cap for final submission).

The demo shows a user product first, then proves the agentic layer and Arc settlement. Do not show private keys, seed phrases, `.env` files, wallet import screens, or faucet internals.

## Pre-Recording Checklist

- Run `pnpm dev`.
- Open the local app URL.
- Start the agents in two terminals (they log JSON decisions live):
  - `pnpm agent:underwrite`
  - `pnpm agent:settle`
- Prepare funded Arc Testnet wallets for client, freelancer, and pool owner roles.
- Use `Load judge demo` to fill a clean scenario.
- Do not use the same wallet as both client and freelancer. v2+ blocks same-wallet advances as a fraud control.
- Keep terminal proof ready with `pnpm verify:onchain`.
- Rerun `pnpm verify:onchain` the day of recording and keep the JSON output visible in a tab.

Current live Arc Testnet deployment (v3):

```text
USDC:             0x3600000000000000000000000000000000000000
MilestoneEscrow: 0x605d5f089a27c6a4f7b1271bdc27d03e4336e314
ReceivablePool:  0xc1fdb1507f489b5d426f4da398fd4da9d12e108f
Underwriter:     0x3C06bc77b522cf1ee770ac10D910764c934093E2 (ERC-8004 agent 851709)
```

## Script

### 1. Product Opening (~20s)

Show the header, workflow rail, and role controls.

Say:

> This is Milestone PayFi. It turns approved freelance work into instant working capital. A client funds USDC escrow on Arc, the freelancer submits work, approval creates a funded receivable, and autonomous agents handle risk and settlement.

Point to the workflow rail.

> The product is a shared task room for the client, freelancer, and liquidity side — not an internal dashboard.

### 2. User Problem (~20s)

Switch between `Client`, `Freelancer`, and `Liquidity` views.

> The client wants protection before paying. The freelancer wants cash as soon as work is accepted. The liquidity provider wants short-duration exposure backed by already-funded escrow. Milestone PayFi connects those incentives with agents in the middle.

### 3. Create The Task Room (~25s)

Click `Load judge demo`, confirm wallet addresses, and click `Create task room`.

Point to task terms, role addresses, release time, receipts.

> The task room captures the agreement, but settlement state lives on Arc. The metadata receipt links the offchain task to the onchain milestone.

### 4. Create And Fund Onchain (~30s)

Click: `Create onchain milestone` → `Approve USDC` → `Fund escrow`. Approve wallet prompts.

Optional bridge mention: open `Fund from any chain`.

> Cross-chain USDC arrives through Circle App Kits and CCTP — clients and LPs fund from wherever their USDC already sits.

### 5. Submit And Approve Work (~25s)

Click: `Submit work onchain` → `Approve receivable`.

> Client approval is the PayFi moment. Before approval, this is escrow. After approval, it becomes a funded receivable that can be financed.

### 6. The Agent Acts — money shot (~35s)

Do NOT click anything. Switch to the underwriter agent terminal.

> Watch. No human touches this. The underwriter agent detects the approved receivable, scores it against real signals — pool liquidity, utilization, counterparty exposure, tenor, fraud flags — and publishes the risk policy onchain from its own wallet.

Show the agent log lines (`scored receivable`, `published risk policy onchain`), then back in the app: the risk panel now shows the published policy and the Agentic layer panel shows the agent's decision with the Arcscan link.

> The agent's identity is registered on Arc under ERC-8004, and the pool owner delegated this role onchain — and can revoke it.

### 7. Request Pay-Now Liquidity (~20s)

Point to the pay-now quote and pool panel. Click `Request early payout`.

> The pool advances USDC to the freelancer at a discount, capped by the agent-published policy and pool guardrails.

### 8. The Settler Repays The Pool (~20s)

Switch to the settler agent terminal (or show the receipt after the release time).

> At the release time the settler agent closes the receivable through the permissionless release path. Escrow repays the pool. If no advance was taken, escrow would pay the freelancer directly.

### 9. Proof (~15s)

Show the onchain proof panel, Arcscan links, and the `pnpm verify:onchain` JSON output.

> The verifier proves the whole path with real Arc Testnet USDC: create, fund, submit, approve, agent policy, advance, agent settle. Contract tests: thirteen for thirteen.

## Closing Line

> The wedge is approved work becoming instant working capital. Arc supplies the stable, fast settlement layer, and the agentic layer makes risk and settlement run themselves.

## If Something Fails

Wallet rejected:

> The wallet prompt was rejected, so the app stops the action and keeps the task state unchanged.

Wrong network:

> The wallet is not on Arc Testnet. The app blocks settlement actions until the network is corrected.

Agent hasn't published yet:

> The agent polls on an interval; one beat later the policy appears. (Fallback: the pool owner can publish manually from the risk panel.)

Release too early:

> The escrow contract enforces the scheduled release time; the settler settles as soon as it is due.

Same wallet blocked:

> The pool rejects client and freelancer addresses that match. The recording needs separate participant wallets.

Receipt verification failure:

> The API rejected the local update because the submitted transaction did not match the expected Arc event and contract state.
