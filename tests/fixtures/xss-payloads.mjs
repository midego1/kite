/**
 * Known XSS payloads for the email HTML sanitizers: classic vectors, URL scheme
 * obfuscation, CSS script and the parser-differential (mXSS) cases DOMPurify's
 * own suite tracks. Every one must come out inert.
 */
export const XSS_PAYLOADS = [
	"<script>window.__pwned = 1</script>",
	"<SCRIPT SRC=https://evil.example/x.js></SCRIPT>",
	"<img src=x onerror=alert(1)>",
	'<img src="https://ok.example/a.png" onload="alert(1)">',
	'<img """><script>alert(1)</script>">',
	"<svg onload=alert(1)>",
	"<svg><script>alert(1)</script></svg>",
	'<svg><a xlink:href="javascript:alert(1)"><text x=0 y=20>x</text></a></svg>',
	"<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>",
	'<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>"></path></textarea></mtext></svg></mglyph></mi></math>',
	'<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
	"<xmp><img src=x onerror=alert(1)></xmp>",
	"<template><script>alert(1)</script><img src=x onerror=alert(1)></template>",
	"<<script>script>alert(1)<</script>/script>",
	"<scr<script>ipt>alert(1)</scr</script>ipt>",
	'<a href="javascript:alert(1)">click</a>',
	'<a href="JaVaScRiPt:alert(1)">click</a>',
	'<a href="  javascript:alert(1)">click</a>',
	'<a href="java\tscript:alert(1)">click</a>',
	'<a href="java&#x0A;script:alert(1)">click</a>',
	'<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">click</a>',
	'<a href="vbscript:msgbox(1)">click</a>',
	'<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
	'<a href="https://ok.example" onmouseover="alert(1)">hover</a>',
	'<iframe src="javascript:alert(1)"></iframe>',
	'<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
	'<object data="javascript:alert(1)"></object>',
	'<embed src="javascript:alert(1)">',
	'<form action="javascript:alert(1)"><input type="submit" value="Go"></form>',
	'<button formaction="javascript:alert(1)">Go</button>',
	'<isindex action="javascript:alert(1)" type="image">',
	'<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
	'<base href="javascript:alert(1)//">',
	'<link rel="stylesheet" href="https://evil.example/x.css">',
	"<style>@import 'https://evil.example/x.css'; body{background:url(javascript:alert(1))}</style>",
	'<div style="background:url(javascript:alert(1))">x</div>',
	'<div style="width: expression(alert(1))">x</div>',
	'<div style="-moz-binding: url(https://evil.example/x.xml#x)">x</div>',
	'<div style="behavior: url(x.htc)">x</div>',
	"<body onload=alert(1)>x</body>",
	"<details open ontoggle=alert(1)><summary>x</summary></details>",
	"<video><source onerror=alert(1)></video>",
	"<audio src=x onerror=alert(1)></audio>",
	'<table background="javascript:alert(1)"><tr><td>x</td></tr></table>',
	'<img src="https://ok.example/a.png" srcset="javascript:alert(1) 1x">',
	'<p onclick="alert(1)" id="x">paragraph</p>',
	"<!--<img src=x onerror=alert(1)>-->",
	'<a href="#" id="location" name="cookie">clobber</a>',
	'<frameset onload=alert(1)><frame src="javascript:alert(1)"></frameset>',
];

const EXECUTABLE_TAGS = new Set([
	"applet",
	"audio",
	"base",
	"button",
	"embed",
	"form",
	"frame",
	"frameset",
	"iframe",
	"input",
	"isindex",
	"link",
	"math",
	"meta",
	"noscript",
	"object",
	"script",
	"select",
	"source",
	"style",
	"svg",
	"template",
	"textarea",
	"video",
]);
const URL_ATTRIBUTES = new Set([
	"action",
	"background",
	"cite",
	"data",
	"formaction",
	"href",
	"poster",
	"src",
	"srcset",
]);
const FORBIDDEN_ATTRIBUTES = new Set(["srcdoc", "formaction", "action", "srcset", "xlink:href"]);
const UNSAFE_STYLE = /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|@import/i;

function normalizedUrl(value) {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
}

/**
 * Problems in sanitized HTML, judged by how a browser parses it (`parse` returns a
 * body element): executable elements, event handlers or script URLs.
 */
export function findActiveContent(html, parse) {
	const problems = [];
	const body = parse(html);
	for (const element of Array.from(body.querySelectorAll("*"))) {
		const tag = element.tagName.toLowerCase();
		if (EXECUTABLE_TAGS.has(tag)) problems.push(`<${tag}>`);
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith("on")) problems.push(`${tag}[${name}]`);
			if (FORBIDDEN_ATTRIBUTES.has(name)) problems.push(`${tag}[${name}]`);
			if (URL_ATTRIBUTES.has(name)) {
				const url = normalizedUrl(attribute.value);
				const imageData = tag === "img" && name === "src" && url.startsWith("data:image/");
				if (/^(?:javascript|vbscript):/.test(url) || (url.startsWith("data:") && !imageData)) {
					problems.push(`${tag}[${name}=${attribute.value}]`);
				}
			}
			if (name === "style" && UNSAFE_STYLE.test(attribute.value)) problems.push(`${tag}[style=${attribute.value}]`);
		}
	}
	return problems;
}
