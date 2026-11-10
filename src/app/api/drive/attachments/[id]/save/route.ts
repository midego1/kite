import { saveAttachmentToDrive } from "@/lib/drive/attachments";
import { driveJson, readJson, requireDriveUser } from "@/lib/drive/auth";
import { saveAttachmentToMount } from "@/lib/drive/mount-files";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const POST = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	const body = await readJson(request);
	// With `mountId` the copy goes to a linked WebDAV folder instead of Drive's own storage.
	const toMount = !!body && typeof body === "object" && "mountId" in body;
	return driveJson(env, () =>
		toMount ? saveAttachmentToMount(env, user, id, body) : saveAttachmentToDrive(env, user, id, body),
	);
});
