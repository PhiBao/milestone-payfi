import { NextResponse } from "next/server";
import { recoverMessageAddress } from "viem";
import { formatUsdc } from "@/lib/format";
import { verifyEventOnchain } from "@/lib/onchain-verify";
import { clientKey, rateLimitOk } from "@/lib/rate-limit";
import { eventSchema } from "@/lib/schemas";
import { appendReceipt, getContract, mutateContract, updateMilestoneStatus } from "@/lib/server-store";
import type { MilestoneStatus, ReceiptType, WorkContract } from "@/lib/payfi-types";

const actionToStatus: Record<string, MilestoneStatus> = {
  onchain_created: "created_onchain",
  client_funded: "funded",
  work_submitted: "submitted",
  client_approved: "approved",
  risk_reviewed: "approved",
  early_payout_taken: "early_paid",
  scheduled_release: "released",
  cancelled: "cancelled"
};

const actionToReceiptType: Record<string, ReceiptType> = {
  onchain_created: "onchain_created",
  client_funded: "client_funded",
  work_submitted: "work_submitted",
  client_approved: "client_approved",
  risk_reviewed: "risk_reviewed",
  early_payout_taken: "early_payout_taken",
  scheduled_release: "scheduled_release",
  cancelled: "cancelled"
};

const transitions: Record<
  string,
  {
    from: MilestoneStatus[];
    actor: "client" | "freelancer" | "participant" | "any";
    requiresTx: boolean;
    requiresOnchainId?: boolean;
  }
> = {
  onchain_created: {
    from: ["draft"],
    actor: "participant",
    requiresTx: true,
    requiresOnchainId: true
  },
  client_funded: {
    from: ["created_onchain"],
    actor: "client",
    requiresTx: true
  },
  work_submitted: {
    from: ["funded"],
    actor: "freelancer",
    requiresTx: true
  },
  client_approved: {
    from: ["submitted"],
    actor: "client",
    requiresTx: true
  },
  risk_reviewed: {
    from: ["approved"],
    actor: "any",
    requiresTx: true
  },
  early_payout_taken: {
    from: ["approved"],
    actor: "freelancer",
    requiresTx: true
  },
  scheduled_release: {
    from: ["approved", "early_paid"],
    // Settlement is permissionless onchain (any keeper/settler agent can route
    // it through pool.releaseReceivable). The receipt gate is the mandatory
    // onchain verification below: sender, Released event, recipient, and final
    // status must all match.
    actor: "any",
    requiresTx: true
  },
  cancelled: {
    from: ["draft", "created_onchain", "funded"],
    actor: "participant",
    requiresTx: false
  }
};

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function labelFor(contract: WorkContract, milestoneId: string, action: string, advanceUsdc?: string) {
  const milestone = contract.milestones.find((item) => item.id === milestoneId);
  const title = milestone?.title ?? "Milestone";

  switch (action) {
    case "onchain_created":
      return `${title} was created on Arc Testnet escrow.`;
    case "client_funded":
      return `${contract.clientName} funded ${title} with ${formatUsdc(milestone?.amountUsdc ?? "0")} USDC.`;
    case "work_submitted":
      return `${contract.freelancerName} submitted work for ${title}.`;
    case "client_approved":
      return `${contract.clientName} approved ${title}; the funded milestone is now a receivable.`;
    case "risk_reviewed":
      return `Pool risk policy was published for ${title}.`;
    case "early_payout_taken":
      return `${contract.freelancerName} took an early payout${advanceUsdc ? ` of ${formatUsdc(advanceUsdc)}` : ""}.`;
    case "scheduled_release":
      return `${title} was released and settled on Arc Testnet.`;
    case "cancelled":
      return `${title} was cancelled.`;
    default:
      return `${title} updated.`;
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!rateLimitOk(clientKey(request, "post-event"), 30, 60_000)) {
    return NextResponse.json({ error: "Too many events. Try again shortly." }, { status: 429 });
  }

  const json = await request.json();
  const parsed = eventSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid event", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const payload = parsed.data;
  const existing = await getContract(params.id);

  if (!existing) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  const milestone = existing.milestones.find((item) => item.id === payload.milestoneId);
  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const transition = transitions[payload.action];
  if (!transition.from.includes(milestone.status)) {
    return NextResponse.json(
      {
        error: "Invalid milestone transition",
        currentStatus: milestone.status,
        action: payload.action
      },
      { status: 409 }
    );
  }

  if (transition.requiresTx && !payload.txHash) {
    return NextResponse.json({ error: "Transaction hash is required for this action" }, { status: 400 });
  }

  if (transition.requiresOnchainId && !payload.onchainId) {
    return NextResponse.json({ error: "Onchain milestone id is required" }, { status: 400 });
  }

  const isClient = sameAddress(payload.actorAddress, existing.clientAddress);
  const isFreelancer = sameAddress(payload.actorAddress, existing.freelancerAddress);
  const allowedActor =
    transition.actor === "any"
      ? true
      : transition.actor === "participant"
      ? isClient || isFreelancer
      : transition.actor === "client"
        ? isClient
        : isFreelancer;

  if (!allowedActor) {
    return NextResponse.json({ error: "Actor is not allowed for this action" }, { status: 403 });
  }

  // `cancelled` is the only action without an onchain receipt gate, so it
  // requires an EIP-191 wallet signature from the claimed participant.
  if (payload.action === "cancelled") {
    const signature = request.headers.get("x-payfi-signature");
    if (!signature) {
      return NextResponse.json({ error: "Wallet signature is required for cancellation." }, { status: 401 });
    }
    try {
      const recovered = await recoverMessageAddress({
        message: `milestone-payfi:${params.id}:${payload.milestoneId}:cancelled`,
        signature: signature as `0x${string}`
      });
      if (!sameAddress(recovered, payload.actorAddress)) {
        return NextResponse.json({ error: "Signature does not match the actor address." }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid wallet signature." }, { status: 403 });
    }
  }

  if (transition.requiresTx) {
    try {
      await verifyEventOnchain({
        contract: existing,
        milestone,
        payload
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Could not verify transaction on Arc." },
        { status: 422 }
      );
    }
  }

  const updated = await mutateContract(params.id, (contract) => {
    const status = actionToStatus[payload.action];
    const withMilestone = updateMilestoneStatus({
      contract,
      milestoneId: payload.milestoneId,
      status,
      txHash: payload.txHash,
      onchainId: payload.onchainId,
      submissionNote: payload.submissionNote,
      submissionUrl: payload.submissionUrl,
      advanceUsdc: payload.advanceUsdc,
      riskReview: payload.riskReview
    });

    return appendReceipt({
      contract: withMilestone,
      type: actionToReceiptType[payload.action],
      actorAddress: payload.actorAddress,
      txHash: payload.txHash,
      label: labelFor(contract, payload.milestoneId, payload.action, payload.advanceUsdc)
    });
  });

  if (!updated) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  return NextResponse.json({ contract: updated });
}
