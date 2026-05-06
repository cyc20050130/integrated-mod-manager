import DOMPurify from "dompurify";

const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[/?#])/i;
const SAFE_HTML_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const isSafeExternalUrl = (url: string): boolean => {
	try {
		const parsedUrl = new URL(url.trim());
		return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
	} catch {
		return false;
	}
};

const addNoopenerToBlankTargets = (html: string): string => {
	return html.replace(/<a\b([^>]*\starget\s*=\s*(["'])_blank\2[^>]*)>/gi, (match, attributes: string) => {
		if (/\srel\s*=/i.test(attributes)) {
			return match
				.replace(/\srel\s*=\s*"([^"]*)"/i, (_relMatch, relValue: string) => {
					const tokens = new Set(relValue.split(/\s+/).filter(Boolean));
					tokens.add("noopener");
					tokens.add("noreferrer");
					return ` rel="${Array.from(tokens).join(" ")}"`;
				})
				.replace(/\srel\s*=\s*'([^']*)'/i, (_relMatch, relValue: string) => {
					const tokens = new Set(relValue.split(/\s+/).filter(Boolean));
					tokens.add("noopener");
					tokens.add("noreferrer");
					return ` rel="${Array.from(tokens).join(" ")}"`;
				});
		}
		return match.replace(/>$/, ' rel="noopener noreferrer">');
	});
};

const removeUnsafeAttributes = (html: string): string => {
	return addNoopenerToBlankTargets(html)
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
		.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s+(href|src)\s*=\s*(["'])\s*(?:javascript|file|data|vbscript):[\s\S]*?\2/gi, "")
		.replace(/\s+(href|src)\s*=\s*(?:javascript|file|data|vbscript):[^\s>]+/gi, "");
};

const hardenAnchorElements = (html: string): string => {
	const template = window.document.createElement("template");
	template.innerHTML = html;

	template.content.querySelectorAll("a").forEach((anchor) => {
		const href = anchor.getAttribute("href");
		if (href) {
			try {
				const url = new URL(href, window.location.origin);
				if (!SAFE_HTML_URL_PROTOCOLS.has(url.protocol)) {
					anchor.removeAttribute("href");
				}
			} catch {
				anchor.removeAttribute("href");
			}
		}

		if (anchor.getAttribute("target") === "_blank") {
			const relTokens = new Set((anchor.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
			relTokens.add("noopener");
			relTokens.add("noreferrer");
			anchor.setAttribute("rel", Array.from(relTokens).join(" "));
		}
	});

	return template.innerHTML;
};

export const sanitizeHtml = (html: string): string => {
	if (!html) {
		return "";
	}

	if (typeof window === "undefined" || typeof window.document === "undefined") {
		return removeUnsafeAttributes(html);
	}

	const sanitized = DOMPurify.sanitize(html, {
		ALLOWED_URI_REGEXP,
		ADD_ATTR: ["target", "rel"],
	});
	return hardenAnchorElements(sanitized);
};
