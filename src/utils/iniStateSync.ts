import { watch } from "@tauri-apps/plugin-fs";

import { syncIniStateFromD3DXIni, getD3DXUserIniPath } from "./filesys";
import { MOD_LIST, store, TARGET } from "./vars";
import { info, warn } from "@/lib/logger";

let unwatchIniState: null | (() => void) = null;
let debounceHandle: number | null = null;
let activeIniPath = "";
let syncInFlight = false;
let syncQueued = false;

function normalizePath(value: string) {
	return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function getEnabledMods() {
	return store
		.get(MOD_LIST)
		.filter((mod) => mod.enabled)
		.map((mod) => mod.path);
}

async function runSync(reason: string) {
	const enabledMods = getEnabledMods();
	if (!enabledMods.length) return [] as string[];
	info(`[IMM] Syncing ini state (${reason}) for ${enabledMods.length} enabled mods...`);
	return await syncIniStateFromD3DXIni(enabledMods, {
		rewritePrefs: true,
		persist: true,
	});
}

async function flushQueuedSync(reason: string) {
	if (syncInFlight) {
		syncQueued = true;
		return;
	}
	syncInFlight = true;
	try {
		await runSync(reason);
	} finally {
		syncInFlight = false;
		if (syncQueued) {
			syncQueued = false;
			await flushQueuedSync(`${reason}-queued`);
		}
	}
}

function clearDebounce() {
	if (debounceHandle !== null) {
		window.clearTimeout(debounceHandle);
		debounceHandle = null;
	}
}

function scheduleSync(reason: string) {
	clearDebounce();
	debounceHandle = window.setTimeout(() => {
		debounceHandle = null;
		void flushQueuedSync(reason);
	}, 300);
}

function isRelevantWatchEvent(event: any, iniPath: string) {
	const normalizedIniPath = normalizePath(iniPath);
	const touched = Array.isArray(event?.paths)
		? event.paths.some((path: string) => normalizePath(path) === normalizedIniPath)
		: false;
	if (!touched) return false;
	const type = event?.type;
	if (type === "any" || type === "other") return true;
	if (type?.modify) {
		const kind = type.modify.kind;
		return kind === "any" || kind === "data" || kind === "rename" || kind === "other";
	}
	if (type?.create) return true;
	if (type?.remove) return true;
	return false;
}

export async function stopIniStateSync() {
	clearDebounce();
	if (unwatchIniState) {
		unwatchIniState();
		unwatchIniState = null;
	}
	activeIniPath = "";
	syncQueued = false;
}

export async function syncIniStateOnce(reason = "manual") {
	return await flushQueuedSync(reason);
}

export async function startIniStateSync() {
	const targetPath = store.get(TARGET);
	const iniPath = getD3DXUserIniPath(targetPath);
	if (!iniPath) {
		await stopIniStateSync();
		return;
	}
	if (normalizePath(activeIniPath) === normalizePath(iniPath) && unwatchIniState) return;
	await stopIniStateSync();
	activeIniPath = iniPath;
	try {
		unwatchIniState = await watch(
			iniPath,
			(event) => {
				if (!isRelevantWatchEvent(event, iniPath)) return;
				scheduleSync("d3dx-user-ini-watch");
			},
			{ delayMs: 250 }
		);
		info("[IMM] Watching ini state file:", iniPath);
	} catch (error) {
		warn("[IMM] Failed to watch d3dx_user.ini:", error);
	}
}
