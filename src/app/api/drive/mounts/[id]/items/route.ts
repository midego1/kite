import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { deleteMountItem, listMountItems, moveMountItem } from "@/lib/drive/mount-files";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

const pathOf = (request: Request) => new URL(request.url).searchParams.get("path");

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => listMountItems(env, user, id, pathOf(request)), { mount: null, path: "/", items: [] });
});

export const PATCH = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => moveMountItem(env, user, id, body));
});

export const DELETE = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => deleteMountItem(env, user, id, pathOf(request)));
});
