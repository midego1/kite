import { listDriveAttachments } from "@/lib/drive/attachments";
import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { parseDriveCategories } from "@/lib/drive/category-names-utils";
import { decodeDriveCursor } from "@/lib/drive/list-utils";
import { withModule } from "@/lib/modules/route-guard";

export const GET = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const search = new URL(request.url).searchParams;
	const types = parseDriveCategories(search.get("types"));
	const cursor = decodeDriveCursor(search.get("cursor"));
	return driveJson(env, () => listDriveAttachments(env, user, types, cursor));
});
