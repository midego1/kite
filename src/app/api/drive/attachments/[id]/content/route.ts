import { requireDriveUser } from "@/lib/drive/auth";
import { attachmentResponse } from "@/lib/drive/content";
import { withModule } from "@/lib/modules/route-guard";
import type { DriveIdContext } from "../../../types";

export const GET = withModule<DriveIdContext>("drive", async (request, { params, checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const { id } = await params;
	return attachmentResponse(env, user, request, id);
});
