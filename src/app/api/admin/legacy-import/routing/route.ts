import { NextResponse } from "next/server";
import { getLegacyRoutingStatus, repointLegacyRoutes } from "@/lib/legacy-import/routing";
import { authorizeLegacyImportRequest, legacyImportErrorResponse } from "../utils";

/** Email Routing rules on this install's zones that still deliver to the old Worker. */
export async function GET(request: Request) {
	const authorization = await authorizeLegacyImportRequest(request);
	if ("error" in authorization) return authorization.error;
	try {
		return NextResponse.json(await getLegacyRoutingStatus(authorization.env));
	} catch (error) {
		return legacyImportErrorResponse(error, "Could not read Email Routing");
	}
}

/** Sends those rules to this Worker, so new mail arrives here. */
export async function POST(request: Request) {
	const authorization = await authorizeLegacyImportRequest(request);
	if ("error" in authorization) return authorization.error;
	try {
		const result = await repointLegacyRoutes(authorization.env);
		return NextResponse.json({ ...result, status: await getLegacyRoutingStatus(authorization.env) });
	} catch (error) {
		return legacyImportErrorResponse(error, "Could not update Email Routing");
	}
}
