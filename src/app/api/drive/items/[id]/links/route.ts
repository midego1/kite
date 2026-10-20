import { appOrigin, driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { createLink, listLinks } from "@/lib/drive/links";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => listLinks(env, user, id, appOrigin(env, request)));
});

export const POST = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => createLink(env, user, id, body, appOrigin(env, request)));
});
