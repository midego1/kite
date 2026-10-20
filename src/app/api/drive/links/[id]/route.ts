import { appOrigin, driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { revokeLink, updateLink } from "@/lib/drive/links";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../types";

export const PATCH = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => updateLink(env, user, id, body, appOrigin(env, request)));
});

export const DELETE = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => revokeLink(env, user, id));
});
