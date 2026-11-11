import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { deleteMount, updateMount } from "@/lib/drive/mounts";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../types";

export const PATCH = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => updateMount(env, user, id, body));
});

export const DELETE = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => deleteMount(env, user, id));
});
