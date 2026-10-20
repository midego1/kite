import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { abortUpload } from "@/lib/drive/uploads";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../types";

export const DELETE = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => abortUpload(env, user, id));
});
