import { convertFileSrc, invoke } from "@tauri-apps/api/core";

type FileSrcConverter = (path: string) => string;

type ResolvedPreviewAsset = {
	key: string;
	path: string;
};

const resolvedPreviewPaths = new Map<string, string>();

function normalizePreviewKey(path: string) {
	return String(path || "")
		.replaceAll("/", "\\")
		.replace(/^\\+|\\+$/g, "");
}

export function resolvePreviewAssetUrl(path: string, converter: FileSrcConverter = convertFileSrc) {
	return path ? converter(path) : "";
}

export function getImageUrl(path: string) {
	return resolvePreviewAssetUrl(resolvedPreviewPaths.get(normalizePreviewKey(path)) || "");
}

async function resolvePreviewAssets(sourceRoot: string, paths: string[]) {
	const uniquePaths = Array.from(new Set(paths.map(normalizePreviewKey).filter(Boolean)));
	if (!sourceRoot || uniquePaths.length === 0) return [];

	return invoke<ResolvedPreviewAsset[]>("resolve_preview_assets", {
		sourceRoot,
		requests: uniquePaths.map((path) => ({ key: path, relativePath: path })),
	});
}

export async function refreshPreviewAssets(sourceRoot: string, paths: string[]) {
	const assets = await resolvePreviewAssets(sourceRoot, paths);
	resolvedPreviewPaths.clear();
	for (const asset of assets) resolvedPreviewPaths.set(normalizePreviewKey(asset.key), asset.path);
}

export async function updatePreviewAsset(sourceRoot: string, path: string) {
	const key = normalizePreviewKey(path);
	if (!key) return;
	const [asset] = await resolvePreviewAssets(sourceRoot, [key]);
	if (asset) resolvedPreviewPaths.set(key, asset.path);
	else resolvedPreviewPaths.delete(key);
}
