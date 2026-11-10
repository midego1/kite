import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { mountFileResponse, uploadMountFile } from "@/lib/drive/mount-files";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return mountFileResponse(env, user, request, id);
});

/** The raw request body is streamed to the server; see `uploadMountFile`. */
export const PUT = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => uploadMountFile(env, user, request, id));
});
