import { NextResponse } from "next/server";
import { openapi } from "@/server/openapi";

export function GET() {
  return NextResponse.json(openapi);
}
