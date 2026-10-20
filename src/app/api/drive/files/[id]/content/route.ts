import { requireDriveUser } from "@/lib/drive/auth";
import { userFileResponse } from "@/lib/drive/content";
import { driveTablesReady } from "@/lib/drive/errors";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	if (!(await driveTablesReady(env))) return Response.json({ error: "Not found" }, { status: 404 });
	const { id } = await params;
	return userFileResponse(env, user, request, id);
});
