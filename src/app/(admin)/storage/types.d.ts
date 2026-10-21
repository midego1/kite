import type { StoreView } from "@/lib/storage/stores";
import type { RoutableClass, S3Addressing, S3Provider } from "@/lib/storage/types";
import type { ValidationReport, ValidationStep } from "@/lib/storage/validate-utils";

export type { StoreView, ValidationReport, ValidationStep };

export type MigrationView = {
	id: string;
	objectClass: RoutableClass;
	fromStoreId: string;
	toStoreId: string;
	status: "queued" | "copying" | "verifying" | "completed" | "failed" | "cancelled";
	phase: "copy" | "verify" | "done" | "purge" | "purged";
	objectsTotal: number | null;
	objectsDone: number;
	bytesDone: number;
	errors: number;
	lastError: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
};

export type RouteView = { objectClass: RoutableClass; storeId: string; previousStoreId: string | null };

export type StorageOverview = {
	defaultStore: { id: string; name: string; kind: "r2" | "files"; directUploads: boolean };
	stores: StoreView[];
	routes: RouteView[];
	migrations: MigrationView[];
	usage: Record<RoutableClass, { objects: number; bytes: number }>;
	encryptionReady: boolean;
	migrationPending: boolean;
	endpointPolicy: { allowInsecure: boolean; allowPrivate: boolean };
	runtime: "node" | "workers";
};

export type StoreForm = {
	name: string;
	provider: S3Provider;
	endpoint: string;
	region: string;
	bucket: string;
	addressing: S3Addressing;
	accessKeyId: string;
	secretAccessKey: string;
	/** The R2 S3 API keys of the default bucket, which only turn on direct uploads. */
	sameAsBinding: boolean;
};

/** What a failed save, test or switch answers besides its message. */
export type StorageFailure = { report?: ValidationReport; steps?: ValidationStep[] };
