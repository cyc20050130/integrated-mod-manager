import type { DownloadItem, GameBananaBinding, GameBananaSelectedFile, ModData, ModDataObj } from "./types";

export interface GameBananaFileCandidate {
	id?: number | string;
	name: string;
	size?: number;
	updatedAt?: number;
}

export interface LocalBindingCandidate {
	path: string;
	name: string;
}

export interface RankedLocalBindingCandidate<T extends LocalBindingCandidate = LocalBindingCandidate> {
	mod: T;
	localSize?: number;
	closestFile?: GameBananaSelectedFile;
	difference?: number;
	relativeDifference?: number;
}

export function parseGameBananaModId(value?: string): number | null {
	const match = String(value || "").match(/(?:^|[/?#])mods?\/(\d+)(?:$|[/?#])/i);
	if (!match) return null;
	const modId = Number(match[1]);
	return Number.isSafeInteger(modId) && modId > 0 ? modId : null;
}

export function boundGameBananaModId(data?: Pick<ModData, "gameBanana" | "source">): number | null {
	const bindingId = data?.gameBanana?.modId;
	if (Number.isSafeInteger(bindingId) && Number(bindingId) > 0) return Number(bindingId);
	return parseGameBananaModId(data?.source);
}

export function validateGameBananaDownloadIdentity(
	item: Pick<DownloadItem, "source" | "gameBananaModId" | "gameBananaFileId" | "expectedSize" | "expectedHash">
): string | null {
	const modId = item.gameBananaModId;
	if (!Number.isSafeInteger(modId) || Number(modId) <= 0) {
		return "The queued download has no valid GameBanana Mod ID. Remove it and add the file again.";
	}
	if (parseGameBananaModId(item.source) !== modId) {
		return "The queued download source does not match its GameBanana Mod ID.";
	}
	const fileId = String(item.gameBananaFileId || "").trim();
	if (!fileId || fileId.length > 2048) {
		return "The queued download has no valid GameBanana file ID. Remove it and add the file again.";
	}
	if (!/^[A-Za-z0-9_-]+$/.test(fileId)) {
		return "The queued download has an invalid GameBanana file ID. Remove it and add the file again.";
	}
	if (!Number.isSafeInteger(item.expectedSize) || Number(item.expectedSize) <= 0) {
		return "The queued download has no valid file size. Remove it and add the file again.";
	}
	const hash = item.expectedHash;
	if (!hash || hash.algorithm.toLowerCase() !== "md5" || !/^[0-9a-f]{32}$/i.test(hash.value)) {
		return "The queued download has no valid MD5 checksum. Remove it and add the file again.";
	}
	return null;
}

function normalizedPath(path: string) {
	return path.replaceAll("/", "\\").toLocaleLowerCase();
}

export function findGameBananaBindingConflicts(
	data: ModDataObj,
	targetPath: string,
	modId: number,
	existingPaths?: ReadonlySet<string>
): string[] {
	if (!Number.isSafeInteger(modId) || modId <= 0) return [];
	const target = normalizedPath(targetPath);
	const knownPaths = existingPaths ? new Set(Array.from(existingPaths, normalizedPath)) : null;
	return Object.entries(data)
		.filter(([path, record]) => {
			const normalized = normalizedPath(path);
			return (
				normalized !== target && (!knownPaths || knownPaths.has(normalized)) && boundGameBananaModId(record) === modId
			);
		})
		.map(([path]) => path)
		.sort((left, right) => left.localeCompare(right));
}

export function createGameBananaBinding(input: {
	modId: number;
	profileUrl: string;
	independentVariant: boolean;
	boundAt?: number;
	selectedFile?: GameBananaSelectedFile;
}): GameBananaBinding {
	if (!Number.isSafeInteger(input.modId) || input.modId <= 0) {
		throw new Error("GameBanana Mod ID must be a positive integer.");
	}
	const profileUrl = input.profileUrl.trim();
	if (parseGameBananaModId(profileUrl) !== input.modId) {
		throw new Error("GameBanana profile URL does not match the selected Mod ID.");
	}
	return {
		provider: "gamebanana",
		modId: input.modId,
		profileUrl,
		variant: input.independentVariant ? "independent" : "primary",
		boundAt: input.boundAt ?? Date.now(),
		...(input.selectedFile ? { selectedFile: input.selectedFile } : {}),
	};
}

function normalizeRemoteFile(file: GameBananaFileCandidate): GameBananaSelectedFile | null {
	if (!Number.isFinite(file.size) || Number(file.size) <= 0) return null;
	return {
		id: String(file.id ?? ""),
		name: String(file.name || ""),
		size: Number(file.size),
		updatedAt: Number.isFinite(file.updatedAt) ? Number(file.updatedAt) : 0,
	};
}

export function rankLocalBindingCandidates<T extends LocalBindingCandidate>(
	mods: readonly T[],
	localSizes: Readonly<Record<string, number | undefined>>,
	remoteFiles: readonly GameBananaFileCandidate[]
): RankedLocalBindingCandidate<T>[] {
	const files = remoteFiles.map(normalizeRemoteFile).filter((file): file is GameBananaSelectedFile => file !== null);
	return mods
		.map((mod) => {
			const localSize = localSizes[mod.path];
			if (!Number.isFinite(localSize) || Number(localSize) < 0 || files.length === 0) return { mod };
			const size = Number(localSize);
			const closestFile = files.reduce((closest, candidate) => {
				const closestDelta = Math.abs(closest.size - size);
				const candidateDelta = Math.abs(candidate.size - size);
				if (candidateDelta !== closestDelta) return candidateDelta < closestDelta ? candidate : closest;
				if (candidate.updatedAt !== closest.updatedAt) {
					return candidate.updatedAt > closest.updatedAt ? candidate : closest;
				}
				return candidate.name.localeCompare(closest.name) < 0 ? candidate : closest;
			});
			const difference = Math.abs(closestFile.size - size);
			return {
				mod,
				localSize: size,
				closestFile,
				difference,
				relativeDifference: difference / Math.max(closestFile.size, 1),
			};
		})
		.sort((left, right) => {
			if (left.difference === undefined) return right.difference === undefined ? 0 : 1;
			if (right.difference === undefined) return -1;
			if (left.difference !== right.difference) return left.difference - right.difference;
			if (left.relativeDifference !== right.relativeDifference) {
				return Number(left.relativeDifference) - Number(right.relativeDifference);
			}
			return left.mod.path.localeCompare(right.mod.path);
		});
}
