import { authFetch } from "@/lib/auth/client";
import { formatDriveSize } from "@/lib/drive/name-utils";
import { presetFor } from "@/lib/storage/s3-presets-utils";
import type { RoutableClass } from "@/lib/storage/types";
import type { MigrationView, StorageFailure, StorageOverview, StoreView } from "./types";

export const STORAGE_QUERY_KEY = ["admin-storage"];

export const CLASS_LABELS: Record<RoutableClass, string> = { mail: "Mail", drive: "Drive", backups: "Backups" };

export const CLASS_CONTENTS: Record<RoutableClass, string> = {
	mail: "Raw messages and attachments",
	drive: "Drive files",
	backups: "Database backups",
};

/** An answer that failed, with the step report the checks produced when there is one. */
export class StorageRequestError extends Error {
	constructor(
		message: string,
		readonly details: StorageFailure,
	) {
		super(message);
	}
}

export async function storageRequest<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
	const { json, ...rest } = init ?? {};
	const response = await authFetch(`/api/admin/storage${path}`, {
		...rest,
		...(json === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
	});
	const data = (await response.json().catch(() => ({}))) as T & StorageFailure & { error?: string };
	if (!response.ok)
		throw new StorageRequestError(data.error ?? `Request failed (${response.status})`, {
			report: data.report,
			steps: data.steps,
			field: data.field,
		});
	return data;
}

export const fetchStorageOverview = () => storageRequest<StorageOverview>("");

export function errorText(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function storeName(overview: StorageOverview, id: string): string {
	if (id === overview.defaultStore.id) return overview.defaultStore.name;
	return overview.stores.find((store) => store.id === id)?.name ?? "A removed store";
}

/** Stores a class may switch to: the default and every store that is neither blocked nor the default's keys. */
export function routableStores(overview: StorageOverview): { id: string; name: string }[] {
	return [
		{ id: overview.defaultStore.id, name: overview.defaultStore.name },
		...overview.stores.filter((store) => !store.sameAsBinding && !store.blocked),
	];
}

export function providerLabel(provider: string): string {
	return presetFor(provider)?.label ?? provider;
}

export function formatUsage(usage: { objects: number; bytes: number }, objectClass: RoutableClass): string {
	const objects = `${usage.objects.toLocaleString()} ${usage.objects === 1 ? "object" : "objects"}`;
	// Raw messages have no recorded size, so mail bytes would undercount.
	return objectClass === "mail" ? objects : `${objects}, ${formatDriveSize(usage.bytes)}`;
}

export function formatCheckedAt(value: string | null): string {
	if (!value) return "Never checked";
	return `Checked ${new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function statusBadge(store: Pick<StoreView, "status" | "blocked">): { label: string; className: string } {
	if (store.blocked) return { label: "Blocked", className: "bg-red-50 text-red-700" };
	if (store.status === "ok") return { label: "Working", className: "bg-green-600/10 text-green-800" };
	if (store.status === "error") return { label: "Failing", className: "bg-red-50 text-red-700" };
	return { label: "Not checked", className: "bg-neutral-100 text-neutral-700" };
}

const MIGRATION_LABELS: Record<MigrationView["status"], string> = {
	queued: "Waiting to start",
	copying: "Copying",
	verifying: "Checking the copies",
	completed: "Copied",
	failed: "Stopped after repeated errors",
	cancelled: "Cancelled",
};

export function migrationLabel(migration: MigrationView): string {
	if (migration.status === "completed" && migration.phase === "purge") return "Deleting the old copies";
	if (migration.status === "completed" && migration.phase === "purged") return "Old copies deleted";
	return MIGRATION_LABELS[migration.status] ?? migration.status;
}

export function isRunning(migration: Pick<MigrationView, "status" | "phase">): boolean {
	return (
		migration.status === "queued" ||
		migration.status === "copying" ||
		migration.status === "verifying" ||
		(migration.status === "completed" && migration.phase === "purge")
	);
}

/** Finish and delete apply while the class still reads from the migration's old store. */
export function awaitsFinish(overview: StorageOverview, migration: MigrationView): boolean {
	const route = overview.routes.find((entry) => entry.objectClass === migration.objectClass);
	return (
		migration.status === "completed" &&
		migration.phase === "done" &&
		route?.storeId === migration.toStoreId &&
		route.previousStoreId === migration.fromStoreId
	);
}

export function migrationProgress(migration: MigrationView): string {
	const total = migration.objectsTotal;
	const done = migration.objectsDone.toLocaleString();
	const objects = total ? `${done} of ${total.toLocaleString()} objects` : `${done} objects`;
	const errors = migration.errors ? `, ${migration.errors.toLocaleString()} errors` : "";
	return `${objects}, ${formatDriveSize(migration.bytesDone)}${errors}`;
}
