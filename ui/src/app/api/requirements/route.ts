import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const reqPath = path.resolve(process.cwd(), "../requirements.txt");
  try {
    const content = fs.readFileSync(reqPath, "utf8");
    return new NextResponse(content, {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  } catch {
    return new NextResponse("", { status: 200 });
  }
}
