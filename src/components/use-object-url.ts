import { useEffect, useState } from "react";

/**
 * A `blob:` URL for a copy of a local file while it is given, revoked when it changes or the component unmounts;
 * "" until the copy is ready. The bytes are read first and the URL is made from that copy, so nothing about the
 * picked File (name, type) reaches an attribute.
 */
export function useObjectUrl(file: File | null): string {
	const [url, setUrl] = useState("");
	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		let created = "";
		file
			.arrayBuffer()
			.then((bytes) => {
				if (cancelled) return;
				created = URL.createObjectURL(new Blob([bytes], { type: file.type }));
				setUrl(created);
			})
			// A file that cannot be read any more (moved or changed on disk) just has no preview.
			.catch(() => {});
		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
			setUrl("");
		};
	}, [file]);
	return url;
}
