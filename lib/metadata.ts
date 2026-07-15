import { keccak256, toBytes, type Hex } from "viem";

export function metadataHash(input: unknown): Hex {
  return keccak256(toBytes(JSON.stringify(input)));
}

export function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 10)}`;
  }

  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
