import { sanitizeHtml } from "../utils/sanitizeHtml";

type SafeHtmlProps = {
	html: string;
	className?: string;
};

export function SafeHtml({ html, className }: SafeHtmlProps) {
	return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}
