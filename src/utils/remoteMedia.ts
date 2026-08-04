import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface GameBananaModPreviewAsset {
	path: string;
	contentHash: string;
	cacheGeneration: number;
}

export function isRemoteMediaSource(source: string): boolean {
	try {
		return new URL(source).protocol === "https:";
	} catch {
		return false;
	}
}

export function resolveRemoteMediaAssetUrl(path: string, converter: (path: string) => string = convertFileSrc): string {
	return converter(path);
}

export async function resolveRemoteMediaUrl(source: string): Promise<string> {
	if (!isRemoteMediaSource(source)) return source;
	const path = await invoke<string>("resolve_remote_media", { url: source });
	return resolveRemoteMediaAssetUrl(path);
}

export async function resolveGameBananaModPreview(
	source: string,
	signal?: AbortSignal
): Promise<GameBananaModPreviewAsset & { assetUrl: string }> {
	if (!isRemoteMediaSource(source)) throw new Error("invalid_mod_preview_source");
	if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
	const result = await invoke<GameBananaModPreviewAsset>("resolve_gamebanana_mod_preview", { url: source });
	if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
	return {
		...result,
		assetUrl: `${resolveRemoteMediaAssetUrl(result.path)}?v=${encodeURIComponent(String(result.cacheGeneration))}`,
	};
}

export async function invalidateGameBananaModPreview(source: string): Promise<void> {
	if (!isRemoteMediaSource(source)) return;
	await invoke("invalidate_gamebanana_mod_preview", { url: source });
}
