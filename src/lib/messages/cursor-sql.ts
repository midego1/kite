import { and, eq, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { MessageListCursor } from "./cursor-types";

/** Rows strictly after `cursor` in `created_at DESC, id DESC` order. */
export function afterCursor(
	createdAt: Parameters<typeof lt>[0],
	id: Parameters<typeof lt>[0],
	cursor: MessageListCursor,
): SQL {
	return or(lt(createdAt, cursor.createdAt), and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)))!;
}
