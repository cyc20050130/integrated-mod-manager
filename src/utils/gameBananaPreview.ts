import type { OnlineMod, OnlineModImage, OnlineModPreviewMedia } from "./types";

const GAMEBANANA_IMAGE_HOSTS = new Set(["images.gamebanana.com"]);
const GAMEBANANA_IMAGE_PATHS = ["/img/", "/static/"] as const;
const FILE_FIELDS = ["_sFile", "_sFile530", "_sFile220", "_sFile100"] as const;

type PreviewImageRecord = Partial<OnlineModImage> & Record<string, unknown>;

export type GameBananaPreviewResolution =
	{ kind: "missing" } | { kind: "ready"; url: string } | { kind: "error"; reason: string };

function isAllowedImageUrl(value: URL): boolean {
	return (
		value.protocol === "https:" &&
		GAMEBANANA_IMAGE_HOSTS.has(value.hostname) &&
		GAMEBANANA_IMAGE_PATHS.some((prefix) => value.pathname.startsWith(prefix))
	);
}

function normalizeCandidate(baseUrl: unknown, file: unknown): string | null {
	if (typeof baseUrl !== "string" || typeof file !== "string") return null;
	const base = baseUrl.trim();
	const candidate = file.trim();
	if (
		!base ||
		!candidate ||
		[...candidate].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	)
		return null;
	if (/^[a-z][a-z\d+.-]*:/i.test(candidate) || candidate.startsWith("//") || candidate.includes("\\")) return null;
	try {
		const url = new URL(candidate, base.endsWith("/") ? base : `${base}/`);
		return isAllowedImageUrl(url) ? url.toString() : null;
	} catch {
		return null;
	}
}

function normalizeFullUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const url = new URL(value.trim());
		return isAllowedImageUrl(url) ? url.toString() : null;
	} catch {
		return null;
	}
}

export function normalizeGameBananaImage(image: unknown): GameBananaPreviewResolution {
	if (!image || typeof image !== "object") return { kind: "error", reason: "image_record_invalid" };
	const record = image as PreviewImageRecord;
	const fieldsPresent = FILE_FIELDS.some((field) => Object.hasOwn(record, field));
	for (const field of FILE_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || !value.trim()) continue;
		const url = normalizeCandidate(record._sBaseUrl, value);
		if (url) return { kind: "ready", url };
	}
	return fieldsPresent
		? { kind: "error", reason: "image_url_invalid" }
		: { kind: "error", reason: "image_file_missing" };
}

export function normalizeGameBananaPreviewMedia(media: unknown): GameBananaPreviewResolution {
	if (!media || typeof media !== "object") return { kind: "missing" };
	const images = (media as Partial<OnlineModPreviewMedia>)._aImages;
	if (!Array.isArray(images) || images.length === 0) return { kind: "missing" };
	let sawInvalid = false;
	for (const image of images) {
		const result = normalizeGameBananaImage(image);
		if (result.kind === "ready") return result;
		if (result.kind === "error") sawInvalid = true;
	}
	return sawInvalid ? { kind: "error", reason: "preview_images_invalid" } : { kind: "missing" };
}

export function normalizeGameBananaTopSubImage(value: unknown): GameBananaPreviewResolution {
	if (value == null || value === "") return { kind: "missing" };
	const url = normalizeFullUrl(value);
	return url ? { kind: "ready", url } : { kind: "error", reason: "top_sub_image_invalid" };
}

export function getGameBananaModPreviewSource(
	item: Pick<OnlineMod, "_sModelName" | "_aPreviewMedia" | "_sImageUrl">
): GameBananaPreviewResolution {
	if (item._sModelName !== "Mod") return { kind: "missing" };
	if (typeof item._sImageUrl === "string" && item._sImageUrl.trim())
		return normalizeGameBananaTopSubImage(item._sImageUrl);
	return normalizeGameBananaPreviewMedia(item._aPreviewMedia);
}
