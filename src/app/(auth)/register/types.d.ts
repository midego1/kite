import type { SetupTelemetryStatus } from "@/lib/telemetry/types";

export type SetupStatus = {
	hasAdminAccount: boolean;
	hasPrimaryDomain: boolean;
	setupTokenRequired?: boolean;
	primaryDomain?: { hostname: string; sendingRequested: boolean } | null;
	/** Only until the first account exists. */
	telemetry?: SetupTelemetryStatus;
	error?: string;
};

export type SetupRequirementCheck = {
	key: string;
	configured: boolean;
	message: string;
	severity?: "required" | "recommended";
};

export type SetupPreparationResult = {
	checks?: SetupRequirementCheck[];
	migrated?: boolean;
	error?: string;
	setupTokenRequired?: boolean;
};

export type DomainPreflight = {
	hostname: string;
	zone: { id: string; name: string };
};

export type DomainSetupResult = {
	domain?: DomainPreflight;
	error?: string;
};

export type MxCheckResult = {
	hasExistingMx?: boolean;
	error?: string;
};

export type MxCheckState = {
	skipDns: boolean;
	checking: boolean;
	recordsExist: boolean | null;
	replaceRecords: boolean;
};

export type RegisterMxStatusProps = Omit<MxCheckState, "skipDns"> & {
	onReplaceRecordsChange: (replace: boolean) => void;
	onRetry: () => void;
};

export type RegisterResult = {
	redirect?: string;
	error?: string;
	code?: "MX_RECORDS_CONFLICT";
};
