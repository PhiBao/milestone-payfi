import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { arcTestnet } from "./arc";
import { deployment } from "./contracts";
import { metadataHash } from "./metadata";
import type { Address, WorkContract } from "./payfi-types";

const addressSchema = z
  .string()
  .trim()
  .refine((value) => isAddress(value), "Must be a valid EVM address")
  .transform((value) => getAddress(value) as Address);

const hexSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]+$/, "Must be a hex string")
  .transform((value) => value as `0x${string}`);

export const createContractSchema = z.object({
  title: z.string().trim().min(3).max(100),
  summary: z.string().trim().min(8).max(400),
  clientName: z.string().trim().min(2).max(80),
  clientEmail: z.string().trim().email(),
  clientAddress: addressSchema,
  freelancerName: z.string().trim().min(2).max(80),
  freelancerEmail: z.string().trim().email(),
  freelancerAddress: addressSchema,
  creatorRole: z.enum(["client", "freelancer"]),
  milestoneTitle: z.string().trim().min(3).max(100),
  deliverable: z.string().trim().min(8).max(500),
  amountUsdc: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, "Use a USDC amount with up to 6 decimals"),
  releaseAt: z.string().datetime()
});

export const eventSchema = z.object({
  milestoneId: z.string(),
  action: z.enum([
    "onchain_created",
    "client_funded",
    "work_submitted",
    "client_approved",
    "risk_reviewed",
    "early_payout_taken",
    "scheduled_release",
    "cancelled"
  ]),
  actorAddress: addressSchema,
  txHash: hexSchema.optional(),
  onchainId: z.string().optional(),
  submissionNote: z.string().trim().max(800).optional(),
  submissionUrl: z.string().trim().url().optional(),
  advanceUsdc: z.string().trim().optional(),
  riskReview: z
    .object({
      score: z.number().int().min(0).max(100),
      tier: z.enum(["A", "B", "C", "Blocked"]),
      flags: z.array(z.string().trim().min(1).max(140)).max(12),
      hardBlock: z.boolean(),
      maxAdvanceBps: z.number().int().min(0).max(10_000),
      baseDiscountBps: z.number().int().min(0).max(9_999),
      annualizedDiscountBps: z.number().int().min(0).max(9_999),
      maxDiscountBps: z.number().int().min(0).max(9_999),
      riskHash: hexSchema,
      reviewedAt: z.string().datetime()
    })
    .optional()
});

export function buildWorkContract(
  id: string,
  input: z.infer<typeof createContractSchema>
): WorkContract {
  const createdAt = new Date().toISOString();
  const hash = metadataHash({
    id,
    title: input.title,
    summary: input.summary,
    milestoneTitle: input.milestoneTitle,
    deliverable: input.deliverable,
    amountUsdc: input.amountUsdc,
    releaseAt: input.releaseAt,
    clientAddress: input.clientAddress,
    freelancerAddress: input.freelancerAddress
  });

  return {
    id,
    title: input.title,
    summary: input.summary,
    clientName: input.clientName,
    clientEmail: input.clientEmail,
    clientAddress: input.clientAddress,
    freelancerName: input.freelancerName,
    freelancerEmail: input.freelancerEmail,
    freelancerAddress: input.freelancerAddress,
    creatorRole: input.creatorRole,
    createdAt,
    chainId: arcTestnet.id,
    escrowAddress: deployment.escrow,
    poolAddress: deployment.pool,
    milestones: [
      {
        id: `${id}_m1`,
        title: input.milestoneTitle,
        deliverable: input.deliverable,
        amountUsdc: input.amountUsdc,
        releaseAt: input.releaseAt,
        metadataHash: hash,
        status: "draft"
      }
    ],
    receipts: [
      {
        id: `${id}_r1`,
        type: "task_created",
        actorAddress:
          input.creatorRole === "client" ? input.clientAddress : input.freelancerAddress,
        label: `${input.creatorRole === "client" ? input.clientName : input.freelancerName} created the task room.`,
        createdAt
      }
    ]
  };
}
