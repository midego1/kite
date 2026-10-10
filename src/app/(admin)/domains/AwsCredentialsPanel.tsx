"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AwsCapabilityReport, AwsConfigStatus } from "@/lib/aws/aws-types";
import { ApiError, requestJson } from "./api";
import { missingPermissionsReport, refusedAwsSave } from "./aws-credentials-panel-utils";
import { StatusRow } from "./status-row";
import { requestConfirmation } from "@/components/ui/confirm-dialog-utils";

type Props = {
	/** Which capabilities the caller needs, so only those rows are shown. */
	need: "sending" | "receiving";
	onChanged?: (configured: boolean, report: AwsCapabilityReport | null) => void;
};

type PanelResponse = { status: AwsConfigStatus; policy: unknown };

const REGION_HINTS = [
	"us-east-1",
	"us-east-2",
	"us-west-2",
	"eu-west-1",
	"eu-west-2",
	"eu-central-1",
	"ap-southeast-2",
	"ap-northeast-1",
	"ca-central-1",
];

/**
 * AWS credentials shared by SES sending and receiving. Saving validates them
 * with AWS (identity, then a harmless call per service) and lists any permission
 * the key lacks, along with the IAM policy that grants everything.
 */
export default function AwsCredentialsPanel({ need, onChanged }: Props) {
	const [status, setStatus] = useState<AwsConfigStatus | null>(null);
	const [policy, setPolicy] = useState<unknown>(null);
	const [report, setReport] = useState<AwsCapabilityReport | null>(null);
	const [editing, setEditing] = useState(false);
	const [accessKeyId, setAccessKeyId] = useState("");
	const [secretAccessKey, setSecretAccessKey] = useState("");
	const [region, setRegion] = useState("us-east-1");
	const [busy, setBusy] = useState<"save" | "check" | "remove" | null>(null);
	const [error, setError] = useState("");
	/** The report of credentials a save refused, kept so the IAM policy can be shown under the error. */
	const [refused, setRefused] = useState<AwsCapabilityReport | null>(null);

	useEffect(() => {
		let active = true;
		requestJson<PanelResponse>("/api/admin/aws", "GET")
			.then(async (data) => {
				if (!active) return;
				setStatus(data.status);
				setPolicy(data.policy);
				if (data.status.region) setRegion(data.status.region);
				if (!data.status.configured) {
					onChanged?.(false, null);
					return;
				}
				const checked = await requestJson<{ report: AwsCapabilityReport }>("/api/admin/aws", "POST", {});
				if (active) {
					setReport(checked.report);
					onChanged?.(true, checked.report);
				}
			})
			.catch((err) => {
				if (active) {
					setError(err instanceof Error ? err.message : "Could not load AWS settings");
					setStatus(
						(current) =>
							current ?? { configured: false, source: null, region: null, accessKeyHint: null, accountId: null },
					);
				}
			});
		return () => {
			active = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run(kind: "save" | "check" | "remove", action: () => Promise<void>) {
		setBusy(kind);
		setError("");
		setRefused(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Request failed");
		} finally {
			setBusy(null);
		}
	}

	const save = () =>
		run("save", async () => {
			const data = await requestJson<{ status: AwsConfigStatus; report: AwsCapabilityReport }>(
				"/api/admin/aws",
				"PUT",
				{ accessKeyId, secretAccessKey, region },
			).catch((err: unknown) => {
				const refusal = err instanceof ApiError ? refusedAwsSave(err.data) : null;
				if (refusal) {
					setRefused(refusal.report);
					if (refusal.policy) setPolicy(refusal.policy);
				}
				throw err;
			});
			setStatus(data.status);
			setReport(data.report);
			setEditing(false);
			setSecretAccessKey("");
			setAccessKeyId("");
			onChanged?.(true, data.report);
		});
	const check = () =>
		run("check", async () => {
			const data = await requestJson<{ report: AwsCapabilityReport }>("/api/admin/aws", "POST", {});
			setReport(data.report);
			onChanged?.(true, data.report);
		});
	const remove = () =>
		run("remove", async () => {
			if (
				!(await requestConfirmation({
					title: "Remove the AWS credentials?",
					description:
						"Domains using Amazon SES will stop sending and receiving. Resources already created in AWS are left in place.",
					confirmLabel: "Remove credentials",
				}))
			)
				return;
			const data = await requestJson<{ status: AwsConfigStatus }>("/api/admin/aws", "DELETE", {});
			setStatus(data.status);
			setReport(null);
			onChanged?.(false, null);
		});

	const configured = !!status?.configured;
	const showForm = status !== null && (!configured || editing);
	const fromEnvironment = status?.source === "environment";
	const missingReport = missingPermissionsReport({ refused, report, configured, editing });

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<StatusRow
					ok={configured && !editing}
					title="AWS credentials"
					hint="Shared by every domain using Amazon SES"
					action={
						configured && !editing ? (
							<>
								<Button
									size="sm"
									variant="outline"
									className="bg-white"
									disabled={busy !== null}
									onClick={() => void check()}
								>
									{busy === "check" ? "Checking…" : "Re-check"}
								</Button>
								{!fromEnvironment && (
									<Button
										size="sm"
										variant="outline"
										className="bg-white"
										disabled={busy !== null}
										onClick={() => {
											setEditing(true);
											setError("");
											setRefused(null);
										}}
									>
										Replace
									</Button>
								)}
								{!fromEnvironment && (
									<Button
										size="sm"
										variant="outline"
										className="bg-white"
										disabled={busy !== null}
										onClick={() => void remove()}
									>
										Remove
									</Button>
								)}
							</>
						) : undefined
					}
				>
					{showForm ? (
						<form
							className="grid gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<Input
								autoComplete="off"
								placeholder="Access key ID (AKIA…)"
								value={accessKeyId}
								onChange={(event) => setAccessKeyId(event.target.value)}
								className="max-w-sm bg-white"
							/>
							<Input
								type="password"
								autoComplete="off"
								placeholder="Secret access key"
								value={secretAccessKey}
								onChange={(event) => setSecretAccessKey(event.target.value)}
								className="max-w-sm bg-white"
							/>
							<Input
								list="aws-regions"
								placeholder="Region (us-east-1)"
								value={region}
								onChange={(event) => setRegion(event.target.value)}
								className="max-w-[12rem] bg-white"
							/>
							<datalist id="aws-regions">
								{REGION_HINTS.map((hint) => (
									<option key={hint} value={hint} />
								))}
							</datalist>
							<span className="flex gap-2">
								<Button
									type="submit"
									size="sm"
									disabled={!accessKeyId.trim() || !secretAccessKey.trim() || !region.trim() || busy !== null}
								>
									{busy === "save" ? "Validating…" : "Validate and save"}
								</Button>
								{editing && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										className="bg-white"
										onClick={() => {
											setEditing(false);
											setError("");
											setRefused(null);
										}}
									>
										Cancel
									</Button>
								)}
							</span>
						</form>
					) : configured ? (
						`Access key …${status?.accessKeyHint} · ${status?.region}${status?.accountId ? ` · account ${status.accountId}` : ""}${fromEnvironment ? " · from environment" : ""}`
					) : (
						"Checking…"
					)}
				</StatusRow>

				{configured && !editing && report && need === "sending" && (
					<StatusRow ok={report.sending} title="SES sending" hint="Send mail and manage sender identities">
						{report.sending ? `Allowed in ${report.region}` : "Missing SES permissions"}
					</StatusRow>
				)}
				{configured && !editing && report?.sending && report.productionAccess === false && need === "sending" && (
					<StatusRow ok={false} title="SES sandbox" hint="New AWS accounts start restricted">
						Only verified recipients can receive mail until you request production access in the SES console.
					</StatusRow>
				)}
				{configured && !editing && report && need === "receiving" && (
					<>
						<StatusRow
							ok={report.receivingRegion && report.receiving}
							title="SES receiving"
							hint="Receipt rules for inbound mail"
						>
							{!report.receivingRegion
								? `${report.region} cannot receive mail. Use us-east-1, us-west-2 or eu-west-1.`
								: report.receiving
									? `Allowed in ${report.region}`
									: "Missing SES receipt-rule permissions"}
						</StatusRow>
						<StatusRow ok={report.s3} title="S3" hint="Bucket where SES stores raw messages">
							{report.s3 ? "Allowed" : "Missing S3 permissions"}
						</StatusRow>
						<StatusRow ok={report.sns} title="SNS" hint="Notifies Kite of each message">
							{report.sns ? "Allowed" : "Missing SNS permissions"}
						</StatusRow>
					</>
				)}
			</ul>
			{error && (
				<p role="alert" className="text-xs text-red-600">
					{error}
				</p>
			)}
			{missingReport && (
				<details open={refused !== null} className="rounded-lg bg-white px-3 py-2 text-xs text-neutral-600">
					<summary className="cursor-pointer font-medium text-neutral-800">
						Missing permissions and the IAM policy that grants them
					</summary>
					<p className="mt-2">Missing: {missingReport.missing.join(", ")}</p>
					<pre className="mt-2 max-h-64 overflow-auto rounded bg-neutral-50 p-2">{JSON.stringify(policy, null, 2)}</pre>
				</details>
			)}
			{showForm && (
				<p className="text-xs text-neutral-500">
					Create an IAM user with programmatic access in the AWS console and attach a policy with the permissions Kite
					needs (shown after you save, if any are missing). Credentials are checked with AWS before they are stored.
				</p>
			)}
		</div>
	);
}
