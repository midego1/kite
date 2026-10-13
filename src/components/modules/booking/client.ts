import { authFetch } from "@/lib/auth/client";
import type { ModuleClient } from "../client-registry-types";

async function copyLink() {
	const response = await authFetch("/api/booking");
	if (!response.ok) throw new Error("Could not load your booking link.");
	const { username } = (await response.json()) as { username: string | null };
	if (!username) throw new Error("Booking username is unavailable.");
	await navigator.clipboard.writeText(`${window.location.origin}/c/${username}`);
}

export const commandHandlers: NonNullable<ModuleClient["commandHandlers"]> = { copyLink };
