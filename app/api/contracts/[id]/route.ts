import { NextResponse } from "next/server";
import { getContract } from "@/lib/server-store";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const contract = await getContract(params.id);

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  return NextResponse.json({ contract });
}
