export type SetupRequirementCheck = {
	key: string;
	configured: boolean;
	message: string;
	/** "recommended" checks warn but never stop setup; anything else must be configured to continue. */
	severity?: "required" | "recommended";
};

export type CloudflareTokenOutcome =
	| { kind: "ok" }
	| { kind: "no_zones" }
	| { kind: "rejected"; detail: string }
	| { kind: "unreachable"; detail: string };

export type SetupPreparationResult = {
	checks: SetupRequirementCheck[];
	migrated: boolean;
};
