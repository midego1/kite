/** Every folder list has a heading; it is an h2 while an open message supplies the page's h1. */
export function FolderHeading({ title, nested }: { title: string; nested: boolean }) {
	const Heading = nested ? "h2" : "h1";
	return <Heading className="sr-only">{title}</Heading>;
}
