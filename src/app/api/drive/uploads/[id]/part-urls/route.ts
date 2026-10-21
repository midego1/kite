import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { presignUploadParts } from "@/lib/drive/uploads";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

/** Signed part URLs for a direct upload; the browser sends each part to the store with no Kite headers. */
export const POST = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => presignUploadParts(env, user, id, body));
});
