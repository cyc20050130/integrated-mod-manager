import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { syncIniStateFromD3DXIni, getD3DXUserIniPath } from "./filesys";
import { GAME, MOD_LIST, store, TARGET } from "./vars";
import { info, warn } from "@/lib/logger";

let unwatchIniState: null | (() => void) = null;
let debounceHandle: number | null = null;
let activeIniPath = "";
let syncInFlight = false;
let syncQueued = false;

function normalizePath(value: string) {
	return String(value || "")
		.replaceAll("/", "\\")
		.toLowerCase();
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

export async function stopIniStateSync() {
	clearDebounce();
	if (unwatchIniState) {
		unwatchIniState();
		unwatchIniState = null;
	}
	try {
		await invoke("stop_ini_state_watch");
	} catch (error) {
		warn("[IMM] Failed to stop native d3dx_user.ini watcher:", error);
	}
	activeIniPath = "";
	syncQueued = false;
}

export async function syncIniStateOnce(reason = "manual") {
	return await flushQueuedSync(reason);
}

export async function startIniStateSync() {
	const targetPath = store.get(TARGET);
	const game = store.get(GAME);
	const iniPath = getD3DXUserIniPath(targetPath);
	if (!iniPath || !game || game === "NTE") {
		await stopIniStateSync();
		return;
	}
	if (normalizePath(activeIniPath) === normalizePath(iniPath) && unwatchIniState) return;
	await stopIniStateSync();
	let unlisten: (() => void) | null = null;
	try {
		unlisten = await listen<{ path?: string }>("ini-state-changed", (event) => {
			const changedPath = event.payload?.path || "";
			if (!activeIniPath || normalizePath(changedPath) !== normalizePath(activeIniPath)) return;
			scheduleSync("d3dx-user-ini-watch");
		});
		const watchedPath = await invoke<string>("start_ini_state_watch", { game });
		activeIniPath = watchedPath;
		unwatchIniState = unlisten;
		info("[IMM] Watching ini state file through native watcher:", watchedPath);
	} catch (error) {
		unlisten?.();
		activeIniPath = "";
		warn("[IMM] Failed to start native d3dx_user.ini watcher:", error);
	}
}
