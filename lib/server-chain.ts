import { createPublicClient, http } from "viem";
import { arcTestnet } from "./arc";

/** Server-side Arc client. Honors ARC_RPC_URL so deploys can use a dedicated RPC. */
export const ARC_RPC_URL = process.env.ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0];

export const arcPublicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL)
});
