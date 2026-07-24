"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink } from "lucide-react";
import type { CreateViemAdapterFromProviderParams } from "@circle-fin/adapter-viem-v2";

type Eip1193Provider = CreateViemAdapterFromProviderParams["provider"];

/**
 * "Fund from any chain" — bridges USDC from a source testnet into Arc via
 * Circle App Kits (CCTPv2). The connected wallet switches chains automatically;
 * bridged USDC lands in the same wallet on Arc Testnet for escrow funding or
 * LP deposits.
 */

const SOURCE_CHAINS = [
  { id: "Ethereum_Sepolia", label: "Ethereum Sepolia" },
  { id: "Base_Sepolia", label: "Base Sepolia" },
  { id: "Arbitrum_Sepolia", label: "Arbitrum Sepolia" }
] as const;

type SourceChain = (typeof SOURCE_CHAINS)[number]["id"];

interface BridgeStepView {
  name?: string;
  txHash?: string;
  state?: string;
}

export function BridgePanel() {
  const [sourceChain, setSourceChain] = useState<SourceChain>("Ethereum_Sepolia");
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<BridgeStepView[]>([]);
  const [done, setDone] = useState(false);

  async function bridge() {
    setBusy(true);
    setError(null);
    setSteps([]);
    setDone(false);
    try {
      const ethereum = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (!ethereum) throw new Error("No injected wallet found.");

      const [{ AppKit }, { createViemAdapterFromProvider }] = await Promise.all([
        import("@circle-fin/app-kit"),
        import("@circle-fin/adapter-viem-v2")
      ]);

      const adapter = await createViemAdapterFromProvider({ provider: ethereum });
      const kit = new AppKit();
      const result = await kit.bridge({
        from: { adapter, chain: sourceChain },
        to: { adapter, chain: "Arc_Testnet" },
        amount
      });

      const resultSteps = (result as { steps?: BridgeStepView[] }).steps ?? [];
      setSteps(
        resultSteps.map((step) => ({
          name: step.name,
          txHash: step.txHash,
          state: step.state
        }))
      );
      if (result.state === "success") {
        setDone(true);
      } else if (result.state === "error") {
        setError("Bridge reported an error. Check the steps below on the explorer.");
      } else {
        setDone(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bridge failed.");
    } finally {
      setBusy(false);
    }
  }

  const validAmount = /^\d+(\.\d{1,6})?$/.test(amount) && Number(amount) > 0;

  return (
    <div className="bridge-panel">
      <label className="submission-box">
        <span>Source chain</span>
        <select value={sourceChain} onChange={(event) => setSourceChain(event.target.value as SourceChain)}>
          {SOURCE_CHAINS.map((chain) => (
            <option key={chain.id} value={chain.id}>
              {chain.label}
            </option>
          ))}
        </select>
      </label>
      <label className="submission-box">
        <span>Amount (USDC)</span>
        <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="1.00" />
      </label>
      <button className="secondary-action" disabled={busy || !validAmount} onClick={bridge} type="button">
        {busy ? "Bridging via CCTP..." : (
          <>
            Bridge to Arc <ArrowRight size={15} aria-hidden="true" />
          </>
        )}
      </button>
      {busy && <p className="pending-line">Approve in wallet; CCTP attestation can take a minute.</p>}
      {error && <p className="field-error">{error}</p>}
      {done && <p className="small-muted">Bridged USDC arrives in this wallet on Arc Testnet.</p>}
      {steps.length > 0 && (
        <div className="proof-list bridge-steps">
          {steps.map((step, index) => (
            <div key={`${step.txHash ?? index}`}>
              <span>{step.name ?? `Step ${index + 1}`}</span>
              {step.txHash ? (
                <a href={`https://testnet.arcscan.app/tx/${step.txHash}`} target="_blank" rel="noreferrer">
                  {step.txHash.slice(0, 10)}... <ExternalLink size={12} aria-hidden="true" />
                </a>
              ) : (
                <strong>{step.state ?? "done"}</strong>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
