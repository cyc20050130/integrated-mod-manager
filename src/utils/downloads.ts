import { DEFAULTS } from "./consts";
import { DownloadItem, DownloadList, DownloadSettings, GameSettings } from "./types";

const MINUTE = 60_000;

function clampInt(value: unknown, fallback: number, min: number, max: number) {
	const n = Number.parseInt(String(value), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = { ...DEFAULTS.SETTINGS.game.download };

export function normalizeDownloadSettings(input?: Partial<DownloadSettings> | null): DownloadSettings {
	const source = input || {};
	return {
		maxConcurrentDownloads: clampInt(source.maxConcurrentDownloads, DEFAULT_DOWNLOAD_SETTINGS.maxConcurrentDownloads, 1, 3),
		maxConcurrentExtracts: clampInt(source.maxConcurrentExtracts, DEFAULT_DOWNLOAD_SETTINGS.maxConcurrentExtracts, 1, 4),
		requestRetries: clampInt(source.requestRetries, DEFAULT_DOWNLOAD_SETTINGS.requestRetries, 1, 5),
		connectTimeoutSec: clampInt(source.connectTimeoutSec, DEFAULT_DOWNLOAD_SETTINGS.connectTimeoutSec, 3, 60),
		stallTimeoutSec: clampInt(source.stallTimeoutSec, DEFAULT_DOWNLOAD_SETTINGS.stallTimeoutSec, 5, 180),
		maxRequeueRounds: clampInt(source.maxRequeueRounds, DEFAULT_DOWNLOAD_SETTINGS.maxRequeueRounds, 1, 8),
		progressIntervalMs: clampInt(source.progressIntervalMs, DEFAULT_DOWNLOAD_SETTINGS.progressIntervalMs, 200, 2000),
		progressBytesThresholdKB: clampInt(
			source.progressBytesThresholdKB,
			DEFAULT_DOWNLOAD_SETTINGS.progressBytesThresholdKB,
			16,
			2048
		),
		backoffBaseMs: clampInt(source.backoffBaseMs, DEFAULT_DOWNLOAD_SETTINGS.backoffBaseMs, 200, MINUTE),
	};
}

export function withNormalizedDownloadSettings(settings: GameSettings): GameSettings {
	return {
		...settings,
		download: normalizeDownloadSettings(settings.download),
	};
}

function ensureStatus(status: unknown): DownloadItem["status"] {
	if (
		status === "pending" ||
		status === "downloading" ||
		status === "extracting" ||
		status === "completed" ||
		status === "failed"
	) {
		return status;
	}
	return "pending";
}

function normalizeItem(item: any): DownloadItem | null {
	if (!item || typeof item !== "object") return null;
	const name = String(item.name || "").trim();
	const file = String(item.file || "").trim();
	const fname = String(item.fname || "").trim();
	const category = String(item.category || "").trim();
	if (!name || !file || !fname || !category) return null;

	const normalized: DownloadItem = {
		status: ensureStatus(item.status),
		addon: Boolean(item.addon),
		preview: String(item.preview || ""),
		category,
		source: String(item.source || ""),
		file,
		updated: Number(item.updated || 0),
		name,
		fname,
		requeueRounds: Number.isFinite(item.requeueRounds) ? Number(item.requeueRounds) : 0,
		createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now(),
	};

	if (item.displayName) normalized.displayName = String(item.displayName);
	if (item.safeName) normalized.safeName = String(item.safeName);
	if (item.key) normalized.key = String(item.key);
	if (item.path) normalized.path = String(item.path);
	if (item.dlPath) normalized.dlPath = String(item.dlPath);
	if (Number.isFinite(item.updatedAt)) normalized.updatedAt = Number(item.updatedAt);
	if (item.lastError) normalized.lastError = String(item.lastError);
	if (Number.isFinite(item.lastTriedAt)) normalized.lastTriedAt = Number(item.lastTriedAt);

	return normalized;
}

function normalizeItemArray(value: unknown): DownloadItem[] {
	if (!Array.isArray(value)) return [];
	const normalized = value
		.map((item) => normalizeItem(item))
		.filter((item): item is DownloadItem => Boolean(item));

	const seen = new Set<string>();
	return normalized.filter((item) => {
		const key = item.key || `${item.name}::${item.displayName || ""}::${item.file}::${item.fname}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function normalizeDownloadList(raw: any): DownloadList {
	const pendingFromQueue = normalizeItemArray(raw?.queue).map((item) => ({ ...item, status: "pending" as const }));

	const downloadingRaw = raw?.downloading;
	const downloadingItems = Array.isArray(downloadingRaw)
		? normalizeItemArray(downloadingRaw)
		: downloadingRaw
			? normalizeItemArray([downloadingRaw])
			: [];
	const downloading = downloadingItems.map((item) => ({ ...item, status: "downloading" as const }));

	const extracting = normalizeItemArray(raw?.extracting).map((item) => ({ ...item, status: "extracting" as const }));
	const completed = normalizeItemArray(raw?.completed).map((item) => ({ ...item, status: "completed" as const }));
	const failed = normalizeItemArray(raw?.failed).map((item) => ({ ...item, status: "failed" as const }));

	return {
		queue: pendingFromQueue,
		downloading,
		extracting,
		completed,
		failed,
	};
}

export function toResumableDownloadList(raw: any): DownloadList {
	const normalized = normalizeDownloadList(raw);
	const queue = normalized.queue.map((item) => ({
		...item,
		status: "pending" as const,
	}));
	const recovered = [...normalized.downloading, ...normalized.extracting].map((item) => ({
		...item,
		status: "pending" as const,
		lastError: item.lastError || "Recovered after app restart",
	}));

	return {
		queue: [...queue, ...recovered],
		downloading: [],
		extracting: [],
		completed: normalized.completed,
		failed: normalized.failed,
	};
}
