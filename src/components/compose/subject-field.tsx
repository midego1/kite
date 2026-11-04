import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The subject line. `dir="auto"` lets an Arabic or Hebrew subject read and align from the right as it is typed. */
export function SubjectField({
	id,
	value,
	onChange,
	disabled,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
}) {
	return (
		<>
			<Label htmlFor={id} className="sr-only">
				Subject
			</Label>
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				dir="auto"
				placeholder="Subject"
				required
				disabled={disabled}
				className="reading-font h-8 border-0 px-0 py-1 shadow-none focus-visible:ring-0"
			/>
		</>
	);
}
