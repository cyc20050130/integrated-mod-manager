import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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
