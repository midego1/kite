import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { putUploadPart } from "@/lib/drive/uploads";
import { withModule } from "@/lib/modules/route-guard";
import type { DrivePartContext } from "../../../../types";

/** The body is streamed straight into the store; it is never buffered here. */
export const PUT = withModule<DrivePartContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id, n } = await params;
	const partNumber = /^\d{1,5}$/.test(n) ? Number(n) : NaN;
	return driveJson(env, () => putUploadPart(env, user, id, partNumber, request));
});
