import { LoaderCircle } from "lucide-react";
import type { DomainDnsDetailsProps } from "./types";

type Status = NonNullable<DomainDnsDetailsProps["setupStatus"]>;

export default function DnsSetupFeedback({ status }: { status?: Status | null }) {
	if (!status) return null;

	const isError = status.state === "error";
	const isSuccess = status.state === "success";

	return (
		<p
			role={isError ? "alert" : "status"}
			aria-live={isError ? "assertive" : "polite"}
			className={`mt-3 flex items-center gap-2 text-sm ${
				isError ? "text-red-600" : isSuccess ? "text-green-700" : "text-blue-700"
			}`}
		>
			{status.state === "pending" && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
			{status.message}
		</p>
	);
}
