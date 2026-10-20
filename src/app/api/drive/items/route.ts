import { NextResponse } from "next/server";
import { driveJson, requireDriveUser } from "@/lib/drive/auth";
import { parseDriveCategories } from "@/lib/drive/category-names-utils";
import { decodeDriveCursor, parseDriveView } from "@/lib/drive/list-utils";
import { EMPTY_LISTING, listDriveItems } from "@/lib/drive/listing";
import { withModule } from "@/lib/modules/route-guard";

const MAX_QUERY_LENGTH = 200;

export const GET = withModule("drive", async (request, { checkAuth }) => {
	const { env, user, error } = await checkAuth(requireDriveUser(request));
	if (error) return error;
	const search = new URL(request.url).searchParams;
	const view = parseDriveView(search.get("view"));
	if (!view) return NextResponse.json({ error: "Unknown view" }, { status: 400 });
	const query = {
		view,
		parentId: search.get("parent") || null,
		query: (search.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
		types: parseDriveCategories(search.get("types")),
		foldersOnly: search.get("kind") === "folder",
		cursor: decodeDriveCursor(search.get("cursor")),
	};
	return driveJson(env, () => listDriveItems(env, user, query), EMPTY_LISTING);
});
