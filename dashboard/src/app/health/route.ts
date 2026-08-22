import { Pool } from "pg";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("select 1");
    return NextResponse.json({ status: "ready" });
  } catch {
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  } finally {
    await pool.end();
  }
}
