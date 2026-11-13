import { and, eq, ne } from "drizzle-orm";
import type { getDb } from "@/db";
import { mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { endAccessStatements } from "@/lib/auth/session";

type Db = ReturnType<typeof getDb>;

export async function selectAccountById(db: Db, id: string) {
	const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
	return account ?? null;
}

export async function emailBelongsToAnotherAccount(db: Db, accountId: string, email: string) {
	const [account] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.email, email), ne(users.id, accountId)))
		.limit(1);
	return !!account;
}

export async function updateAccountCredentials(
	db: Db,
	id: string,
	input: { email?: string; name: string; password: string | null; disabled?: boolean },
) {
	// A password set here is a reset: in the same batch, whoever held the old one is signed out everywhere and the
	// account's calendar subscription links end.
	await db.batch([
		db
			.update(users)
			.set({
				...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
				name: input.name,
				...(typeof input.disabled === "boolean" ? { disabled: input.disabled } : {}),
				...(input.password ? { passwordHash: hashPassword(input.password) } : {}),
			})
			.where(eq(users.id, id)),
		db
			.update(mailboxes)
			.set({ displayName: input.name })
			.where(and(eq(mailboxes.userId, id), eq(mailboxes.type, "personal"))),
		...(input.password ? await endAccessStatements(db, id) : []),
	]);
}
