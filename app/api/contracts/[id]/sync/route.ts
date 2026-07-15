import { NextResponse } from "next/server";
import { createPublicClient, http, parseUnits } from "viem";
import { arcTestnet } from "@/lib/arc";
import { deployment, milestoneEscrowAbi, USDC_DECIMALS } from "@/lib/contracts";
import { getContract, mutateContract } from "@/lib/server-store";
import type { MilestoneStatus } from "@/lib/payfi-types";

const statusByIndex: MilestoneStatus[] = [
  "created_onchain",
  "funded",
  "submitted",
  "approved",
  "early_paid",
  "released",
  "cancelled"
];

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0])
});

function sameAddress(a?: string, b?: string) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export async function POST(_: Request, { params }: { params: { id: string } }) {
  if (!deployment.escrow) {
    return NextResponse.json({ error: "Escrow address is not configured" }, { status: 400 });
  }

  const existing = await getContract(params.id);
  if (!existing) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  try {
    const syncedMilestones = await Promise.all(
      existing.milestones.map(async (milestone) => {
        if (!milestone.onchainId) return milestone;

        const [freelancer, client, amount, releaseAfter, status, , metadataHash] =
          await publicClient.readContract({
            address: deployment.escrow!,
            abi: milestoneEscrowAbi,
            functionName: "milestones",
            args: [BigInt(milestone.onchainId)]
          });

        const matchesTask =
          sameAddress(freelancer, existing.freelancerAddress) &&
          sameAddress(client, existing.clientAddress) &&
          amount === parseUnits(milestone.amountUsdc, USDC_DECIMALS) &&
          Number(releaseAfter) === Math.floor(new Date(milestone.releaseAt).getTime() / 1000) &&
          (metadataHash as string).toLowerCase() === milestone.metadataHash.toLowerCase();

        if (!matchesTask) return milestone;
        return {
          ...milestone,
          status: statusByIndex[Number(status)] ?? milestone.status
        };
      })
    );

    const synced = await mutateContract(params.id, (contract) => ({
      ...contract,
      milestones: syncedMilestones
    }));

    return NextResponse.json({ contract: synced });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not sync contract from Arc." },
      { status: 422 }
    );
  }
}
