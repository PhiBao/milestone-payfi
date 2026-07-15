import { NextResponse } from "next/server";
import { makeId } from "@/lib/metadata";
import { buildWorkContract, createContractSchema } from "@/lib/schemas";
import { createContract, listContracts } from "@/lib/server-store";

export async function GET() {
  return NextResponse.json({ contracts: await listContracts() });
}

export async function POST(request: Request) {
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
