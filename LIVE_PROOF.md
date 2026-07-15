# Milestone PayFi Live Proof

Last updated: 2026-06-30

## Arc Testnet Addresses

```text
Chain ID:        5042002
RPC:             https://rpc.testnet.arc.network
USDC:            0x3600000000000000000000000000000000000000
MilestoneEscrow: 0x70088f2c0644fba8fe48bbc1310ecd9feda70e7c
ReceivablePool:  0xb9213179af47fb32d57c8e5c5b399afdac6b2dc9
```

Arcscan:

- Escrow: https://testnet.arcscan.app/address/0x70088f2c0644fba8fe48bbc1310ecd9feda70e7c
- Pool: https://testnet.arcscan.app/address/0xb9213179af47fb32d57c8e5c5b399afdac6b2dc9

## Read-Only Chain Snapshot

Verified from Arc Testnet after the v2 refresh:

```json
{
  "chainId": 5042002,
  "usdc": "0x3600000000000000000000000000000000000000",
  "symbol": "USDC",
  "decimals": 6,
  "escrow": "0x70088f2c0644fba8fe48bbc1310ecd9feda70e7c",
  "pool": "0xb9213179af47fb32d57c8e5c5b399afdac6b2dc9",
  "owner": "0x4Ba1e9e275EF61B56C99532D0066506436201D73",
  "liquidityUsdc": "50.02",
  "outstandingUsdc": "0",
  "utilizationCapBps": 6500,
  "maxAdvanceUsdc": "3500",
  "maxReceivableTenorDays": 45,
  "clientExposureCapUsdc": "5000",
  "freelancerExposureCapUsdc": "5000",
  "totalShares": "50",
  "paused": false
}
```

## Latest Verified V2 Flow

`pnpm verify:onchain` passed against the refreshed deployment:

```json
{
  "ok": true,
  "chainId": 5042002,
  "owner": "0x4Ba1e9e275EF61B56C99532D0066506436201D73",
  "client": "0x4Ba1e9e275EF61B56C99532D0066506436201D73",
  "freelancer": "0x147E1031f7C28D35502B7973a3Bfd3966470Dd61",
  "usdc": "0x3600000000000000000000000000000000000000",
  "escrow": "0x70088f2c0644fba8fe48bbc1310ecd9feda70e7c",
  "pool": "0xb9213179af47fb32d57c8e5c5b399afdac6b2dc9",
  "milestoneId": "1",
  "amountUsdc": "1",
  "riskTier": "A",
  "riskHash": "0x76fc27f6ca106d7fc6e7cb2e7d565f613f0539f8f5d3378cb91dfcb42b44a69b",
  "advanceQuoteUsdc": "0.98",
  "quoteDiscountBps": 80,
  "poolBeforeUsdc": "50",
  "poolAfterUsdc": "50.02",
  "outstandingBeforeUsdc": "0",
  "outstandingAfterUsdc": "0",
  "clientOutstandingBeforeUsdc": "0",
  "clientOutstandingAfterUsdc": "0",
  "freelancerOutstandingBeforeUsdc": "0",
  "freelancerOutstandingAfterUsdc": "0",
  "clientBeforeUsdc": "52.622913",
  "clientAfterUsdc": "51.613561",
  "freelancerBeforeUsdc": "1",
  "freelancerAfterUsdc": "1.974655"
}
```

Verifier transactions:

```text
Create milestone:          0x4db73528ce5991069997d62fa0679df72e7d604cd0dd8f396f4736c3e9e53724
Approve escrow USDC:       0x0c9634522525f565caa31a06366a30fdbc13242167e91cfdddd2d47e3d30dd7f
Fund escrow:               0x17a9a4894f4716c31638190bebed71c8b02e44f38b39a49158c2e7d0c37d0938
Submit work:               0x592f223eefbc30d3ad3132cbea1f939c89737e525675680cec2b4fc00fac0a8a
Approve receivable:        0x5e6c889a436d5258fc9ca6cb488bd3b3cac45a5fdd80bbd36995ddb98baa9470
Publish risk policy:       0x30e17d7e3b475cd592908166d91bb316aee324e8438e1aa28ff950115acdd816
Request early payout:      0x23a1e70367838a1fd03f1daff77a3e144a2b2672813b2b8f8b83021094d2b32c
Release payout via pool:   0x3147bd1711480042735bff2e25b4e951cb7d61754104dd320c9a26af0cb98067
```

## Arc Testnet Proof Command

Run:

```bash
POOL_OWNER_PRIVATE_KEY="0x..." \
CLIENT_PRIVATE_KEY="0x..." \
FREELANCER_PRIVATE_KEY="0x..." \
VERIFY_AMOUNT_USDC="1" \
pnpm verify:onchain
```

The verifier uses Arc Testnet USDC at `0x3600000000000000000000000000000000000000`. It requires separate client and freelancer wallets because v2 blocks same-wallet receivable advances. It verifies:

- create milestone
- approve USDC
- fund escrow
- submit work
- approve receivable
- publish receivable risk policy
- request early payout
- release scheduled payout
- assert final onchain state, including exposure accounting returning to the starting value

## Deployment Status

The current public Arc Testnet addresses are refreshed to v2. Active v2 behavior:

- owner-published receivable risk policies
- same-wallet fraud rejection
- max-tenor, utilization, client-exposure, and freelancer-exposure guardrails
- participant-triggered due settlement
- pool-triggered `releaseReceivable`
- LP shares and withdrawals
- time-based discount pricing

Before final submission recording, rerun `pnpm verify:onchain` and replace the verifier output above if the demo uses a newer milestone.
