import Link from "next/link";

export default function NotFound() {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 text-neutral-900">
			<div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
				<p className="text-sm font-semibold text-blue-600">404</p>
				<h1 className="mt-2 text-2xl font-semibold">Page not found</h1>
				<p className="mt-2 text-sm text-neutral-600">This page does not exist, or it is not available to you.</p>
				<Link
					href="/inbox"
					className="mt-6 inline-flex h-10 items-center justify-center rounded-full bg-blue-600 px-5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
				>
					Go to inbox
				</Link>
			</div>
		</main>
	);
}
