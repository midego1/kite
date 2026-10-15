import { NextResponse } from "next/server";
import type { FinanceAnswer } from "./manual-context";

export const respond = (answer: FinanceAnswer) => NextResponse.json(answer.body, { status: answer.status });

/** The request's JSON body; anything unreadable is null, which every body schema refuses with 400. */
export async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}
