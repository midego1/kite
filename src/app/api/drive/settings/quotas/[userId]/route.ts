import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { clearQuotaOverride, setQuotaOverride } from "@/lib/drive/settings";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveUserIdContext } from "../../../types";

export const PUT = withModule<DriveUserIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request, { admin: true }));
	if (error) return error;
	const { userId } = await params;
	const body = await readJson(request);
	return driveJson(env, () => setQuotaOverride(env, user, userId, body));
});

export const DELETE = withModule<DriveUserIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request, { admin: true }));
	if (error) return error;
	const { userId } = await params;
	return driveJson(env, () => clearQuotaOverride(env, user, userId));
});
