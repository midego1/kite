import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { getSessionTokenFromRequestHeaders, setPasswordAndEndAccess } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getEnv } from "@/lib/cloudflare";
import type { ChangePasswordInput } from "./types";
import { parseChangePasswordRequest } from "./utils";

export async function PATCH(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	let parsed: ChangePasswordInput;

	try {
		parsed = await parseChangePasswordRequest(request);
	} catch (err) {
		if (err instanceof ZodError) {
			return NextResponse.json({ error: err.flatten() }, { status: 400 });
		}
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}

	if (!verifyPassword(parsed.currentPassword, user.passwordHash)) {
		return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
	}

	if (verifyPassword(parsed.newPassword, user.passwordHash)) {
		return NextResponse.json({ error: "New password must be different from the current password" }, { status: 400 });
	}

	// In one batch: the new password, every other session signed out (this one stays) and calendar subscription links ended.
	await setPasswordAndEndAccess(
		env,
		user.id,
		hashPassword(parsed.newPassword),
		getSessionTokenFromRequestHeaders(request),
	);

	return NextResponse.json({ ok: true });
}
