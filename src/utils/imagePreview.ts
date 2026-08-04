import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useSyncExternalStore } from "react";

type FileSrcConverter = (path: string) => string;

export type ResolvedPreviewAsset = {
	key: string;
	path: string;
};

type PreviewAssetResolver = (game: string, paths: string[]) => Promise<ResolvedPreviewAsset[]>;

type PreviewCache = {
	game: string;
	generation: number;
	paths: Map<string, string>;
	revisions: Map<string, number>;
	resolved: Set<string>;
	pending: Set<string>;
	listeners: Map<string, Set<() => void>>;
};

type PreviewBatchJob = {
	rootKey: string;
	game: string;
	generation: number;
	paths: string[];
};

const MAX_VISIBLE_BATCH_SIZE = 16;
const MAX_ACTIVE_BATCHES = 2;

export function normalizePreviewKey(path: string) {
	return String(path || "")
		.replaceAll("/", "\\")
		.replace(/^\\+|\\+$/g, "");
}

export function normalizePreviewRoot(path: string) {
	return String(path || "")
		.replaceAll("/", "\\")
		.replace(/\\+$/g, "");
}

function previewRootKey(path: string) {
	return normalizePreviewRoot(path).toLocaleLowerCase();
}

export function resolvePreviewAssetUrl(path: string, converter: FileSrcConverter = convertFileSrc) {
	return path ? converter(path) : "";
}

export function createPreviewAssetManager(
	resolver: PreviewAssetResolver,
	converter: FileSrcConverter = convertFileSrc
) {
	const caches = new Map<string, PreviewCache>();
	const queue: PreviewBatchJob[] = [];
	const idleListeners = new Set<() => void>();
	let activeRootKey = "";
	let activeJobs = 0;

	function getCache(game: string) {
		const normalizedGame = String(game || "")
			.trim()
			.toUpperCase();
		const rootKey = previewRootKey(normalizedGame);
		let cache = caches.get(rootKey);
		if (!cache) {
			cache = {
				game: normalizedGame,
				generation: 0,
				paths: new Map(),
				revisions: new Map(),
				resolved: new Set(),
				pending: new Set(),
				listeners: new Map(),
			};
			caches.set(rootKey, cache);
		}
		return { cache, rootKey };
	}

	function notify(cache: PreviewCache, key: string) {
		cache.listeners.get(key)?.forEach((listener) => listener());
	}

	function notifyIdle() {
		if (activeJobs !== 0 || queue.length !== 0) return;
		idleListeners.forEach((listener) => listener());
		idleListeners.clear();
	}

	function commitBatch(
		cache: PreviewCache,
		generation: number,
		requestedPaths: string[],
		assets: ResolvedPreviewAsset[]
	) {
		if (cache.generation !== generation || previewRootKey(cache.game) !== activeRootKey) return;
		const assetsByKey = new Map(assets.map((asset) => [normalizePreviewKey(asset.key), asset.path]));

		for (const key of requestedPaths) {
			cache.pending.delete(key);
			cache.resolved.add(key);
			const previousPath = cache.paths.get(key) || "";
			const nextPath = assetsByKey.get(key) || "";
			if (nextPath) cache.paths.set(key, nextPath);
			else cache.paths.delete(key);
			cache.revisions.set(key, (cache.revisions.get(key) || 0) + 1);
			if (previousPath !== nextPath || nextPath) notify(cache, key);
		}
	}

	function drainQueue() {
		while (activeJobs < MAX_ACTIVE_BATCHES && queue.length > 0) {
			const job = queue.shift();
			if (!job) break;
			const cache = caches.get(job.rootKey);
			if (!cache || cache.generation !== job.generation || job.rootKey !== activeRootKey) {
				continue;
			}

			activeJobs += 1;
			void resolver(job.game, job.paths)
				.then((assets) => commitBatch(cache, job.generation, job.paths, assets))
				.catch(() => {
					if (cache.generation !== job.generation) return;
					job.paths.forEach((key) => cache.pending.delete(key));
				})
				.finally(() => {
					activeJobs -= 1;
					drainQueue();
					notifyIdle();
				});
		}
		notifyIdle();
	}

	function beginGeneration(game: string) {
		const { cache, rootKey } = getCache(game);
		activeRootKey = rootKey;
		cache.generation += 1;
		cache.game = String(game || "")
			.trim()
			.toUpperCase();
		cache.pending.clear();
		cache.resolved.clear();
		const previousKeys = [...cache.paths.keys()];
		cache.paths.clear();
		previousKeys.forEach((key) => notify(cache, key));
		drainQueue();
		return cache.generation;
	}

	function requestVisible(game: string, paths: string[]) {
		const { cache, rootKey } = getCache(game);
		if (!rootKey || rootKey !== activeRootKey) return;
		const unresolvedPaths = Array.from(new Set(paths.map(normalizePreviewKey).filter(Boolean))).filter(
			(path) => !cache.resolved.has(path) && !cache.pending.has(path)
		);
		if (unresolvedPaths.length === 0) return;

		unresolvedPaths.forEach((path) => cache.pending.add(path));
		for (let index = 0; index < unresolvedPaths.length; index += MAX_VISIBLE_BATCH_SIZE) {
			queue.push({
				rootKey,
				game: cache.game,
				generation: cache.generation,
				paths: unresolvedPaths.slice(index, index + MAX_VISIBLE_BATCH_SIZE),
			});
		}
		drainQueue();
	}

	async function update(game: string, path: string) {
		const key = normalizePreviewKey(path);
		if (!key) return;
		const { cache, rootKey } = getCache(game);
		const generation = cache.generation;
		cache.pending.add(key);
		try {
			const assets = await resolver(cache.game, [key]);
			if (rootKey === activeRootKey) commitBatch(cache, generation, [key], assets);
		} finally {
			if (cache.generation === generation) cache.pending.delete(key);
		}
	}

	function getAssetUrl(game: string, path: string) {
		const rootKey = previewRootKey(game) || activeRootKey;
		const key = normalizePreviewKey(path);
		const cache = caches.get(rootKey);
		const resolvedPath = cache?.paths.get(key) || "";
		if (!resolvedPath) return "";
		const revision = cache?.revisions.get(key) || 0;
		return `${resolvePreviewAssetUrl(resolvedPath, converter)}?v=${revision}`;
	}

	function subscribe(game: string, path: string, listener: () => void) {
		const { cache } = getCache(game);
		const key = normalizePreviewKey(path);
		if (!key) return () => {};
		let listeners = cache.listeners.get(key);
		if (!listeners) {
			listeners = new Set();
			cache.listeners.set(key, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) cache.listeners.delete(key);
		};
	}

	function waitForIdle() {
		if (activeJobs === 0 && queue.length === 0) return Promise.resolve();
		return new Promise<void>((resolve) => idleListeners.add(resolve));
	}

	return { beginGeneration, getAssetUrl, requestVisible, subscribe, update, waitForIdle };
}

async function resolvePreviewAssets(game: string, paths: string[]) {
	if (!game || paths.length === 0) return [];
	return invoke<ResolvedPreviewAsset[]>("resolve_preview_assets", {
		game,
		requests: paths.map((path) => ({ key: path, relativePath: path })),
	});
}

const previewAssetManager = createPreviewAssetManager(resolvePreviewAssets);

export function beginPreviewGeneration(game: string) {
	return previewAssetManager.beginGeneration(game);
}

export function requestVisiblePreviewAssets(game: string, paths: string[]) {
	previewAssetManager.requestVisible(game, paths);
}

export function getImageUrl(path: string, game = "") {
	return previewAssetManager.getAssetUrl(game, path);
}

export function usePreviewAssetUrl(game: string, path: string) {
	const subscribe = useCallback(
		(listener: () => void) => previewAssetManager.subscribe(game, path, listener),
		[path, game]
	);
	const getSnapshot = useCallback(() => previewAssetManager.getAssetUrl(game, path), [path, game]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function updatePreviewAsset(game: string, path: string) {
	await previewAssetManager.update(game, path);
}
