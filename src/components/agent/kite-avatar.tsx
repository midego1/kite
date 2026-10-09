export function KiteAvatar({ className = "" }: { className?: string }) {
	return (
		<span
			className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-50 ${className}`}
			aria-hidden="true"
		>
			<svg viewBox="0 0 24 24" className="h-6 w-6">
				<path d="M13 2 21 9 11 22 4 15Z" className="fill-blue-400" />
				<path d="m13 2-2 20-7-7Z" className="fill-blue-600" />
				<path d="m13 2 8 7-10 13Z" className="fill-blue-300" />
				<path d="m13 2-2 20M4 15l17-6" fill="none" className="stroke-white" strokeWidth="1" />
			</svg>
		</span>
	);
}
