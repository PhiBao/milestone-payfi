import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "./contracts";

export function parseUsdc(value: string) {
  return parseUnits(value || "0", USDC_DECIMALS);
}

export function formatUsdcUnits(value: bigint) {
  return formatUsdc(formatUnits(value, USDC_DECIMALS));
}

export function formatUsdc(value: string | number) {
  const numeric = typeof value === "number" ? value : Number(value || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: numeric % 1 === 0 ? 0 : 2,
    maximumFractionDigits: numeric % 1 === 0 ? 0 : 2
  }).format(numeric);
}

export function shortAddress(address?: string) {
  if (!address) return "Not set";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function friendlyDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}
