import { NextResponse } from "next/server";
import { restartAgent } from "@/lib/agent-process";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await restartAgent();
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
