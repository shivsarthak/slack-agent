import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "password login has been replaced by magic links" },
    { status: 410 },
  );
}

export async function DELETE() {
  return NextResponse.json({ error: "use /api/auth/session" }, { status: 410 });
}
