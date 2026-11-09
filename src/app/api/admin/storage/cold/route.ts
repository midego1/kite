import { authorizeStorage, storageJson } from "@/lib/storage/admin-api";
import { coldIaAvailable, coldRulesView, listColdJobs } from "@/lib/storage/cold";

/** One rule per class (defaulted for a class with none yet), the latest sweep per class, and target availability. */
export async function GET(request: Request) {
	const access = await authorizeStorage(request, false);
	if (access.error) return access.error;
	const [rules, jobs, iaAvailable] = await Promise.all([
		coldRulesView(access.env),
		listColdJobs(access.env),
		coldIaAvailable(access.env),
	]);
	return storageJson({ rules, jobs, iaAvailable });
}
