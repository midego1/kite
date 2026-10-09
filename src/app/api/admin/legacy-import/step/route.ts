import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { runLegacyImportStep } from "@/lib/legacy-import/service";
import { hasSameOrigin, invalidOrigin, legacyImportErrorResponse } from "../utils";

const tokenSchema = z.object({ token: z.string().min(20).max(200) });
const stepSchema = z.object({ token: z.string(), step: z.number().int().min(0) });

/**
 * Authenticated by the token the start request returned rather than the
 * session: a full copy replaces the users and sessions tables, which signs
 * out the admin who started it halfway through.
 */
export async function POST(request: Request) {
	if (!hasSameOrigin(request)) return invalidOrigin();
	const body: unknown = await request.json().catch(() => null);
	if (!tokenSchema.safeParse(body).success) return NextResponse.json({ error: "Copy token required" }, { status: 401 });
	const parsed = stepSchema.safeParse(body);
	if (!parsed.success) return NextResponse.json({ error: "Invalid copy step" }, { status: 400 });
	try {
		return NextResponse.json(await runLegacyImportStep(getEnv(), parsed.data.token, parsed.data.step));
	} catch (error) {
		return legacyImportErrorResponse(error, "Copying failed");
	}
}
