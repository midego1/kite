import { useEffect, useRef, useState } from "react";

export function useMessageContentScroll(messageId: string, loading: boolean) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [scrolled, setScrolled] = useState(false);

	useEffect(() => {
		if (scrollRef.current) scrollRef.current.scrollTop = 0;
	}, [messageId]);

	// Declared after the reset above so it measures the new message's position.
	useEffect(() => {
		setScrolled((scrollRef.current?.scrollTop ?? 0) > 0);
	}, [messageId, loading]);

	function handleScroll() {
		setScrolled((scrollRef.current?.scrollTop ?? 0) > 0);
	}

	return { scrollRef, scrolled, handleScroll };
}
