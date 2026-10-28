import { useEffect, useState } from "react";

/** A `blob:` URL for a local file while it is given, revoked when it changes or the component unmounts; "" until ready. */
export function useObjectUrl(file: File | null): string {
	const [url, setUrl] = useState("");
	useEffect(() => {
		if (!file) return;
		const next = URL.createObjectURL(file);
		// The URL only exists once the effect has made it, so it cannot be derived during render.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl("");
		};
	}, [file]);
	return url;
}
