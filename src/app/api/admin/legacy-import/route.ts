import { NextResponse } from "next/server";
import { z } from "zod";
import { getLegacyImportStatus, startLegacyImport } from "@/lib/legacy-import/service";
import { authorizeLegacyImportRequest, legacyImportErrorResponse } from "./utils";

const startSchema = z.object({ mode: z.enum(["full", "catch-up"]) });

/** Whether this install has an old database bound, what it holds and how the last copy went. */
export async function GET(request: Request) {
	const authorization = await authorizeLegacyImportRequest(request);
	if ("error" in authorization) return authorization.error;
	try {
		return NextResponse.json(await getLegacyImportStatus(authorization.env));
	} catch (error) {
		return legacyImportErrorResponse(error, "Could not read the old install");
	}
}

/** Starts a copy and hands this page the token its steps authenticate with. */
export async function POST(request: Request) {
	const authorization = await authorizeLegacyImportRequest(request);
	if ("error" in authorization) return authorization.error;
	const parsed = startSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Choose what to copy" }, { status: 400 });
	try {
		return NextResponse.json(await startLegacyImport(authorization.env, parsed.data.mode, authorization.user.id));
	} catch (error) {
		return legacyImportErrorResponse(error, "Could not start copying");
	}
}
