import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    decimals: 18,
    name: "USDC",
    symbol: "USDC"
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"]
    }
  },
  blockExplorers: {
    default: {
      name: "Arcscan Testnet",
      url: "https://testnet.arcscan.app"
    }
  },
  testnet: true
});

export const ARC_FAUCET_URL = "https://faucet.circle.com/";

export function arcTxUrl(hash?: string) {
  if (!hash) return undefined;
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}

export function arcAddressUrl(address?: string) {
  if (!address) return undefined;
  return `${arcTestnet.blockExplorers.default.url}/address/${address}`;
}
