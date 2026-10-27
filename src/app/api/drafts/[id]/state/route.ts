import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getAgentDraftState } from "@/lib/agent/approvals/draft-state";
import type { DraftRouteParams } from "../types";

/** Whether an assistant draft is still a draft, was sent or scheduled, or is gone. Read-only. */
export async function GET(request: Request, { params }: DraftRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	return NextResponse.json(await getAgentDraftState(env, user, id));
}
