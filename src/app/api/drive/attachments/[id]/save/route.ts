import { saveAttachmentToDrive } from "@/lib/drive/attachments";
import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const POST = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	return driveJson(env, () => saveAttachmentToDrive(env, user, id, body));
});
