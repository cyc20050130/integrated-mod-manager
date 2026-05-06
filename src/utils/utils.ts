import { useEffect, useMemo } from "react";
import { GAMES, IMAGE_SERVER, managedSRC, VERSION } from "./consts";
import {
	DATA,
	FILE_TO_DL,
	FILTER,
	GAME,
	INSTALLED_ITEMS,
	MOD_LIST,
	ONLINE,
	ONLINE_DATA,
	ONLINE_SELECTED,
	RIGHT_SLIDEOVER_OPEN,
	SETTINGS,
	SOURCE,
	store,
} from "./vars";
import { useAtom, useAtomValue } from "jotai";
import { apiClient } from "./api";
import { join } from "./hotreload";
import { addToast } from "@/_Toaster/ToastProvider";
import TEXT from "@/textData.json";
import { error, info } from "@/lib/logger";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getConfig } from "./filesys";
import { save } from "@tauri-apps/plugin-dialog";
import type { Games, GlobalSettings, InstalledItem, ModDataObj, OnlineBlacklistEntry, Settings } from "./types";

export { join };
let IMAGE_SERVER_URL = IMAGE_SERVER;
export function setImageServer(url: string) {
	IMAGE_SERVER_URL = url;
}
const reservedWindowsNames = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const illegalCharacters = /[<>:"/\\|?*]/g;
type JsonRecord = Record<string, unknown>;
type CheckedCacheEntry = { updated: number; status: number };
type CheckedCacheMap = Record<string, CheckedCacheEntry>;
type TextData = (typeof TEXT)["en"];
interface SanitizeFileNameOptions {
	replacement?: string;
	defaultName?: string;
	maxLength?: number;
}
interface BananaUpdateRecord {
	_sText?: string;
	_sVersion?: string;
	_tsDateModified?: number;
	_tsDateAdded?: number;
	_aChangeLog?: unknown[];
	_sName?: string;
}
interface BananaFileRecord {
	_tsDateModified?: number;
	_tsDateAdded?: number;
}
interface ModStatusCandidate {
	name: string;
	source: string;
	updated: number;
	viewed: number;
	modStatus: number;
}
type RawGlobalSettings = Partial<Omit<GlobalSettings, "onlineBlacklist" | "wuwaModFixer">> & {
	chkModUpd?: boolean;
	version?: string;
	updatedAt?: string;
	notice?: number;
	onlineBlacklist?: unknown;
	wuwaModFixer?: unknown;
};
function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function replaceControlCharacters(input: string, replacement: string) {
	return Array.from(input, (character) => (character.charCodeAt(0) < 32 ? replacement : character)).join("");
}
export function safeLoadJson(cur: JsonRecord | undefined, neww: JsonRecord | undefined) {
	if (!cur || !neww) return;
	Object.keys(neww).forEach((key) => {
		if (isJsonRecord(neww[key])) {
			cur[key] = safeLoadJson(isJsonRecord(cur[key]) ? cur[key] : undefined, neww[key]) || cur[key] || {};
		} else {
			cur[key] = neww[key];
		}
	});
	return cur;
}
export function sanitizeFileName(input: string, options: SanitizeFileNameOptions = {}): string {
	const { replacement = "_", defaultName = "untitled", maxLength = 255 } = options;

	if (typeof input !== "string") {
		return defaultName;
	}

	let sanitized = replaceControlCharacters(input, replacement)
		.normalize("NFC")
		.replace(illegalCharacters, replacement)
		.replace(/\s+/g, " ")
		.trim();

	// Windows forbids trailing spaces and trailing dots on path segments.
	sanitized = sanitized.replace(/[. ]+$/g, "").replace(/^[. ]+/g, "");
	sanitized = sanitized.replace(new RegExp(`${replacement}{2,}`, "g"), replacement);

	const baseName = sanitized.split(".")[0].trim();
	if (!baseName || reservedWindowsNames.test(baseName)) {
		sanitized = `${replacement}${sanitized || defaultName}`;
	}

	if (sanitized.length > maxLength) {
		sanitized = sanitized.substring(0, maxLength).replace(/[. ]+$/g, "").trim();
	}

	if (sanitized.length === 0) {
		return defaultName;
	}
	return sanitized;
}

export function deriveNameFromFileName(fileName: string) {
	if (!fileName) return "";
	const lastSegment = fileName.split(/[\\/]/).pop() || fileName;
	const withoutExt = lastSegment.replace(/\.[^.]+$/, "");
	return withoutExt.trim();
}
export function formatSize(size: number): string {
	return size < 100
		? size.toFixed(2) + "B"
		: size < 100000
			? (size / 1000).toFixed(2) + "KB"
			: size < 100000000
				? (size / 1000000).toFixed(2) + "MB"
				: (size / 1000000000).toFixed(2) + "GB";
}
export function handleImageError(event: React.SyntheticEvent<HTMLImageElement, Event>, hideOnError = false): void {
	const target = event.currentTarget;
	if (hideOnError) {
		target.style.opacity = "0";
		target.classList.remove("fadein");
	}
	target.src = `/${store.get(GAME) || "WW"}mm.png`;
}
export function preventContextMenu(event: React.MouseEvent): void {
	event.preventDefault();
	// event.currentTarget.dispatchEvent(new MouseEvent("mouseup", { button: 2, bubbles: true }));
}
let src = "";
let check = true;
// let lastUpdated = 0;
// store.sub(LAST_UPDATED, () => {
// 	lastUpdated = Date.now();
// });
store.sub(SOURCE, () => {
	src = store.get(SOURCE);
});
store.sub(SETTINGS, () => {
	check = store.get(SETTINGS).global.chkModUpdates;
});
export function getImageUrl(path: string): string {
	return `${IMAGE_SERVER_URL}/${src}/${managedSRC}/${path}`;
}
const PRIORITY_KEYS = ["Alt", "Ctrl", "Shift", "Capslock", "Tab", "Up", "Down", "Left", "Right"];
const PRIORITY_SET = new Set(PRIORITY_KEYS);
export function keySort(keys: string[]): string[] {
	const regularKeys = keys.filter((key) => !PRIORITY_SET.has(key));

	regularKeys.sort((a, b) => {
		if (a.length !== b.length) {
			return a.length - b.length;
		}

		return a.localeCompare(b);
	});

	const inputKeysSet = new Set(keys);
	const presentPriorityKeys = PRIORITY_KEYS.filter((pKey) => inputKeysSet.has(pKey));

	return [...presentPriorityKeys, ...regularKeys];
}
export function getTimeDifference(startTimestamp: number, endTimestamp: number) {
	const secInMinute = 60;
	const secInHour = secInMinute * 60;
	const secInDay = secInHour * 24;
	const secInYear = secInDay * 365;
	const diff = Math.abs(endTimestamp - startTimestamp);
	if (diff < secInMinute) {
		return "now";
	} else if (diff < secInHour) {
		const minutes = Math.floor(diff / secInMinute);
		return minutes + "m";
	} else if (diff < secInDay) {
		const hours = Math.floor(diff / secInHour);
		return hours + "h";
	} else if (diff < secInYear) {
		const days = Math.floor(diff / secInDay);
		return days + "d";
	} else {
		const years = Math.floor(diff / secInYear);
		return years + "y";
	}
}
export async function fetchModNoUpdates(selected: string, signal?: AbortSignal) {
	let modData = {};
	// console.log("Fetching mod data for", selected);
	await apiClient.mod(selected, signal).then((data) => {
		// console.log("Fetched mod data for", selected, data);
		if (data._idRow != selected.split("/").slice(-1)[0]) return;
		modData = data;
	});
	return modData;
}
export async function fetchMod(selected: string, controller?: AbortController) {
	let allData = {};
	//info(selected);
	await apiClient.updates(selected, controller?.signal).then(async (data) => {
		await apiClient.mod(selected, controller?.signal).then((data2) => {
			const updates =
				data._aRecords?.map((record: BananaUpdateRecord) => ({
					_sText: record._sText,
					_sVersion: record._sVersion,
					_sDate: record._tsDateModified || record._tsDateAdded,
					_aChangeLog: record._aChangeLog,
					_sName: record._sName,
				})) || [];
			// console.log(data);
			data2._aUpdates = updates;
			if (data._aRecords && data._aRecords.length > 0) {
				data2._eUpdate = true;
				data2._sUpdateText = data._aRecords[0]._sText;
				data2._sUpdateVersion = data._aRecords[0]._sVersion;
				data2._sUpdateDate = data._aRecords[0]._tsDateModified || data._aRecords[0]._tsDateAdded;
				data2._aUpdateChangeLog = data._aRecords[0]._aChangeLog;
				data2._sUpdateName = data._aRecords[0]._sName;
			}
			if (data2._idRow != selected.split("/").slice(-1)[0]) return;
			allData = data2;
			store.set(ONLINE_DATA, (prev) => {
				return {
					...prev,
					[selected]: data2,
				};
			});
		});
	});
	return allData;
}
export async function exportConfig(settings: Settings, textData: TextData) {
	try {
		const { gameConfig } = getConfig(settings);
		const filePath = await save({
			title: textData._LeftSideBar._components._Settings._ImportExport.ExportPop,
			defaultPath: `config${settings.global.game}.json`,
			filters: [
				{
					name: "JSON files",
					extensions: ["json"],
				},
			],
		});
		if (filePath) {
			await writeTextFile(filePath, JSON.stringify(gameConfig, null, 2));
			addToast({ type: "success", message: textData._Toasts.ConfigExported });
		}
	} catch {
		addToast({ type: "error", message: textData._Toasts.ErrorExporting });
	}
}
const sizeLabels = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
export function formatBytes(bytes: number, size = 0): string {
	return bytes >= 1024 ? formatBytes(bytes / 1024, size + 1) : `${Math.round(bytes * 100) / 100} ${sizeLabels[size]}`;
}
export function modRouteFromURL(url: string): string {
	const modId = url?.split("mods/").pop()?.split("/")[0] || "";
	return modId ? "Mod/" + modId : "";
}
export function normalizeModRoute(sourceOrRoute?: string): string {
	const value = String(sourceOrRoute || "").trim();
	if (!value) return "";
	const directMatch = value.match(/^mod\/(\d+)$/i);
	if (directMatch) return `Mod/${directMatch[1]}`;
	const routeMatch = value.match(/(?:^|[/?#])(Mod\/\d+)(?:$|[/?#])/i);
	if (routeMatch) {
		const modId = routeMatch[1].split("/")[1];
		return modId ? `Mod/${modId}` : "";
	}
	return modRouteFromURL(value);
}
export function onlineBlacklistKey(game: Games, routeOrSource?: string) {
	const route = normalizeModRoute(routeOrSource);
	return route ? `${game}:${route}` : "";
}
export function isModBlacklisted(tags?: string[]) {
	return !!tags?.includes("blacklisted");
}
export function withBlacklistTag(tags: string[] | undefined, blacklisted: boolean) {
	const next = new Set(tags || []);
	if (blacklisted) next.add("blacklisted");
	else next.delete("blacklisted");
	return Array.from(next);
}
export function isRouteBlacklisted(entries: OnlineBlacklistEntry[] | undefined, game: Games, routeOrSource?: string) {
	const key = onlineBlacklistKey(game, routeOrSource);
	return !!key && (entries || []).some((entry) => onlineBlacklistKey(entry.game, entry.route || entry.source) === key);
}
function sanitizeOnlineBlacklist(input: unknown): OnlineBlacklistEntry[] {
	if (!Array.isArray(input)) return [];
	const deduped = new Map<string, OnlineBlacklistEntry>();
	input.forEach((entry) => {
		const candidate = (entry || {}) as Partial<OnlineBlacklistEntry> & { createdAt?: unknown };
		const game = candidate.game && GAMES.includes(candidate.game) ? candidate.game : "";
		const route = normalizeModRoute(candidate.route || candidate.source || "");
		if (!route) return;
		const key = onlineBlacklistKey(game, route);
		deduped.set(key, {
			game,
			route,
			source: typeof candidate.source === "string" ? candidate.source : "",
			name: typeof candidate.name === "string" ? candidate.name : "",
			createdAt: Number.isFinite(candidate.createdAt) ? Number(candidate.createdAt) : Date.now(),
		});
	});
	return Array.from(deduped.values());
}
export function isOlderThanOneDay(dateStr: string) {
	const updateAgeMs = Date.now() - (dateStr ? new Date(dateStr).getTime() : 0);
	return Number.isFinite(updateAgeMs) && updateAgeMs > 86_400_000;
}
export function compareVersions(a = "", b = "") {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] || 0) - (right[i] || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
function sanitizeWuwaModFixerState(input: unknown) {
	const candidate = (input || {}) as Partial<GlobalSettings["wuwaModFixer"]> & { checkedAt?: unknown };
	return {
		version: typeof candidate.version === "string" ? candidate.version : "",
		exePath: typeof candidate.exePath === "string" ? candidate.exePath : "",
		checkedAt: Number.isFinite(candidate.checkedAt) ? Number(candidate.checkedAt) : 0,
		releaseUrl: typeof candidate.releaseUrl === "string" ? candidate.releaseUrl : "",
	};
}
export function sanitizeGlobalSettings(input: unknown): GlobalSettings & { version?: string; updatedAt?: string; notice?: number } {
	const candidate = (input || {}) as RawGlobalSettings;
	const ignore =
		typeof candidate.ignore === "string" && compareVersions(candidate.ignore || "0.0.0", VERSION) > 0
			? candidate.ignore
			: "";
	const optionalMeta: { version?: string; updatedAt?: string; notice?: number } = {};
	if (typeof candidate.version === "string") optionalMeta.version = candidate.version;
	if (typeof candidate.updatedAt === "string") optionalMeta.updatedAt = candidate.updatedAt;
	if (typeof candidate.notice === "number") optionalMeta.notice = candidate.notice;
	return {
		bgOpacity: typeof candidate.bgOpacity === "number" ? candidate.bgOpacity : 1,
		winOpacity: typeof candidate.winOpacity === "number" ? candidate.winOpacity : 1,
		winType: candidate.winType ?? 0,
		bgType: candidate.bgType ?? 2,
		listType: candidate.listType ?? 0,
		nsfw: candidate.nsfw ?? 1,
		toggleClick: candidate.toggleClick ?? 2,
		ignore,
		clientDate: typeof candidate.clientDate === "string" ? candidate.clientDate : "",
		XXMI: typeof candidate.XXMI === "string" ? candidate.XXMI : "",
		lang: candidate.lang ?? "",
		game: candidate.game ?? "",
		preReleases: false,
		chkModUpdates:
			typeof candidate.chkModUpdates === "boolean"
				? candidate.chkModUpdates
				: typeof candidate.chkModUpd === "boolean"
					? candidate.chkModUpd
					: true,
		onlineBlacklist: sanitizeOnlineBlacklist(candidate.onlineBlacklist),
		wuwaModFixer: sanitizeWuwaModFixerState(candidate.wuwaModFixer),
		...optionalMeta,
	};
}
let initialCheck = true;

// Load cached data from localStorage and clean up old entries (> 30 minutes)
const oneHour = 60 * 60 * 1000;
function loadCheckedCache(): CheckedCacheMap {
	try {
		const cached = localStorage.getItem("mod_check_cache");
		if (!cached) return {};
		const parsed = JSON.parse(cached) as Record<string, unknown>;
		const now = Date.now();
		// Filter out entries older than 30 minutes
		const cleaned: CheckedCacheMap = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "object" && value !== null && "updated" in value && "status" in value) {
				const cacheEntry = value as Partial<CheckedCacheEntry>;
				if (typeof cacheEntry.updated === "number" && typeof cacheEntry.status === "number" && now - cacheEntry.updated < oneHour) {
					cleaned[key] = { updated: cacheEntry.updated, status: cacheEntry.status };
				}
			}
		}
		info("[IMM] Loaded checked cache:", cleaned);
		return cleaned;
	} catch {
		return {};
	}
}

// Save cached data to localStorage
function saveCheckedCache(cache: CheckedCacheMap) {
	try {
		localStorage.setItem("mod_check_cache", JSON.stringify(cache));
	} catch (err) {
		error("[IMM] Error saving cache to localStorage:", err);
	}
}

const checked: Record<string, { updated: number; status: number }> = loadCheckedCache();
let now = Date.now();
export function handleInAppLink(url: string) {
	if (url.startsWith("imm://mode/")) return;
	if (url.startsWith("imm://")) {
		url = url.replace("imm://", "");
		if (!url.startsWith("http")) {
			url = "https://" + url;
		}
		const temp = url.split("/dl/");
		url = temp[0];
		if (temp[1]) {
			store.set(FILE_TO_DL, temp[1]);
		}
	}
	if (!url.startsWith("http")) return;
	const mod = modRouteFromURL(url);
	if (mod) {
		store.set(ONLINE, true);
		store.set(ONLINE_SELECTED, mod);
		store.set(RIGHT_SLIDEOVER_OPEN, true);
	}
}
export function useInstalledItemsManager() {
	const [installedItems, setInstalledItems] = useAtom(INSTALLED_ITEMS);
	const localData = useAtomValue(DATA);
	const modList = useAtomValue(MOD_LIST);
	const validPaths = useMemo(() => new Set(modList.map((mod) => mod.path)), [modList]);
	info("[IMM] Valid mod paths:", validPaths);

	useEffect(() => {
		if (installedItems.length == 0) initialCheck = true;
	}, [installedItems]);
	useEffect(() => {
		const checkModStatus = async (item: ModStatusCandidate) => {
			info("[IMM] Checking mod status for", item.name);
			let modStatus = 0;
			if (!check) {
				return 0;
			}
			if (Object.prototype.hasOwnProperty.call(checked, item.name) && now - (checked[item.name]?.updated || 0) < oneHour) {
				info("[IMM] Mod status found in cache for", item.name);
				modStatus = item.updated < checked[item.name].status ? (item.viewed < checked[item.name].status ? 2 : 1) : 0;
			} else {
				try {
					const data = (await fetchModNoUpdates(modRouteFromURL(item.source))) as {
						_tsDateModified?: number;
						_aFiles?: BananaFileRecord[];
					};
					if (data._tsDateModified) {
						let latest = item.updated || 0;
						data._aFiles?.forEach((file: BananaFileRecord) => {
							latest = Math.max(latest, (file._tsDateModified || file._tsDateAdded || 0) * 1000);
						});
						modStatus = item.updated < latest ? (item.viewed < latest ? 2 : 1) : 0;
						checked[item.name] = { updated: Date.now(), status: latest };
					}
				} catch {
					return 0;
				}
			}
			info("[IMM] Final mod status for", item.name, "is", modStatus);
			return modStatus;
		};
		const updateInstalledItems = async (localDataSnapshot: ModDataObj) => {
			const itemsToProcess: ModStatusCandidate[] = Object.keys(localDataSnapshot)
				.filter((key) => localDataSnapshot[key].source && validPaths.has(key))
				.map((key) => ({
					name: key,
					source: localDataSnapshot[key].source || "",
					updated: localDataSnapshot[key].updatedAt || 0,
					viewed: localDataSnapshot[key].viewedAt || 0,
					modStatus: 0,
				}));
			if (initialCheck) {
				setInstalledItems(itemsToProcess);
			}
			const batchSize = 10;
			const processedItems: InstalledItem[] = [];
			const totalItems = itemsToProcess.length;
			const startTime = Date.now();
			const modsProgressContainer = document.getElementById("mods-progress-container");
			const modsProgressBar = document.getElementById("mods-progress");
			const modsCheckedLabel = document.getElementById("mods-checked");
			const modsTotalLabel = document.getElementById("mods-total");
			now = Date.now();
			if (modsProgressContainer && modsTotalLabel) {
				modsTotalLabel.innerText = totalItems.toString();
				modsProgressContainer.style.bottom = "0px";
			}
			if (!check) info("[IMM] Mod update checking is disabled.");
			for (let i = 0; i < itemsToProcess.length; i += batchSize) {
				const batch = itemsToProcess.slice(i, i + batchSize);
				const newInBatch = batch.filter((item) => !Object.prototype.hasOwnProperty.call(checked, item.name));
				const batchResults = await Promise.all(
					batch.map(async (item) => {
						const modStatus = await checkModStatus(item);
						return { ...item, modStatus };
					})
				);
				processedItems.push(...batchResults);
				const checkedCount = Math.min(i + batchSize, totalItems);

				if (modsProgressBar && modsCheckedLabel) {
					modsProgressBar.style.width = `${(checkedCount / totalItems) * 100}%`;
					modsCheckedLabel.innerText = checkedCount.toString();
				}
				if (i + batchSize < itemsToProcess.length && newInBatch.length > 0) {
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}

			const newCount = processedItems.filter((item) => item.modStatus === 2).length;
			info("[IMM] Mod status check completed. New updates found:", newCount);
			saveCheckedCache(checked);

			if (initialCheck && totalItems) {
				initialCheck = false;
				setTimeout(
					() => {
						let lang = "en";
						try {
							lang = JSON.parse(localStorage.getItem("imm-lang") || '"en"');
						} catch {
							// Ignore invalid cached language values and keep English.
						}
						if (newCount > 0) {
							addToast({
								type: "info",
								message: TEXT[lang as keyof typeof TEXT]._Toasts.NewUpdates.replace("<new/>", newCount.toString()),
								duration: 10000,
								onClick: () => {
									store.set(FILTER, (prev) => ({ ...prev, upd: "has" }));
								},
							});
						} else {
							addToast({
								type: "info",
								message: TEXT[lang as keyof typeof TEXT]._Toasts.ModsLoaded,
							});
						}
					},
					Math.max(3500 - (Date.now() - startTime), 0)
				);
			}
			if (modsProgressContainer) {
				setTimeout(() => {
					modsProgressContainer.style.bottom = "-48px";
				}, 500);
			}
			setInstalledItems([
				...processedItems.sort((a, b) => {
					const flagDiff = b.modStatus - a.modStatus;
					if (flagDiff !== 0) return flagDiff;
					return a.name
						.toLocaleLowerCase()
						.split("\\")
						.slice(-1)[0]
						.localeCompare(b.name.toLocaleLowerCase().split("\\").slice(-1)[0]);
				}),
			]);
		};
		if (Object.keys(localData).length > 0) {
			updateInstalledItems({ ...localData });
		} else {
			setInstalledItems([]);
		}
	}, [localData, setInstalledItems, validPaths]);
}
