import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { addShare, getShares, removeShare } from "@/lib/drive/shares";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return driveJson(env, () => getShares(env, user, id));
});

export const POST = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => addShare(env, user, id, body));
});

export const DELETE = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const shareId = new URL(request.url).searchParams.get("shareId");
	return driveJson(env, () => removeShare(env, user, id, shareId));
});
