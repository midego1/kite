// The parts of the README animation that are drawn over the app: a pointer (headless Chromium has none) and the
// caption pill. Both are injected as init scripts, so they come back on every page load, and live outside the
// React tree at the end of <html>. The caption is remembered for the tab, so it survives the update reload.

const KITE_ICON = `<svg viewBox="0 0 96 96" width="22" height="22" fill="none" aria-hidden="true"><defs><linearGradient id="hero-kite" x1="14" y1="8" x2="80" y2="88" gradientUnits="userSpaceOnUse"><stop stop-color="#7fa2ff"/><stop offset="1" stop-color="#9b7bf7"/></linearGradient></defs><path d="M62 5 L85 50 L28 91 L11 25 Z" fill="url(#hero-kite)" stroke="url(#hero-kite)" stroke-width="3" stroke-linejoin="round"/><path d="M11 25 L85 50 M62 5 L28 91" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/></svg>`;

const POINTER_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M4.5 2.8 L4.5 19.6 L9 15.4 L12.1 21.7 L15 20.3 L11.9 14.1 L18 14.1 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export const OVERLAY_SCRIPT = `(() => {
	const CSS = \`
		#hero-pointer { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transform: translate(-60px, -60px); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
		#hero-pointer::after { content: ""; position: absolute; left: -11px; top: -11px; width: 30px; height: 30px; border-radius: 50%; background: rgba(124,140,255,.45); transform: scale(0); opacity: 0; transition: transform .25s ease-out, opacity .35s ease-out; }
		#hero-pointer.down::after { transform: scale(1); opacity: 1; transition: none; }
		#hero-caption { position: fixed; left: 50%; bottom: 30px; z-index: 2147483646; pointer-events: none; display: flex; align-items: center; gap: 10px;
			padding: 11px 22px 11px 16px; border-radius: 999px; background: rgba(18,18,24,.84); color: #fff; box-shadow: 0 10px 34px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.08) inset;
			-webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); font: 600 19px/1.2 var(--hero-font, system-ui), system-ui, sans-serif; letter-spacing: -.01em; white-space: nowrap;
			opacity: 0; transform: translate(-50%, 14px) scale(.98); transition: opacity .38s ease, transform .45s cubic-bezier(.2,.8,.2,1); }
		#hero-caption.shown { opacity: 1; transform: translate(-50%, 0) scale(1); }
		#hero-caption.instant { transition: none; }
	\`;
	let pointer, caption;
	const install = () => {
		if (document.getElementById("hero-pointer")) return;
		const style = document.createElement("style");
		style.textContent = CSS;
		pointer = document.createElement("div");
		pointer.id = "hero-pointer";
		pointer.innerHTML = ${JSON.stringify(POINTER_ICON)};
		caption = document.createElement("div");
		caption.id = "hero-caption";
		document.documentElement.append(style, pointer, caption);
		const last = sessionStorage.getItem("hero-pointer");
		if (last) pointer.style.transform = "translate(" + last + ")";
		const text = sessionStorage.getItem("hero-caption");
		if (text) show(text, true);
	};
	const show = (text, instant) => {
		caption.innerHTML = ${JSON.stringify(KITE_ICON)} + "<span></span>";
		caption.lastChild.textContent = text;
		const font = document.body && getComputedStyle(document.body).fontFamily;
		if (font) caption.style.setProperty("--hero-font", font);
		caption.classList.toggle("instant", !!instant);
		caption.classList.add("shown");
	};
	window.__heroCaption = (text) => {
		install();
		if (!text) {
			sessionStorage.removeItem("hero-caption");
			caption.classList.remove("shown", "instant");
			return;
		}
		sessionStorage.setItem("hero-caption", text);
		if (caption.classList.contains("shown")) {
			caption.classList.remove("shown", "instant");
			setTimeout(() => show(text), 260);
		} else show(text);
	};
	addEventListener("mousemove", (event) => {
		install();
		const at = event.clientX + "px, " + event.clientY + "px";
		pointer.style.transform = "translate(" + at + ")";
		sessionStorage.setItem("hero-pointer", at);
	}, true);
	addEventListener("mousedown", () => pointer && pointer.classList.add("down"), true);
	addEventListener("mouseup", () => pointer && pointer.classList.remove("down"), true);
	if (document.documentElement) install();
	else addEventListener("DOMContentLoaded", install);
})();`;
