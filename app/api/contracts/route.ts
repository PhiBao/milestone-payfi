import { NextResponse } from "next/server";
import { makeId } from "@/lib/metadata";
import { clientKey, rateLimitOk } from "@/lib/rate-limit";
import { buildWorkContract, createContractSchema } from "@/lib/schemas";
import { createContract, listContracts } from "@/lib/server-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ contracts: await listContracts() });
}

export async function POST(request: Request) {
  if (!rateLimitOk(clientKey(request, "create-contract"), 10, 60_000)) {
    return NextResponse.json({ error: "Too many rooms created. Try again shortly." }, { status: 429 });
  }

  const json = await request.json();
  const parsed = createContractSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid contract", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const contract = buildWorkContract(makeId("contract"), parsed.data);
  await createContract(contract);
  return NextResponse.json({ contract }, { status: 201 });
}
