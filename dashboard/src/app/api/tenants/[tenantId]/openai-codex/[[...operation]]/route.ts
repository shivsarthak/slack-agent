import type { NextRequest } from "next/server";
import { handleOpenAICodexOnboarding } from "@/lib/openai-onboarding";

export const dynamic = "force-dynamic";

export const GET = (request: NextRequest) =>
  handleOpenAICodexOnboarding(request);
export const POST = (request: NextRequest) =>
  handleOpenAICodexOnboarding(request);
export const DELETE = (request: NextRequest) =>
  handleOpenAICodexOnboarding(request);
