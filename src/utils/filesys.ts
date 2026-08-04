import defConfig from "../default.json";
import {
	exts,
	IGNORE,
	managedSRC,
	managedTGT,
	OLD_managedSRC,
	OLD_managedTGT,
	OLD_RESTORE,
	PREFS,
	RESTORE,
	UNCATEGORIZED,
	VERSION,
} from "./consts";
import {
	CATEGORIES,
	DATA,
	DOWNLOAD_LIST,
	ERR,
	GAME,
	LAST_UPDATED,
	MOD_LIST,
	NTE_REGION,
	PRESETS,
	PROGRESS_OVERLAY,
	SETTINGS,
	SOURCE,
	store,
	TARGET,
	TEXT_DATA,
	XXMI_DIR,
	XXMI_MODE,
} from "./vars";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { compareVersions, join, sanitizeFileName, sanitizeGlobalSettings } from "./utils";
import { isAppInitialized, main, updateConfig } from "./init";
import { addToast } from "@/_Toaster/ToastProvider";
import MiniSearch from "minisearch";
import {
	Category,
	ChangeInfo,
	DirEntry,
	DownloadItem,
	DownloadList,
	GameConfig,
	GlobalSettings,
	Mod,
	ModDataObj,
	ModHotKeys,
	NteRegion,
	Preset,
	Settings,
} from "./types";
import { error, info, warn } from "@/lib/logger";
import { addToExtracts } from "@/_LeftSidebar/components/Downloads";
import { normalizeDownloadList, withNormalizedDownloadSettings } from "./downloads";
import { syncIniStateFromText } from "./iniStateSyncCore.js";
import { beginPreviewGeneration, updatePreviewAsset } from "./imagePreview";
import { acceptNteOperationRevision } from "./nteConfigRevision";
import {
	getManagedConfigTarget,
	persistGameConfigWithModPreview,
	persistRuntimeConfigs,
	readManagedConfigText,
	writeManagedConfigText,
} from "./appConfigRepository";
export async function setGame(game: string) {
	try {
		const config = await readTextFile(`config.json`);
		const parsedConfig = JSON.parse(config);
		parsedConfig.game = game;
		await writeManagedConfigProjection(`config.json`, JSON.stringify(parsedConfig, null, 2));
		return true;
	} catch {
		try {
			if (!(await exists(`config.json`))) {
				await writeManagedConfigProjection(`config.json`, JSON.stringify({ ...defConfig, game }, null, 2));
				return true;
			}
			throw new Error("Config file exists but could not be read or updated.");
		} catch {
			return false;
		}
	}
}
const textMSG = {
	rem: "Removing current files",
	disc: "Discovering files",
	file: "File",
};
let completedFiles = 0;
let totalFiles = 0;
let canceled = false;
let result = "Ok";
let progressBar: HTMLElement | null = null;
let progressMessage: HTMLElement | null = null;
let progressPerct: HTMLElement | null = null;
// Initialize Intl.Collator for faster string comparison
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type ManagedPathRoot = "source" | "target";
type ManagedPathIdentity = { rootKind: ManagedPathRoot; relativePath: string };
function normalizeManagedAbsolutePath(path: string) {
	let normalized = String(path || "").replaceAll("/", "\\");
	while (normalized.length > 3 && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
	return normalized;
}
function getManagedPathIdentity(path: string): ManagedPathIdentity {
	const normalized = normalizeManagedAbsolutePath(path);
	if (!/^[a-zA-Z]:\\/.test(normalized) && !normalized.startsWith("\\\\")) {
		throw new Error(`Managed filesystem path must be absolute: ${path}`);
	}
	const roots = [
		{ rootKind: "source" as const, path: normalizeManagedAbsolutePath(src) },
		{ rootKind: "target" as const, path: normalizeManagedAbsolutePath(tgt) },
	]
		.filter((entry) => entry.path)
		.sort((left, right) => right.path.length - left.path.length);
	const lower = normalized.toLowerCase();
	for (const root of roots) {
		const rootLower = root.path.toLowerCase();
		if (lower === rootLower) return { rootKind: root.rootKind, relativePath: "" };
		if (lower.startsWith(rootLower + "\\")) {
			return { rootKind: root.rootKind, relativePath: normalized.slice(root.path.length + 1) };
		}
	}
	throw new Error(`Path is outside the persisted game roots: ${path}`);
}
function managedPathArgs(path: string) {
	return { game: store.get(GAME), ...getManagedPathIdentity(path) };
}
async function exists(path: string) {
	const managedConfig = getManagedConfigTarget(path);
	if (managedConfig) {
		try {
			await readManagedConfigText(managedConfig);
			return true;
		} catch {
			return false;
		}
	}
	return pathExistsNative(path);
}
async function mkdir(path: string, options: { recursive?: boolean } = {}) {
	return mkdirNative(path, Boolean(options.recursive));
}
async function readDir(path: string) {
	return readDirNative(path);
}
async function readTextFile(path: string) {
	const managedConfig = getManagedConfigTarget(path);
	if (managedConfig) return readManagedConfigText(managedConfig);
	return readTextFileNative(path);
}
async function writeManagedConfigProjection(path: string, contents: string) {
	const managedConfig = getManagedConfigTarget(path);
	if (!managedConfig) throw new Error(`Unsupported managed configuration target: ${path}`);
	return writeManagedConfigText(managedConfig, contents);
}

const sp = [UNCATEGORIZED, IGNORE, OLD_RESTORE];
let recentlyDownloaded: string[] = [];
store.sub(DOWNLOAD_LIST, () => {
	recentlyDownloaded = store
		.get(DOWNLOAD_LIST)
		.completed.map((item) => item.path)
		.filter((path): path is string => Boolean(path));
});
let src = "";
let rootReplace = "";
let modRoot = "";
let tgt = "";
let textData = store.get(TEXT_DATA);
store.sub(TEXT_DATA, () => {
	textData = store.get(TEXT_DATA);
});
store.sub(SOURCE, () => {
	src = store.get(SOURCE);
	modRoot = join(src, managedSRC);
	rootReplace = modRoot;
});
store.sub(TARGET, () => {
	tgt = store.get(TARGET);
});
let catDB: MiniSearch | null = null;
store.sub(CATEGORIES, () => {
	try {
		const categories = store.get(CATEGORIES) || [];
		catDB = new MiniSearch({
			idField: "_sName",
			fields: ["_sName"],
			storeFields: ["_sName", "_sIconUrl"],
			searchOptions: {
				boost: { name: 2 },
				fuzzy: 0.2,
			},
		});
		catDB.addAll([...categories, { _sName: UNCATEGORIZED, _sIconUrl: "" }]);
		info("[IMM] Rebuilt category search index:", categories.length);
	} catch (indexError) {
		error("[IMM] Error building category search index:", indexError);
	}
});
export async function setConfig(config: Partial<GameConfig> & { version?: string; game?: string }) {
	info("[IMM] Setting config...");
	if (!config) return;
	if (config.version && compareVersions(config.version, "2.1.0") < 0) {
		info("[IMM] Old config version, migrating...");
		await updateConfig(config);
		addToast({ type: "success", message: textData._Toasts.SuccessPort });
		main();
		return;
	}
	const { gameConfig: curConfig } = getConfig(store.get(SETTINGS));
	info("[IMM] Current config:", { ...curConfig });
	info("[IMM] New config:", config);
	if (!curConfig.game || !config.game || curConfig.game !== config.game) {
		addToast({ type: "error", message: textData._Toasts.GameConfigMismatch });
		return;
	}
	config.version = VERSION;
	await writeManagedConfigProjection(`config${curConfig.game}.json`, JSON.stringify(config, null, 2));
	// store.set(INIT_DONE,false)
	addToast({ type: "success", message: textData._Toasts.ConfigLoaded });
	main();
}

type RuntimeStateSnapshot = {
	settings?: Settings;
	data?: ModDataObj;
	downloads?: DownloadList;
	presets?: Preset[];
	categories?: Category[];
	source?: string;
	target?: string;
	xxmiMode?: 0 | 1;
	xxmiDir?: string;
	nteRegion?: NteRegion;
};

function getConfigPayload(snapshot: RuntimeStateSnapshot = {}) {
	const settings = snapshot.settings || store.get(SETTINGS);
	const config: GlobalSettings = {
		...sanitizeGlobalSettings(settings.global),
		updatedAt: new Date().toISOString(),
		version: VERSION,
		XXMI: snapshot.xxmiDir ?? store.get(XXMI_DIR) ?? "",
	};
	const normalizedSettings = withNormalizedDownloadSettings(settings.game);
	const downloads = normalizeDownloadList(snapshot.downloads ?? store.get(DOWNLOAD_LIST));
	const xxmiMode = snapshot.xxmiMode ?? store.get(XXMI_MODE) ?? 0;
	const resolvedSource = snapshot.source ?? store.get(SOURCE) ?? "";
	const resolvedTarget = snapshot.target ?? store.get(TARGET) ?? "";
	const gameConfig: GameConfig = {
		version: VERSION,
		custom: xxmiMode,
		...(settings.global.game === "NTE" ? { nteRegion: snapshot.nteRegion ?? store.get(NTE_REGION) } : {}),
		sourceDir: resolvedSource,
		targetDir: resolvedTarget,
		game: settings.global.game,
		settings: normalizedSettings,
		data: snapshot.data ?? store.get(DATA) ?? {},
		presets: snapshot.presets ?? store.get(PRESETS) ?? [],
		downloads,
		updatedAt: new Date().toISOString(),
		categories: snapshot.categories ?? store.get(CATEGORIES) ?? [],
	};
	return { config, gameConfig };
}
export function getConfig(settings: Settings) {
	return getConfigPayload({ settings });
}
async function persistConfigs(snapshot: RuntimeStateSnapshot = {}, skip = false) {
	const { config, gameConfig } = getConfigPayload(snapshot);
	await persistRuntimeConfigs(
		config as unknown as Record<string, unknown>,
		config.game && !skip ? (gameConfig as unknown as Record<string, unknown>) : undefined
	);
}
export async function saveConfigs(skip = false, settings = store.get(SETTINGS)) {
	info("[IMM] Saving configs...");
	if (!isAppInitialized()) return;
	await persistConfigs({ settings }, skip);
}
export async function saveGameBananaBinding(game: string, relativePath: string, previewUrl: string, data: ModDataObj) {
	const { gameConfig } = getConfigPayload({ data });
	if (gameConfig.game !== game) throw new Error("Active game changed before the binding transaction started.");
	await persistGameConfigWithModPreview(gameConfig as unknown as Record<string, unknown>, relativePath, previewUrl);
}
export async function flushRuntimeState(reason = "manual", snapshot: RuntimeStateSnapshot = {}) {
	info(`[IMM] Flushing runtime state (${reason})...`);
	await persistConfigs(snapshot);
}
export function getD3DXUserIniPath(targetPath = tgt) {
	const resolvedTarget = String(targetPath || "");
	if (!resolvedTarget) return "";
	const parentParts = resolvedTarget.split("\\").slice(0, -1);
	if (!parentParts.length) return "";
	return join(...parentParts, "d3dx_user.ini");
}
export async function selectPath(
	options = { multiple: false, directory: false } as {
		multiple?: boolean;
		directory?: boolean;
		defaultPath?: string;
		title?: string;
		filters?: { name: string; extensions: string[] }[];
	}
) {
	return await open(options);
}
export function folderSelector(path = "", title: string | undefined = undefined) {
	return selectPath({ directory: true, ...(path ? { defaultPath: path } : {}), ...(title ? { title } : {}) });
}
export async function ensureManagedSourceDir(game = store.get(GAME)) {
	await invoke<void>("prepare_managed_source_dir", { game });
}
type GuardedPathOptions = {
	recursive?: boolean;
};
export async function guardedRemove(path: string, options: GuardedPathOptions = {}) {
	return invoke<void>("remove_managed_path", {
		...managedPathArgs(path),
		recursive: Boolean(options.recursive),
	});
}
export async function guardedRename(from: string, to: string) {
	const fromIdentity = getManagedPathIdentity(from);
	const toIdentity = getManagedPathIdentity(to);
	return invoke<void>("rename_managed_path", {
		game: store.get(GAME),
		fromRootKind: fromIdentity.rootKind,
		fromRelativePath: fromIdentity.relativePath,
		toRootKind: toIdentity.rootKind,
		toRelativePath: toIdentity.relativePath,
	});
}
export async function guardedCopyFile(from: string, to: string) {
	const fromIdentity = getManagedPathIdentity(from);
	const toIdentity = getManagedPathIdentity(to);
	return invoke<void>("copy_managed_file", {
		game: store.get(GAME),
		fromRootKind: fromIdentity.rootKind,
		fromRelativePath: fromIdentity.relativePath,
		toRootKind: toIdentity.rootKind,
		toRelativePath: toIdentity.relativePath,
	});
}
async function pathExistsNative(path: string) {
	try {
		return await invoke<boolean>("managed_path_exists", managedPathArgs(path));
	} catch (err) {
		info("[IMM] managed exists() check failed:", path, err);
		return false;
	}
}
async function readDirNative(path: string) {
	return invoke<DirEntry[]>("read_managed_dir", managedPathArgs(path));
}
async function readTextFileNative(path: string) {
	return invoke<string>("read_managed_text_file", managedPathArgs(path));
}
type ManagedTextPurpose =
	"d3dxUserIni" | "modMetadata" | "presetExport" | "collisionChecklist" | "modPreference" | "modIni";
async function writeManagedTextAsset(purpose: ManagedTextPurpose, relativePath: string, contents: string) {
	return invoke<void>("write_managed_text_asset", {
		game: store.get(GAME),
		purpose,
		relativePath,
		contents,
	});
}
async function readD3DXUserIni() {
	return invoke<string | null>("read_d3dx_user_ini", { game: store.get(GAME) });
}
async function ensureD3DXUserIniBackup() {
	return invoke<boolean>("ensure_d3dx_user_ini_backup", { game: store.get(GAME) });
}
async function mkdirNative(path: string, recursive = true) {
	const args = managedPathArgs(path);
	if (!args.relativePath) return;
	if (!recursive && args.relativePath.includes("\\")) {
		throw new Error("Non-recursive managed directory creation only accepts one path component.");
	}
	return invoke<void>("create_managed_dir", args);
}
function replaceDisabled(name: string) {
	return name.replace("DISABLED_", "").replace("DISABLED", "").trim();
}
function formatDateTime() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(
		2,
		"0"
	)}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(
		now.getSeconds()
	).padStart(2, "0")}`;
}
/**
 * Optimized sorting function using Intl.Collator for better performance
 * Handles case-insensitive sorting with uppercase precedence for same letters
 */
function sortMods(a: Mod | DirEntry, b: Mod | DirEntry) {
	const x = replaceDisabled(a.name);
	const y = replaceDisabled(b.name);

	// Use Intl.Collator for faster comparison
	const comparison = collator.compare(x, y);

	if (comparison !== 0) {
		return comparison;
	}

	// If names are equal after collation, prioritize uppercase
	const xFirstLower = x[0]?.toLowerCase();
	const yFirstLower = y[0]?.toLowerCase();

	if (xFirstLower === yFirstLower) {
		const xIsUpper = x[0] === x[0]?.toUpperCase();
		const yIsUpper = y[0] === y[0]?.toUpperCase();

		if (xIsUpper && !yIsUpper) return 1;
		if (!xIsUpper && yIsUpper) return -1;
	}

	return 0;
}
async function copyDir(src: string, dest: string, withProgress = false) {
	try {
		await mkdirNative(dest, true);
		const entries = (await readDirNative(src)).filter(
			(item) =>
				!withProgress ||
				(item.name !== RESTORE &&
					item.name !== IGNORE &&
					item.name !== PREFS &&
					item.name !== managedSRC &&
					item.name !== managedTGT)
		);
		for (const entry of entries) {
			if (withProgress && canceled) {
				if (result == "Ok") result = "Operation Cancelled";
				return;
			}
			const srcPath = `${src}/${entry.name}`;
			const destPath = `${dest}/${entry.name}`;
			if (!entry.isDirectory) {
				await guardedCopyFile(srcPath, destPath);
				if (withProgress) {
					completedFiles++;
					if (progressBar && progressPerct && progressMessage) {
						const percentage = ((completedFiles / totalFiles) * 100).toFixed(2);
						progressBar.style.width = percentage + "%";
						progressPerct.innerText = percentage + "%";
						progressMessage.innerText = `${textMSG.file} ${completedFiles}/${totalFiles}: ${src.replace(
							rootReplace,
							""
						)}/${entry.name}`;
					}
				}
			} else {
				await copyDir(srcPath, destPath, withProgress);
			}
		}
	} catch (error) {
		canceled = true;
		result = "An Error Occurred";
		//console.error("Error copying directory:", error);
		throw error;
	}
}

async function countFilesInDir(path: string) {
	const entries = (await readDirNative(join(path, ""))).filter(
		(item) => item.name != RESTORE && item.name != IGNORE && item.name != PREFS
	);
	for (const entry of entries) {
		if (entry.isDirectory) {
			await countFilesInDir(join(path, entry.name));
		} else {
			totalFiles++;
			if (progressMessage) {
				progressMessage.innerText = textMSG.disc + " ( " + totalFiles + " / ? )";
			}
		}
	}
}
export function cancelRestore() {
	info("[IMM] Cancelling restore operation...");
	canceled = true;
}
export async function getRestorePoints(): Promise<string[]> {
	info("[IMM] Getting restore points...");
	try {
		const restoreDir = join(modRoot, RESTORE);
		if (!(await pathExistsNative(restoreDir))) return [];
		const entries = await readDirNative(restoreDir);
		return entries
			.filter((item) => item.isDirectory)
			.map((item) => item.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}
export async function resetWithBackup() {
	info("[IMM] Resetting with backup...");
	await invoke("reset_app_state_with_backup");
	window.location.reload();
}
export async function previewRestorePoint(point: string) {
	info("[IMM] Previewing restore point:", point);
	const path = join(modRoot, RESTORE, point);
	if (!(await pathExistsNative(path))) return [];
	const entries = await readDirRecr(path, "", 2);
	const categories = store.get(CATEGORIES) || [];
	//info(entries);
	return entries.map((entry: Mod) => {
		const category = categories.find((cat) => cat._sName === entry.name);
		if (category && entry.isDir) entry.icon = category._sIconUrl;
		return entry;
	});
}
export async function sourceBatchPreview(newCategory = "" as string) {
	info("[IMM] Previewing source batch...");
	const path = src;
	if (!(await exists(path))) return [];
	const categories = store.get(CATEGORIES) || [];
	try {
		if (newCategory) {
			await mkdir(join(modRoot, newCategory), { recursive: true });
		}
	} catch (mkdirError) {
		warn("[IMM] Unable to prepare batch preview category:", mkdirError);
	}
	const entries = (await readDirRecr(path, "", 2))
		.filter((entry) => store.get(GAME) !== "NTE" || entry.name === managedSRC)
		.map((entry: Mod) => {
			if (entry.name === managedSRC) {
				// entry.icon = "IMM2.png";

				entry.children.map((child: Mod) => {
					const category = categories.find((cat) => cat._sName === child.name);
					if (category && child.isDir) child.icon = category._sIconUrl;
					return child;
				});
			} else if (entry.name === managedTGT) {
				// entry.icon = "IMM2.png";
			}
			return entry;
		});
	info("[WWW]", entries);
	return entries;
}
export async function addToBatchPreview(opath: string) {
	info("[IMM] Adding to source batch preview:", opath);
	const path = join(src, opath);
	if (!(await exists(path))) return [];
	const entries = await readDirRecr(path, "", 0);
	info("[WWW]", path, " -> ", entries);
	return entries.map((entry: Mod) => {
		entry.path = join(opath, entry.path);
		entry.parent = opath;
		return entry;
	});
}
export async function restoreFromPoint(point: string) {
	info("[IMM] Restoring from point:", point);
	const path = join(modRoot, RESTORE, point);
	if (!(await exists(path))) return null;
	store.set(PROGRESS_OVERLAY, {
		title: "Restoring from " + point,
		finished: false,
		button: "Cancel",
		open: true,
		name: point,
	});
	progressBar = document.querySelector("#restore-progress");
	progressMessage = document.querySelector("#restore-progress-message");
	progressPerct = document.querySelector("#restore-progress-percentage");
	while (!progressBar || !progressMessage || !progressPerct) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		progressBar = progressBar || document.querySelector("#restore-progress");
		progressMessage = progressMessage || document.querySelector("#restore-progress-message");
		progressPerct = progressPerct || document.querySelector("#restore-progress-percentage");
	}
	progressMessage.innerText = textMSG.rem;
	const entries = (await readDir(modRoot)).filter((item) => item.name != RESTORE);
	for (const entry of entries) {
		try {
			await guardedRemove(join(modRoot, entry.name), { recursive: true });
		} catch (cleanupError) {
			warn("[IMM] Failed to clear restore target entry:", cleanupError);
		}
	}
	progressMessage.innerText = textMSG.disc;
	completedFiles = 0;
	totalFiles = 0;
	canceled = false;
	if (canceled) {
		result = "Operation Cancelled";
	} else {
		await countFilesInDir(path);
		result = "Ok";
		rootReplace = join(modRoot, RESTORE, point);
		await copyDir(path, point.startsWith("ORG") ? src : modRoot, true);
	}
	store.set(PROGRESS_OVERLAY, (prev) => ({
		title: result == "Ok" ? "Restoration Completed" : result,
		finished: true,
		button: "Close",
		open: prev.open,
		name: point,
	}));
	if (result === "Ok" && !canceled) {
		try {
			await invoke("request_app_restart");
		} catch (restartError) {
			warn("[IMM] Failed to request app restart after restore, reloading window instead:", restartError);
			window.location.reload();
		}
	}
	return null;
}
export async function createRestorePoint(prefix = "") {
	info("[IMM] Creating restore point with prefix:", prefix);
	store.set(PROGRESS_OVERLAY, {
		title: "Creating Restore Point",
		button: "Cancel",
		finished: false,
		open: true,
		name: prefix,
	});
	progressBar = document.querySelector("#restore-progress");
	progressMessage = document.querySelector("#restore-progress-message");
	progressPerct = document.querySelector("#restore-progress-percentage");
	while (!progressBar || !progressMessage || !progressPerct) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		progressBar = progressBar || document.querySelector("#restore-progress");
		progressMessage = progressMessage || document.querySelector("#restore-progress-message");
		progressPerct = progressPerct || document.querySelector("#restore-progress-percentage");
	}
	progressMessage.innerText = textMSG.disc;
	completedFiles = 0;
	totalFiles = 0;
	canceled = false;
	try {
		await mkdir(join(modRoot, RESTORE), { recursive: true });
	} catch (mkdirError) {
		warn("[IMM] Restore root already exists or could not be created:", mkdirError);
	}

	const restorePointName = prefix + "RESTORE-" + formatDateTime();
	const root = !prefix ? modRoot : src;
	rootReplace = root;
	await countFilesInDir(root);
	try {
		await mkdirNative(join(modRoot, RESTORE, restorePointName), true);
	} catch {
		return false;
	}
	result = "Ok";
	await copyDir(root, join(modRoot, RESTORE, restorePointName), true);
	if (canceled) {
		if (result === "Ok") result = "Operation Cancelled";
		await guardedRemove(join(modRoot, RESTORE, restorePointName), { recursive: true });
		try {
			await guardedRemove(join(modRoot, RESTORE));
			await guardedRemove(join(modRoot));
		} catch (cleanupError) {
			warn("[IMM] Failed to clean canceled restore point directories:", cleanupError);
		}
	}
	store.set(PROGRESS_OVERLAY, (prev) => ({
		title: result === "Ok" ? "Restore Point Created" : result,
		button: "Close",
		finished: true,
		open: prev.open,
		name: prefix,
	}));
	return result === "Ok";
}
export async function checkOldVerDirs(src: string) {
	try {
		let checkFolders = 0;
		const entries = await readDirNative(src);
		for (const i of entries) {
			if (i.isDirectory && sp.includes(i.name)) {
				checkFolders++;
			}
		}
		return checkFolders === 3;
	} catch {
		return false;
	}
}

export async function categorizeDir(src: string, modifyIni = false) {
	info("[IMM] Categorizing directory:", src, "Skip restore:", modifyIni);
	let d3dx = "";
	try {
		const ini = await readD3DXUserIni();
		info("[IMM] Reading d3dx_user.ini...", ini !== null);
		if (ini !== null) await ensureD3DXUserIniBackup();
		if (modifyIni) d3dx = ini || "";
	} catch {
		info("[IMM] d3dx_user.ini not found or could not be read.");
	}

	try {
		const categories = [...store.get(CATEGORIES), { _sName: UNCATEGORIZED }].map((cat) => cat._sName);

		const reqCategories: Record<string, Array<{ name: string; isDirectory: boolean }>> = {};
		const entries = await readDirNative(src);
		const ignore = [IGNORE, managedSRC, managedTGT, RESTORE, PREFS];
		const fullDirectoryRenames: string[] = []; // First pass: categorize items
		for (const item of entries) {
			if (item.isDirectory && ignore.includes(item.name)) continue;
			if (item.name === OLD_RESTORE) {
				if (modifyIni) continue;
				try {
					await guardedRename(join(src, OLD_RESTORE), join(src, RESTORE));
				} catch {
					warn("[IMM] Unable to rename legacy restore directory, continuing.");
				}
				continue;
			}
			if (categories.includes(item.name)) {
				fullDirectoryRenames.push(item.name);
				continue;
			}
			const category = catDB?.search(item.name, { prefix: true, fuzzy: 0.2 })[0]?._sName || UNCATEGORIZED;
			// categories.find((cat: string) =>
			// 	cat
			// 		.toLowerCase()
			// 		.split(" ")
			// 		.some(
			// 			(catPart: string) =>
			// 				catPart.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(catPart)
			// 		)
			// ) || UNCATEGORIZED;
			if (item.isDirectory && item.name === category) {
				fullDirectoryRenames.push(category);
				continue;
			}

			if (!reqCategories[category]) {
				reqCategories[category] = [];
			}
			reqCategories[category].push({ name: item.name, isDirectory: item.isDirectory });
		}
		// Second pass: batch create directories and move items
		const mkdirPromises: Promise<void>[] = [];
		for (const key of Object.keys(reqCategories)) {
			mkdirPromises.push(mkdirNative(join(src, key), true));
		}
		await Promise.all(mkdirPromises);

		// Move items to categories
		const renamePromises: Promise<void>[] = [];
		const changesToD3dx: Record<string, string> = {};
		const renameWithTry = async (key: string, name: string) => {
			try {
				await guardedRename(join(src, name), join(src, key, name));
				const oldPath = join(src, name);
				const newPath = join(src, key, name);
				info("[IMM] Renamed:", oldPath, "->", newPath);
				changesToD3dx[oldPath] = join(tgt, key, name);
			} catch (error) {
				warn("Error renaming:", key, "\\", name, error);
			}
		};
		// console.log("Full directory renames:", fullDirectoryRenames);
		(await Promise.all(fullDirectoryRenames.map((dir) => readDirRecr(src, dir, 0)))).flat().forEach((entry) => {
			const oldPath = join(src, entry.path);
			const newPath = join(tgt, entry.path);
			changesToD3dx[oldPath] = newPath;
		});

		for (const [key, list] of Object.entries(reqCategories)) {
			for (const item of list) {
				renamePromises.push(renameWithTry(key, item.name));
			}
		}
		await Promise.all(renamePromises);
		if (modifyIni && d3dx) {
			const d3dxLines = d3dx.split("\n");
			for (const [oldPath, newPath] of Object.entries(changesToD3dx)) {
				const op = join("$\\mods", oldPath.replaceAll(tgt, "").replaceAll("/", "\\")).toLowerCase();
				const np = join(
					"$\\mods\\",
					managedTGT,
					replaceDisabled(newPath).replaceAll(tgt, "").replaceAll("/", "\\")
				).toLowerCase();
				info("[IMM] Updating d3dx_user.ini:", op, "->", np);
				for (let i = 0; i < d3dxLines.length; i++) {
					d3dxLines[i] = d3dxLines[i].startsWith(op) ? d3dxLines[i].replace(op, np) : d3dxLines[i];
				}
			}
			await writeManagedTextAsset("d3dxUserIni", "", d3dxLines.join("\n"));
		}
	} catch (categorizeError) {
		error("[IMM] Error categorizing directory:", categorizeError);
		throw categorizeError;
	}
}
export async function verifyDirStruct() {
	const status: ChangeInfo = {
		before: [],
		after: [],
		map: {},
		title: "Confirm Changes",
		skip: false,
	};
	try {
		if (!(!!src && (await pathExistsNative(src))) || !(!!tgt && (await pathExistsNative(tgt))))
			throw new Error("Source or Target not found: " + src + " | " + tgt);

		if (!(await pathExistsNative(tgt))) throw new Error("Target Directory not found: " + tgt);
		try {
			const oldTgtPath = join(tgt, OLD_managedTGT);
			const newTgtPath = join(tgt, managedTGT);
			if (await pathExistsNative(oldTgtPath)) {
				await guardedRename(oldTgtPath, newTgtPath);
				//add code to read the file d3dx_user.ini in the parent folder of oldTgtPath, and replace all instances of OLD_managedTGT with managedTGT
				info("[IMM] Updating managed d3dx_user.ini projection.");

				try {
					const iniContent = await readD3DXUserIni();
					if (iniContent !== null) {
						const updatedContent = iniContent.split(OLD_managedTGT.toLowerCase()).join(managedTGT.toLowerCase());
						await writeManagedTextAsset("d3dxUserIni", "", updatedContent);
					}
				} catch (e) {
					error("Error updating d3dx_user.ini:", e);
				}
			}
			const oldSrcPath = join(src, OLD_managedSRC);
			const newSrcPath = join(src, managedSRC);
			if (await pathExistsNative(oldSrcPath)) {
				await guardedRename(oldSrcPath, newSrcPath);
				const targetEntries = (await readDirRecr(newTgtPath, "", 2)).flatMap((x) => x.children || []);
				info("[IMM] Fixing symlinks in target directory. Broken: ", targetEntries);
				for (const entry of targetEntries) {
					await invoke("set_managed_mod_enabled", {
						game: store.get(GAME),
						relativePath: entry.path,
						enabled: true,
					});
					info("[IMM] Rebuilt managed junction:", entry.path);
				}
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (message.startsWith("failed to rename old path")) {
				store.set(ERR, textData["v2.1.2Warning"]);
			} else {
				store.set(ERR, message);
			}
		}
		const modDir = join(src, managedSRC);
		const [modDirExists, isOldVersion] = await Promise.all([pathExistsNative(modDir), checkOldVerDirs(src)]);

		if (modDirExists) {
			await categorizeDir(modDir);
			status.skip = true;
		}
		if (isOldVersion) {
			await applyChanges(true);
			status.skip = true;
		}
		if (status.skip) throw new Error("Migration done, please verify the directories again");
		// const categories: Category[] = [
		// 	...store.get(CATEGORIES),
		// 	{ _sName: UNCATEGORIZED, _sIconUrl: "", _idRow: 0, _nItemCount: 0, _nCategoryCount: 0, _sUrl: "" },
		// ];
		const reqCategories: Record<string, DirEntry> = {};

		const srcEntries = await readDirNative(src);
		if (srcEntries.length === 0) {
			status.skip = true;
			await mkdirNative(modDir, true);
			throw new Error("Source directory is empty");
		}
		status.before = srcEntries
			.map((item) => ({
				name: item.name,
				isDirectory: item.isDirectory,
				children: [],
			}))
			.sort(sortMods)
			.filter((item) => item.name !== IGNORE || !item.isDirectory);

		const before = [...status.before].filter(
			(item) => item.isDirectory && item.name !== IGNORE && item.name !== managedTGT && item.name !== managedSRC
		);
		status.after = [
			{
				name: managedSRC,
				isDirectory: true,
				children: [],
			},
		];

		// Batch read directories for items that need it
		const readPromises: Promise<{
			item: DirEntry;
			entries: DirEntry[];
			category: Pick<Category, "_sName" | "_sIconUrl">;
		}>[] = [];
		for (const item of before) {
			info("[IMM] Processing directory structure item:", item.name);
			const searchResult = catDB?.search(item.name, { prefix: true, fuzzy: 0.2 })[0] as
				{ _sName?: string; _sIconUrl?: string } | undefined;
			const category =
				searchResult && searchResult._sName
					? { _sName: searchResult._sName, _sIconUrl: searchResult._sIconUrl || "" }
					: item.name === RESTORE || item.name === OLD_RESTORE
						? { _sName: RESTORE, _sIconUrl: "" }
						: { _sName: UNCATEGORIZED, _sIconUrl: "" };

			if ((item.isDirectory && item.name === category._sName) || item.name === OLD_RESTORE) {
				readPromises.push(
					readDirNative(join(src, item.name))
						.then((entries) => ({ item, entries, category }))
						.catch(() => {
							//console.error(`Error reading directory ${item.name}:`, error);
							return { item, entries: [], category };
						})
				);
			} else {
				// Add item directly without reading
				if (!reqCategories[category._sName]) {
					reqCategories[category._sName] = {
						name: category._sName,
						icon: category._sIconUrl,
						isDirectory: true,
						children: [],
					};
				}
				reqCategories[category._sName].children?.push({ name: item.name, isDirectory: item.isDirectory });
			}
		}

		// Process all read operations in parallel
		const readResults = await Promise.all(readPromises);
		for (const { entries, category } of readResults) {
			if (!reqCategories[category._sName]) {
				reqCategories[category._sName] = {
					name: category._sName,
					icon: category._sIconUrl,
					isDirectory: true,
					children: [],
				};
			}
			reqCategories[category._sName].children?.push(
				...entries.map((i: DirEntry) => ({ name: i.name, isDirectory: i.isDirectory }))
			);
		}
		status.map = { ...reqCategories };
		status.skip = Object.keys(reqCategories).length === 0;
		if (status.skip) throw new Error("No categories found, please verify the directories again");

		// Process modDir if it exists
		if (modDirExists) {
			try {
				const modDirEntries = await readDirNative(modDir);
				const modDirReadPromises: Promise<{ category: Pick<Category, "_sName" | "_sIconUrl">; entries: DirEntry[] }>[] =
					[];

				for (const item of modDirEntries) {
					if (!item.isDirectory) continue;

					const category =
						item.name === RESTORE
							? { _sName: RESTORE, _sIconUrl: "" }
							: (() => {
									const searchResult = catDB?.search(item.name, { prefix: true, fuzzy: 0.2 })[0] as
										{ _sName?: string; _sIconUrl?: string } | undefined;
									return searchResult && searchResult._sName
										? { _sName: searchResult._sName, _sIconUrl: searchResult._sIconUrl || "" }
										: { _sName: UNCATEGORIZED, _sIconUrl: "" };
								})();

					if (category) {
						modDirReadPromises.push(
							readDirNative(join(modDir, item.name))
								.then((entries) => ({ category, entries }))
								.catch(() => {
									//console.error(`Error reading modDir category ${item.name}:`, error);
									return { category, entries: [] };
								})
						);
					}
				}

				const modDirResults = await Promise.all(modDirReadPromises);
				for (const { category, entries } of modDirResults) {
					if (!reqCategories[category._sName]) {
						reqCategories[category._sName] = {
							name: category._sName,
							icon: category._sIconUrl || "",
							isDirectory: true,
							children: [],
						};
					}
					reqCategories[category._sName].children?.push(
						...entries.map((i) => ({ name: i.name, isDirectory: i.isDirectory }))
					);
				}
			} catch {
				warn("[IMM] Error processing managed mod directory entry.");
			}
		}
		for (const key of Object.keys(reqCategories)) {
			status.after[0].children?.push({
				...reqCategories[key],
				children: (reqCategories[key].children as DirEntry[]).sort(sortMods),
			});
		}
		status.after[0].children?.sort(sortMods);
		status.after.sort(sortMods);
	} catch (e) {
		info("[ERR] ", e);
	}
	info("[IMM] Directory structure verified:", status);
	return status;
}
export async function createManagedDir() {
	info("[IMM] Creating managed directories...");
	try {
		if (!src) return false;
		await mkdirNative(join(src, managedSRC), true);
		if (!tgt) return false;
		await mkdirNative(join(tgt, managedTGT), true);
		return true;
	} catch (err) {
		error("[IMM] Error creating managed directories:", err);
		throw err;
	}
}
export async function applyChanges(isMigration = false) {
	info("[IMM] Applying changes, isMigration:", isMigration);
	try {
		if (!src || !tgt) return false;

		const map: Record<string, DirEntry> = {};
		info("[IMM] Verifying directory structure before applying changes...");
		const target = join(tgt, managedTGT);
		if (!target) return true;
		info("[IMM] Target exists, creating managed directories...");
		await mkdirNative(join(src, managedSRC), true);
		await mkdirNative(join(tgt, managedTGT), true);
		info("[IMM] Managed directories created. Processing source directory...");
		await categorizeDir(src, true);

		const entries = (await readDirNative(src)).map((item) => item.name);

		info("[IMM] Processing entries:", entries);
		// Batch process entries
		for (const key of entries) {
			if (key === IGNORE || key === managedSRC || key === managedTGT || key === PREFS) continue;

			if (key === RESTORE || key === OLD_RESTORE) {
				try {
					await guardedRename(join(src, OLD_RESTORE), join(src, managedSRC, RESTORE));
				} catch {
					try {
						await copyDir(join(src, RESTORE), join(src, managedSRC, RESTORE));
					} catch (restoreCopyError) {
						warn("[IMM] Error handling RESTORE directory:", restoreCopyError);
					}
				}
				continue;
			}

			try {
				info(`[IMM] Renaming ${key} to managedSRC...`);
				await guardedRename(join(src, key), join(src, managedSRC, key));
			} catch (err) {
				error(`Error renaming ${key}:`, err);
				continue;
			}

			await mkdirNative(join(target, key), true);

			const dirEntries = (await readDirNative(join(src, managedSRC, key))) || map[key].children || [];
			// Batch process directory entries
			const itemOperations: Promise<void>[] = [];
			for (const item of dirEntries) {
				const isDisabled = item.name.startsWith("DISABLED");
				const name = replaceDisabled(item.name);
				if (isDisabled) {
					itemOperations.push(
						guardedRename(join(src, managedSRC, key, item.name), join(src, managedSRC, key, name)).catch(() => {
							//console.error(`Error renaming disabled item ${item.name}:`, error);
						})
					);
				} else {
					itemOperations.push(
						invoke<void>("set_managed_mod_enabled", {
							game: store.get(GAME),
							relativePath: join(key, name),
							enabled: true,
						})
					);
				}
			}
			await Promise.all(itemOperations);
		}
		return true;
	} catch (err) {
		error("[IMM] Error applying changes:", err);
		throw err;
	}
}
async function readDirRecr(root: string, path: string, maxDepth = 2, depth = 0, def = true): Promise<Mod[]> {
	if (depth > maxDepth) return [];
	let entries: DirEntry[] = [];
	try {
		entries = await readDirNative(join(root, path));
	} catch {
		return [];
	}
	const filePromises = entries.map(async (entry) => {
		if (store.get(GAME) === "NTE" && entry.name.startsWith(".") && entry.name.includes(".imm-")) return null;
		if (entry.name.startsWith(".") && entry.name.includes(".imm-delete-")) return null;
		if ((entry.name == RESTORE || entry.name == IGNORE || entry.name == PREFS) && def && depth == 0) return null;
		let children: Mod[] = [];
		if (entry.isDirectory) children = await readDirRecr(root, join(path, entry.name), maxDepth, depth + 1);
		return {
			isDir: entry.isDirectory,
			name: entry.name,
			parent: join(path),
			path: join(path, entry.name),
			keys: [],
			enabled: false,
			children,
			depth,
		};
	});
	const files = (await Promise.all(filePromises)).filter((file) => file !== null) as Mod[];
	return files.sort(sortMods);
}
export async function remSaveModData() {
	const modSrc = join(src, managedSRC);
	const entries = (await readDirRecr(modSrc, "", 1))
		.map((entry) => entry.children || [])
		.flat()
		.filter((child) => child.isDir);
	const data = store.get(DATA) || {};
	const promises = entries.map(async (entry) => {
		if (data[entry.path]) {
			const { viewedAt: _viewedAt, updatedAt: _updatedAt, ...modData } = data[entry.path];
			await writeManagedTextAsset("modMetadata", entry.path, JSON.stringify(modData, null, 2));
		}
	});
	await Promise.all(promises);
}
export async function remSavePresets() {
	const presets = store.get(PRESETS) || {};
	const promises = presets.map(async (preset) => {
		await writeManagedTextAsset("presetExport", preset.name, preset.data.join("\n"));
	});
	await Promise.all(promises);
}
export async function remMoveMods(categoryMode = true, enable = 0) {
	const allEntries = await readDirRecr(join(src, managedSRC), "", 1);
	const categories = allEntries
		.filter((entry) => entry.isDir && entry.children && entry.children.length > 0)
		.map((entry) => entry.name);
	if (categoryMode) {
		const categoryPromises = categories.map(async (category) => mkdir(join(tgt, category), { recursive: true }));
		await Promise.all(categoryPromises);
	}
	const entries = allEntries.map((entry) => entry.children || []).flat();
	const enabled = new Set(enable == 1 ? entries.map((entry) => entry.path) : []) as Set<string>;
	if (enable == 0) {
		const existsPromises = entries.map(async (entry) => {
			const targetPath = join(tgt, managedTGT, entry.path);
			if (await exists(targetPath)) {
				enabled.add(entry.path);
			}
		});
		await Promise.all(existsPromises);
	}
	const iniChanges: Record<string, string> = {};
	const movePromises = entries.map(async (entry) => {
		const srcPath = join(src, managedSRC, entry.path);
		const tgtPath = join(
			`${categoryMode ? entry.parent + "\\" : ""}${enabled.has(entry.path) ? "" : "DISABLED "}${entry.name}`
		);
		let finalTgt = tgtPath;
		let counter = 1;
		while (await exists(join(tgt, finalTgt))) {
			finalTgt = tgtPath + `_${counter}`;
			counter++;
		}
		await guardedRename(srcPath, join(tgt, finalTgt));
		if (enabled.has(entry.path)) {
			iniChanges[join("$\\mods", managedTGT, entry.path).toLowerCase()] = join("$\\mods", finalTgt).toLowerCase();
		}
	});
	await Promise.all(movePromises);
	// console.log("All entries moved. Updating d3dx_user.ini if needed...", iniChanges);
	try {
		const managedD3dx = await readD3DXUserIni();
		if (managedD3dx !== null) {
			let d3dx = managedD3dx;
			for (const [oldPath, newPath] of Object.entries(iniChanges)) {
				d3dx = d3dx.split(oldPath).join(newPath);
			}
			await writeManagedTextAsset("d3dxUserIni", "", d3dx);
		}
	} catch (e) {
		error("Error updating d3dx_user.ini:", e);
	}
	try {
		await guardedRemove(join(tgt, managedTGT), { recursive: true });
	} catch (removeTargetError) {
		warn("[IMM] Failed to remove managed target root after move:", removeTargetError);
	}
	const removeSrcPromises = allEntries.map(async (entry) => {
		try {
			await guardedRemove(join(src, managedSRC, entry.path));
		} catch (removeSourceError) {
			warn("[IMM] Failed to remove migrated source entry:", removeSourceError);
		}
	});
	await Promise.all(removeSrcPromises);
	try {
		await guardedRemove(join(src, managedSRC, RESTORE));
	} catch (removeRestoreError) {
		warn("[IMM] Failed to remove managed restore directory:", removeRestoreError);
	}
	try {
		await guardedRemove(join(src, managedSRC, PREFS));
	} catch (removePrefsError) {
		warn("[IMM] Failed to remove managed prefs directory:", removePrefsError);
	}
	try {
		await guardedRemove(join(src, managedSRC));
	} catch (removeManagedRootError) {
		warn("[IMM] Failed to remove managed source root:", removeManagedRootError);
	}
}
async function detectHotkeys(
	entries: Mod[],
	data: ModDataObj,
	src: string,
	depth = 0,
	def = true
): Promise<[Mod[], Set<string>, ModHotKeys[], string, Record<string, string>]> {
	let namespace = "";
	let namespaces = {} as Record<string, string>;
	const entryPromises = entries.map(async (entry) => {
		let hkData: ModHotKeys[] = [];
		let hashes = new Set<string>();
		try {
			// // Apply stored data to entry
			if (data[entry.path]) {
				for (const key of Object.keys(data[entry.path])) {
					const writableKey = key as "source" | "updatedAt" | "note";
					const nextValue = data[entry.path]?.[writableKey] || (writableKey === "updatedAt" ? 0 : "");
					if (writableKey === "updatedAt") {
						entry.updatedAt = Number(nextValue || 0);
					} else {
						entry[writableKey] = String(nextValue || "");
					}
				}
			}

			// Parse .ini files for hotkeys
			if (entry.name.endsWith(".ini")) {
				try {
					const file = await readTextFile(join(src, entry.path));
					const lines = file.split("\n");
					let counter = 0;
					let key = "";
					let type = "";
					let target = "";
					let values = "";
					let tempKey = "";
					let tempVal = "";
					let section = "";
					let fileNamespace = "";
					const globalVars: Record<string, ModHotKeys> = {};
					const fileData: Record<string, ModHotKeys> = {};
					for (const line of lines) {
						const ln = line
							.trim()
							.replaceAll(/[\r\n]+/g, "")
							.replaceAll(" ", "");
						if (ln.startsWith("[") && ln.endsWith("]")) {
							section = ln.slice(1, -1).toLowerCase();
						}
						if (ln.startsWith("namespace=")) {
							fileNamespace = ln.split("=")[1]?.trim() || "";
							namespace = namespace || fileNamespace.toLowerCase();
							// console.log("Detected namespace:", namespace);
							continue;
						}
						if (section === "constants" && ln.includes("global")) {
							const afterGlobal = ln.split("global")[1];
							if (!afterGlobal.includes("$")) continue;
							const afterDlr = afterGlobal.split("$")[1];
							if (!afterDlr.includes("=")) continue;
							try {
								[tempKey, tempVal] = ln
									.split("$")[1]
									.split("=")
									.map((part) => part.trim());
								if (Object.prototype.hasOwnProperty.call(fileData, tempKey)) {
									fileData[tempKey].default = tempVal;
								} else if (!Object.prototype.hasOwnProperty.call(globalVars, tempKey))
									globalVars[tempKey] = {
										target: tempKey,
										file: entry.path.split("\\").slice(2).join("\\").toLowerCase(),
										namespace: fileNamespace.toLowerCase(),
										name: tempKey,
										default: tempVal,
										pref: null,
										reset: null,
										key: "",
										type: "",
										values: ["unknown"],
									};
							} catch (globalParseError) {
								warn("[IMM] Failed to parse global constant mapping:", globalParseError);
							}
						}
						if (ln.startsWith("hash=")) {
							const val = line.split("=")[1]?.trim() || "";
							hashes.add(val);
						}
						if (counter === 0 && ln.startsWith("key=")) {
							key =
								line
									.split("=")[1]
									?.trim()
									.split(" ")
									.map((k) => {
										k = k.toLowerCase();
										if (k.startsWith("no_")) k = "";
										else {
											k = k.replace("vk_", "");
										}
										return k.trim();
									})
									.filter((k) => k)
									.join("+") || "";
							counter++;
						} else if (counter === 1 && ln.startsWith("type=")) {
							type = line.split("=")[1]?.trim() || "";
							counter++;
						} else if (counter === 2 && ln.startsWith("$")) {
							[target, values] = line.split("=").map((part) => part.trim());
							target = target?.slice(1) || "";
							counter = 0;
							if (!Object.prototype.hasOwnProperty.call(fileData, target))
								fileData[target] = {
									...(globalVars[target] || {
										target,
										file: entry.path.split("\\").slice(2).join("\\").toLowerCase(),
										name: target,
										namespace: fileNamespace.toLowerCase(),
										default: "",
										pref: null,
										reset: null,
									}),
									key,
									type,
									values:
										values
											.split(",")
											.map((v) => v.trim())
											.filter((v) => v) || "",
								};
							delete globalVars[target];
						}
					}

					hkData.push(...Object.values(fileData), ...Object.values(globalVars));
				} catch {
					//console.error(`Error parsing .ini file ${entry.name}:`, iniError);
				}
			}

			// Recursively process children
			if (entry.isDir && entry.children.length > 0) {
				try {
					if (depth == 1 && def) {
						const hashFile = await readTextFile(join(src, entry.path, ".imm-collision-checklist"));
						if (Math.random() < 0.1) throw new Error("Rechecking hashes for " + entry.path);
						hashes = new Set(
							hashFile
								.split("\n")
								.map((h) => h.trim())
								.filter((h) => h)
						);
					} else {
						throw new Error("Not depth 1");
					}
				} catch {
					const [updatedChildren, childHashes, childHK, namespace, newNamespaces] = await detectHotkeys(
						entry.children,
						data,
						src,
						depth + 1,
						def
					);
					hashes = new Set([...Array.from(hashes), ...Array.from(childHashes)]);
					entry.children = updatedChildren;
					if (childHK.length > 0 && depth > 0) {
						hkData = [...hkData, ...childHK];
					}
					if (depth == 1 && def) {
						await writeManagedTextAsset("collisionChecklist", entry.path, Array.from(hashes).join("\n"));
						if (namespace) namespaces[entry.path] = namespace;
					}
					if (depth < 2) {
						namespaces = { ...namespaces, ...newNamespaces };
					}
				}
			}
			if (depth == 1) {
				entry.keys = hkData;
				entry.hashes = Array.from(hashes);
			}
		} catch {
			//console.error(`Error processing entry ${entry.name}:`, entryError);
		}
		return { entry, hkData, hashes };
	});

	const results = await Promise.all(entryPromises);
	const processedEntries = results.map((r) => r.entry);
	const hotkeyData = depth < 2 ? [] : results.flatMap((r) => r.hkData);
	const hashes = new Set<string>(results.flatMap((r) => Array.from(r.hashes)));
	return [processedEntries, hashes, hotkeyData, namespace, namespaces];
}
export async function getModDetails(relPath: string) {
	const [category, modName] = relPath.split("\\");
	const modSrc = join(src, managedSRC);
	info("[IMM] Getting mod details for:", relPath, modSrc);
	try {
		const entries = await readDirRecr(modSrc, relPath, 5, 0, false);
		const new_entries = (
			await detectHotkeys(
				[
					{
						name: category,
						isDir: true,
						parent: "",
						path: category,
						keys: [],
						enabled: false,
						children: [
							{
								name: modName,
								isDir: true,
								parent: category,
								path: relPath,
								keys: [],
								enabled: false,
								children: entries,
								depth: 1,
								hashes: [],
							},
						],
						depth: 0,
						hashes: [],
					},
				],
				{},
				modSrc,
				0,
				false
			)
		)[0] as Mod[];
		const allVars = new_entries[0].children[0].keys || [];
		const keys = allVars.filter((v) => v.key);
		const files = {} as Record<string, ModHotKeys[]>;
		for (const varData of allVars) {
			if (!files[varData.file]) files[varData.file] = [];
			files[varData.file].push(varData);
		}
		Object.keys(files).forEach((file) => {
			files[file] = files[file].sort((a, b) => a.target.localeCompare(b.target));
		});
		return { keys, files };
	} catch {
		return { keys: [], files: {} };
	}
}
export async function refreshModList() {
	info("[IMM] Refreshing mod list...");
	const before = Date.now();
	try {
		const data = store.get(DATA);
		const isNte = store.get(GAME) === "NTE";
		const modSrc = join(src, managedSRC);
		const modTgt = isNte ? tgt : join(tgt, managedTGT);
		let categories = new Set([...store.get(CATEGORIES), { _sName: UNCATEGORIZED }].map((cat) => cat._sName));
		while (!isNte && categories.size < 10) {
			await new Promise((res) => setTimeout(res, 100));
			categories = new Set([...store.get(CATEGORIES), { _sName: UNCATEGORIZED }].map((cat) => cat._sName));
		}
		if (!isNte) await categorizeDir(modSrc);
		// console.log(await readDirRecr(modSrc, "", 3));
		const ret = await detectHotkeys(await readDirRecr(modSrc, "", 3), data, modSrc);
		const namespaces = ret[4];
		if (Object.keys(namespaces).length > 0) {
			store.set(DATA, (prev) => {
				Object.keys(namespaces).forEach((key) => {
					if (prev[key]) {
						prev[key].namespace = namespaces[key];
					}
				});
				return { ...prev };
			});
			saveConfigs();
		}
		let hasErr = "";
		const entries = (
			ret[0]
				.map((entry) =>
					categories.has(entry.name)
						? entry.children
						: (() => {
								hasErr = entry.name;
								return null;
							})()
				)
				.flat()
				.map((entry) => {
					if (entry && entry.depth == 1) entry.children = [];
					if (entry) {
						const allVars = entry.keys || [];
						const keys = allVars.filter((v) => v.key);
						const files = {} as Record<string, ModHotKeys[]>;
						for (const varData of allVars) {
							if (!files[varData.file]) files[varData.file] = [];
							files[varData.file].push(varData);
						}
						entry.keys = keys;
						entry.files = files;
					}
					return entry;
				})
				.filter((entry) => entry !== null && entry.depth < 2 && entry.name != ".imm-collision-checklist") as Mod[]
		).sort(sortMods);

		// const entries = (await readDirRecr(modSrc, "", 2))
		// 	.map((entry) =>
		// 		categories.has(entry.name)
		// 			? entry.children.map((entry) => {
		// 					if (data[entry.path]) {
		// 						for (const key of Object.keys(data[entry.path])) {
		// 							// ts-ignore-removed
		// 							entry[key as "source" | "updatedAt" | "note"] =
		// 								data[entry.path as keyof typeof data][key as "source" | "updatedAt" | "note"] ||
		// 								(key === "updatedAt" ? 0 : "");
		// 						}
		// 					}
		// 					return entry;
		// 				})
		// 			: (() =>{hasErr = entry.name; return null;})()
		// 	)
		// 	.flat()
		// 	.filter((entry) => entry!==null)
		// 	.sort(sortMods);
		if (hasErr) {
			addToast({ type: "error", message: textData._Toasts.UnableCat.replace("<item/>", hasErr) });
		}

		// Batch process entries - separate rename operations from exists checks
		const renameOperations: Promise<void>[] = [];
		const existsChecks: Promise<{ entry: Mod; enabled: boolean }>[] = [];

		for (const entry of entries) {
			if (entry.name.startsWith("DISABLED")) {
				const newName = replaceDisabled(entry.name);
				const newPath = join(entry.parent, newName);
				const renameOperation = isNte
					? invoke("rename_nte_mod", { relativePath: entry.path, newRelativePath: newPath })
					: guardedRename(join(modSrc, entry.path), join(modSrc, newPath));
				const trackedRename = renameOperation
					.then((result) => {
						const oldPath = entry.path;
						entry.name = newName;
						entry.path = newPath;
						if (isNte) {
							acceptNteOperationRevision(result);
							store.set(DATA, (prev) => {
								const next = { ...prev };
								if (next[oldPath]) {
									next[newPath] = { ...next[oldPath] };
									delete next[oldPath];
								}
								return next;
							});
							store.set(PRESETS, (prev) =>
								prev.map((preset) => ({
									...preset,
									data: preset.data.map((item) => (item === oldPath ? newPath : item)),
								}))
							);
						}
					})
					.catch(() => {
						//console.error(`Error renaming ${entry.name}:`, error);
					});
				if (isNte) await trackedRename;
				else renameOperations.push(trackedRename);
			}

			existsChecks.push(
				exists(join(modTgt, entry.path))
					.then((enabled) => ({ entry, enabled }))
					.catch(() => ({ entry, enabled: false }))
			);
		}

		// Wait for all renames to complete first
		await Promise.all(renameOperations);

		// Then process exists checks
		const existsResults = await Promise.all(existsChecks);
		for (const { entry, enabled } of existsResults) {
			entry.enabled = enabled;
		}
		beginPreviewGeneration(store.get(GAME));
		//info(recentlyDownloaded);
		info("[IMM] Mod list refreshed:", entries.length, "mods");
		info("[IMM] Mod list refresh took", Date.now() - before, "ms");
		return entries
			.filter((entry) => recentlyDownloaded.includes(entry.path))
			.concat(entries.filter((entry) => !recentlyDownloaded.includes(entry.path)));
	} catch (err) {
		error("[IMM] Error refreshing mod list:", err);
		throw err;
	}
}
export async function createModDownloadDir(cat: string, dir: string) {
	const target = await createModDownloadTarget(cat, dir);
	return target?.path;
}
function hashSegment(input: string) {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
	}
	return hash.toString(36).slice(0, 6) || "imm";
}
function shortenPathSegment(input: string, maxLength: number, fallback = "untitled") {
	const safeMax = Math.max(16, maxLength);
	let value = sanitizeFileName(input, { replacement: "_", defaultName: fallback, maxLength: safeMax });
	if (value.length <= safeMax) return value;
	const suffix = "_" + hashSegment(input);
	const head = Math.max(8, safeMax - suffix.length);
	value = `${value.slice(0, head)}${suffix}`;
	return sanitizeFileName(value, { replacement: "_", defaultName: fallback, maxLength: safeMax });
}
function sanitizeCategorySegments(category: string) {
	const parts = String(category || "")
		.split(/[\\/]+/)
		.map((part) => shortenPathSegment(part, 40, UNCATEGORIZED))
		.filter((part) => part && part !== ".");
	return parts.length ? parts : [UNCATEGORIZED];
}
export async function createModDownloadTarget(cat: string, dir: string) {
	try {
		if (!cat || !dir) return;
		const isNte = store.get(GAME) === "NTE";
		const categorySegments = sanitizeCategorySegments(cat);
		const categoryRoot = join(src, managedSRC, ...categorySegments);
		const remainingBudget = Math.max(24, Math.min(72, 160 - categoryRoot.length - 1));
		const safeDir = shortenPathSegment(dir, remainingBudget, "untitled");
		const relPath = join(...categorySegments, safeDir);
		const path = join(src, managedSRC, relPath);
		if (await exists(path))
			return {
				path,
				relPath,
				dirName: safeDir,
			};
		// The final Mod leaf is created by the native archive transaction. Only
		// prepare its trusted category parent here; a failed download must not
		// publish an empty Mod directory that looks installed.
		if (!isNte) await mkdir(categoryRoot, { recursive: true });
		return {
			path,
			relPath,
			dirName: safeDir,
		};
	} catch (err) {
		error("[IMM] Error creating mod download directory:", err);
		throw err;
	}
}
export async function validateModDownload(path: string, skip = false) {
	try {
		const entries = await readDir(path);
		// const previewCount = entries.filter((entry) => entry.name.startsWith("preview.") && !entry.isDirectory).length;
		const txtCount = entries.filter((entry) => entry.name.endsWith(".txt") && !entry.isDirectory).length;
		const imgCount = entries.filter((entry) => {
			const ext = entry.name.split(".").slice(-1)[0].toLowerCase();
			return exts.includes(ext) && !entry.isDirectory;
		}).length;
		if (entries.length - txtCount - imgCount === 1) {
			let hasIni = false;
			const dirs: string[] = [];

			for (const entry of entries) {
				if (entry.name.endsWith(".ini")) hasIni = true;
				if (entry.isDirectory) dirs.push(entry.name);
			}

			if (!hasIni && dirs.length === 1) {
				const uuid = "IMM_TEMP_" + Math.floor(Math.random() * 1000000000);
				const tempPath = path + "\\" + uuid;
				const dirPath = path + "\\" + dirs[0];

				try {
					await guardedRename(dirPath, tempPath);
					await copyDir(tempPath, path);
					await guardedRemove(tempPath, { recursive: true });
				} catch (err) {
					error("[IMM] Error flattening mod directory structure:", err);
				}
			}
		}
		if (!skip) {
			const list = store.get(MOD_LIST);
			const normalizedPath = String(path || "").replaceAll("/", "\\");
			const marker = managedSRC + "\\";
			const relPath = normalizedPath.includes(marker) ? normalizedPath.split(marker).slice(1).join(marker) : "";
			info("[IMM] Validating mod download for path:", relPath);
			if (store.get(GAME) === "NTE" && relPath && (await exists(join(tgt, relPath)))) {
				if (!(await toggleMod(relPath, true))) {
					throw new Error("Unable to deploy the updated NTE Mod.");
				}
			}
			const ele = list.find((mod) => mod.path === relPath);
			if (ele) {
				const keys = ele.keys || [];
				const files: Record<string, Record<string, string>> = {};
				for (const hk of keys) {
					if (!files[hk.file]) files[hk.file] = {};
					if (hk.default) files[hk.file][hk.target] = hk.default;
				}
				const promises: Promise<boolean>[] = [];
				Object.keys(files).forEach((file) => {
					if (Object.keys(files[file]).length > 0) {
						promises.push(updateIniVars(join(relPath, file), files[file]));
					}
				});
				await Promise.all(promises);
			}
			const downloads = store.get(DOWNLOAD_LIST);
			const completed = downloads.completed.length + 1;
			const total =
				completed +
				downloads.queue.length +
				downloads.downloading.length +
				downloads.extracting.length +
				downloads.failed.length;
			addToast({ type: "success", message: `${textData._Toasts.DownloadComplete} (${completed}/${total})` });
		}
	} catch (err) {
		if (!skip) addToast({ type: "error", message: textData._Toasts.ErrDownload });
		error("[IMM] Error validating mod download:", err);
		return false;
	}
	return true;
}
export async function cleanCancelledDownload(path: string) {
	try {
		if (!(await exists(path))) return;
		const entries = await readDir(path);
		const hasPreview = entries.filter((entry) => entry.name.startsWith("preview.") && !entry.isDirectory).length;
		const hasArchive = entries.filter(
			(entry) =>
				entry.name.endsWith(".zip") ||
				entry.name.endsWith(".rar") ||
				entry.name.endsWith(".7z") ||
				entry.name.endsWith(".part")
		).length;
		if (entries.length === hasPreview + hasArchive && hasArchive <= 1 && hasPreview <= 1) {
			await guardedRemove(path, { recursive: true });
		}
	} catch (err) {
		error("[IMM] Error cleaning cancelled download:", err);
	}
}
export async function changeModName(path: string, newPath: string, add = false) {
	const isNte = store.get(GAME) === "NTE";
	if (isNte) {
		if (add) throw new Error("NTE unmanaged imports must be installed through the native archive workflow.");
		const result = await invoke("rename_nte_mod", { relativePath: path, newRelativePath: newPath });
		acceptNteOperationRevision(result);
		store.set(DATA, (prev) => {
			const next = { ...prev };
			if (next[path]) {
				next[newPath] = { ...next[path] };
				delete next[path];
			}
			return next;
		});
		store.set(PRESETS, (prev) =>
			prev.map((preset) =>
				preset.data.includes(path)
					? { ...preset, data: [...preset.data.filter((item) => item !== path), newPath] }
					: preset
			)
		);
		info("[IMM] NTE Mod name changed from", path, "to", newPath);
		return newPath;
	}
	const modTgt = join(tgt, managedTGT, path);
	const oldSource = add ? join(src, path) : join(src, managedSRC, path);
	const newSource = join(src, managedSRC, newPath);
	let wasEnabled = false;
	try {
		wasEnabled = !add && (await exists(modTgt));
		if (wasEnabled && !(await toggleMod(path, false))) {
			throw new Error("Unable to disable mod before rename.");
		}
		await mkdir(join(src, managedSRC, ...newPath.split("\\").slice(0, -1)), { recursive: true });
		await guardedRename(oldSource, newSource);
		store.set(DATA, (prev) => {
			const next = { ...prev };
			if (next[path]) {
				next[newPath] = { ...next[path] };
				delete next[path];
			}
			return next;
		});
		store.set(PRESETS, (prev) =>
			prev.map((preset) =>
				preset.data.includes(path)
					? { ...preset, data: [...preset.data.filter((item) => item !== path), newPath] }
					: preset
			)
		);
		await saveConfigs();
		info("[IMM] Mod name changed from", path, "to", newPath);
		if (!isNte) await updatePrefsIniFromData(newPath, path);
		if (!isNte && (add || wasEnabled) && !(await toggleMod(newPath, true))) {
			throw new Error("Unable to enable mod after rename.");
		}
		return newPath;
	} catch (err) {
		error("[IMM] Error changing mod name:", err);
		throw err;
	}
}
export async function deleteCategory(cat: string) {
	const path = join(src, managedSRC, cat);
	if (!(await exists(path))) return true;
	try {
		if (store.get(GAME) === "NTE") {
			const modPaths = store
				.get(MOD_LIST)
				.filter((mod) => mod.parent === cat || mod.path.startsWith(cat + "\\"))
				.map((mod) => mod.path);
			for (const modPath of modPaths) await deleteMod(modPath);
		}
		await guardedRemove(path);
		return true;
	} catch (err) {
		error("[IMM] Error deleting category:", err);
		return false;
	}
}
export async function deleteRestorePoint(point: string) {
	try {
		const path = join(modRoot, RESTORE, point);
		await guardedRemove(path, { recursive: true });
		addToast({ type: "success", message: textData._Toasts.Deleted });
		return true;
	} catch (err) {
		error("[IMM] Error deleting restore point:", err);
		addToast({ type: "error", message: textData._Toasts.ErrOcc });
		return false;
	}
}
export async function deleteMod(path: string) {
	const isNte = store.get(GAME) === "NTE";
	const modSrc = join(src, managedSRC, path);
	const modTgt = isNte ? join(tgt, path) : join(tgt, managedTGT, path);

	if (isNte) {
		try {
			const result = await invoke("delete_nte_mod", {
				relativePath: path,
			});
			acceptNteOperationRevision(result);
			store.set(DATA, (prev) => {
				const next = { ...prev };
				delete next[path];
				return next;
			});
			store.set(PRESETS, (prev) =>
				prev.map((preset) => ({ ...preset, data: preset.data.filter((item) => item !== path) }))
			);
			addToast({ type: "success", message: textData._Toasts.Deleted });
			return;
		} catch (err) {
			error("[IMM] Error deleting NTE mod:", err);
			addToast({ type: "error", message: textData._Toasts.ErrOcc });
			throw err;
		}
	}

	try {
		await guardedRemove(modTgt);
	} catch (err) {
		error("[IMM] Error removing mod target:", err);
	}

	try {
		await guardedRemove(modSrc, { recursive: true });
		addToast({ type: "success", message: textData._Toasts.Deleted });
	} catch (err) {
		error("[IMM] Error removing mod source:", err);
		addToast({ type: "error", message: textData._Toasts.ErrOcc });
		throw err;
	}
}
function getTrackedMods(modPaths: string[]) {
	const data = store.get(DATA);
	const modList = store.get(MOD_LIST);
	const namespaces = new Map(modList.map((mod) => [mod.path, mod.namespace || ""]));
	return modPaths.map((modPath) => ({
		path: modPath,
		namespace: data[modPath]?.namespace || namespaces.get(modPath) || "",
	}));
}
export async function syncIniStateFromD3DXIni(
	modPaths?: string | string[],
	options: {
		persist?: boolean;
		rewritePrefs?: boolean;
		clearPrefsBeforeSync?: boolean;
		targetPath?: string;
	} = {}
) {
	const mods = (Array.isArray(modPaths) ? modPaths : modPaths ? [modPaths] : store.get(MOD_LIST).map((mod) => mod.path))
		.map((modPath) => String(modPath || "").trim())
		.filter((modPath) => modPath);
	if (!mods.length) return [] as string[];

	if (options.targetPath && normalizeManagedAbsolutePath(options.targetPath) !== normalizeManagedAbsolutePath(tgt)) {
		throw new Error("INI state sync target no longer matches the persisted game target.");
	}
	const rawIni = await readD3DXUserIni();
	if (rawIni === null) return [] as string[];
	if (options.clearPrefsBeforeSync) {
		await Promise.all(
			mods.map((modPath) => guardedRemove(join(tgt, managedTGT, PREFS, modPath + ".ini")).catch(() => undefined))
		);
	}
	const trackedMods = getTrackedMods(mods);
	const { nextData, changedMods } = syncIniStateFromText(rawIni, store.get(DATA), trackedMods, managedTGT);
	if (!changedMods.length) return changedMods;
	store.set(DATA, nextData);
	if (options.rewritePrefs !== false) {
		await Promise.all(changedMods.map((modPath) => updatePrefsIniFromData(modPath)));
	}
	if (options.persist !== false) {
		await saveConfigs();
	}
	info("[IMM] Updated runtime ini state for mods:", changedMods);
	return changedMods;
}
export async function updatePrefsIniFromData(modPath: string, oldPath = "") {
	const data = store.get(DATA)[modPath];
	if (!data || !data.vars) return;
	if (oldPath) {
		const oldRoot = join(tgt, managedTGT, PREFS, oldPath);
		if (!(await exists(oldRoot))) return;
		await writeManagedTextAsset(
			"modPreference",
			modPath,
			(await readTextFile(oldRoot)).split(oldPath.toLowerCase()).join(modPath.toLowerCase())
		);
		await guardedRemove(oldRoot);
	} else {
		const lines = {} as Record<string, string>;
		for (const key of Object.keys(data.vars)) {
			for (const Var of Object.keys(data.vars[key])) {
				const x = data.vars[key][Var] as { pref?: string; state?: string };
				const line =
					`$\\${key == "namespace" ? data.namespace : `mods\\${managedTGT}\\${modPath}\\${key}`}\\${Var}`.toLowerCase();
				lines[line] = x.pref ?? x.state ?? "";
				if (lines[line] === undefined || lines[line] === null || lines[line] === "") delete lines[line];
				else info(`[IMM] Updating Mod: ${modPath} | File: ${key} | Added Line: ${line}`);
			}
		}
		await writeManagedTextAsset(
			"modPreference",
			modPath,
			[
				";-- set by imm --",
				"[constants]",
				...Object.entries(lines).map(([key, value]) => `${key}=${value}`),
				";-- end imm --",
			].join("\n")
		);
	}
}
export async function updateIniVars(relPath: string, keyVals: Record<string, string>) {
	const path = join(modRoot, relPath);
	info("[IMM] Updating ini vars for:", relPath, path);
	if (!(await exists(path + ".bak"))) {
		await guardedCopyFile(path, path + ".bak");
	}
	const file = await readTextFile(path);
	const lines = file.split("\n");
	try {
		let section = "";
		for (let i = 0; i < lines.length; i++) {
			const ln = lines[i]
				.trim()
				.replaceAll(/[\r\n]+/g, "")
				.replaceAll(" ", "");
			if (ln.startsWith("[") && ln.endsWith("]")) {
				section = ln.slice(1, -1).toLowerCase();
			}
			if (section === "constants" && ln.includes("$") && ln.includes("=")) {
				const modKey = ln.split("$")[1].split("=")[0].trim().toLowerCase();
				if (Object.prototype.hasOwnProperty.call(keyVals, modKey)) {
					lines[i] = `${lines[i].split("=")[0]}= ${keyVals[modKey]}`;
					info(`[IMM] Updating Mod: ${path} | Line${i}: ${lines[i]}`);
				}
				delete keyVals[modKey];
				if (Object.keys(keyVals).length === 0) break;
			}
		}
	} catch {
		return false;
	}
	await writeManagedTextAsset("modIni", relPath, lines.join("\n"));
	return true;
}
export function openFile(relPath: string) {
	return openManagedFolder("source", join(managedSRC, relPath));
}

export function openManagedFolder(rootKind: "source" | "target", relativePath = "") {
	return invoke<void>("open_managed_folder", {
		game: store.get(GAME),
		rootKind,
		relativePath,
	});
}
export async function toggleMod(path: string, enabled: boolean, forced = false): Promise<boolean> {
	info("[IMM] Togglingx mod:", path, "Enabled:", enabled);
	try {
		if (store.get(GAME) === "NTE") {
			await invoke("set_nte_mod_enabled", {
				relativePath: path,
				enabled,
			});
			return true;
		}

		if (enabled) {
			await updatePrefsIniFromData(path);
			if (forced) return true;
		} else {
			await syncIniStateFromD3DXIni(path, {
				rewritePrefs: false,
				clearPrefsBeforeSync: true,
			});
		}
		await invoke("set_managed_mod_enabled", {
			game: store.get(GAME),
			relativePath: path,
			enabled,
		});
	} catch (err) {
		error("[IMM] Error toggling mod:", err);
		return false;
	}
	info(`[IMM] Success mod ${enabled ? "enabled" : "disabled"}:`, path);
	return true;
}
export async function savePreviewImageFromData(relPath: string, type: string, data: Uint8Array) {
	const game = store.get(GAME);
	info("[IMM] Saving managed preview image for:", game, relPath);
	await invoke("save_managed_preview_data", {
		game,
		relativePath: relPath,
		extension: type,
		data: Array.from(data),
	});
	try {
		await updatePreviewAsset(game, relPath);
	} catch (previewError) {
		warn("[IMM] Unable to update the local preview cache:", previewError);
	}
	if (store.get(GAME) !== game) return;
	store.set(LAST_UPDATED, Date.now());
	store.set(DATA, (prev) => {
		if (!prev[relPath]) return prev;
		delete prev[relPath].crop;
		return { ...prev };
	});
	store.set(MOD_LIST, (prev) => {
		return prev.map((mod) => {
			if (mod.path === relPath) {
				delete mod.crop;
			}
			return mod;
		});
	});
	await saveConfigs();

	addToast({ type: "success", message: textData._Toasts.ImgSaved });
}
export async function savePreviewImage(relPath: string) {
	try {
		const game = store.get(GAME);
		const file = await open({
			multiple: false,
			directory: false,
			filters: [{ name: "Image", extensions: exts }],
		});

		if (!file) return false;
		await invoke("import_managed_preview_file", {
			game,
			relativePath: relPath,
			sourcePath: file,
		});
		try {
			await updatePreviewAsset(game, relPath);
		} catch (previewError) {
			warn("[IMM] Unable to update the local preview cache:", previewError);
		}
		if (store.get(GAME) !== game) return true;
		store.set(LAST_UPDATED, Date.now());
		addToast({ type: "success", message: textData._Toasts.ImgSaved });
	} catch {
		//console.error("Error saving preview image:", error);
		addToast({ type: "error", message: textData._Toasts.ErrOcc });
		return false;
	}
	return true;
}
export async function applyPreset(data: string[], name = "") {
	try {
		const isNte = store.get(GAME) === "NTE";
		const presetTarget = isNte ? tgt : join(tgt, managedTGT);
		const entries = (await readDirRecr(presetTarget, "", 2)).flatMap((x) => x.children || []);
		const disablePromises: Promise<boolean>[] = entries.map((entry) => toggleMod(entry.path, false));
		const disableResults = await Promise.all(disablePromises);
		if (disableResults.some((result) => !result)) {
			throw new Error("Unable to disable every Mod in the preset target.");
		}
		if (!isNte) {
			await guardedRemove(presetTarget, { recursive: true });
			await mkdir(presetTarget, { recursive: true });
		}

		// Apply mods in parallel batches to improve performance
		const batchSize = 10;
		for (let i = 0; i < data.length; i += batchSize) {
			const batch = data.slice(i, i + batchSize);
			const enableResults = await Promise.all(
				batch.map((mod) =>
					toggleMod(mod, true).catch((err = "unknown") => {
						error(`[IMM] Error toggling mod ${mod}:`, err);
						return false;
					})
				)
			);
			if (enableResults.some((result) => !result)) {
				throw new Error("Unable to enable every Mod in the preset.");
			}
		}
		if (name) {
			addToast({ type: "success", message: textData._Toasts.PresetApplied });
		}
	} catch (err) {
		error("[IMM] Error applying preset:", err);
		if (name) addToast({ type: "error", message: textData._Toasts.ErrOcc });
		throw err;
	}
}

export async function installFromArchives(archives: string[]) {
	// const categories = store.get(CATEGORIES).map((cat) => cat._sName);
	let success = 0;
	async function extractArchive(archive: string) {
		if (!archive) return;
		const isNte = store.get(GAME) === "NTE";
		const archiveName = archive.split("\\").pop() || "";
		const [name] = archiveName.split(".");
		const root = join(src, managedSRC, UNCATEGORIZED);
		if (!isNte) await mkdir(root, { recursive: true });
		let counter = 0;
		let finalName = name;
		while (await exists(join(root, finalName))) {
			finalName = `${name} (${++counter})`;
		}
		const dest = join(root, finalName);
		if (!isNte) await mkdir(dest, { recursive: true });
		try {
			info("[IMM] Extracting archive:", archive, "to", dest);
			const element = {
				status: "extracting",
				addon: false,
				preview: "",
				name: finalName,
				path: UNCATEGORIZED + "\\" + finalName,
				source: "",
				file: archive,
				fname: archiveName,
				category: UNCATEGORIZED,
				updated: 0,
				updatedAt: 0,
				dlPath: dest,
				key: `${finalName}_${archiveName}_${finalName}_0`,
			} as DownloadItem;
			store.set(DOWNLOAD_LIST, (prev) => {
				prev.extracting.push(element);
				return { ...prev };
			});
			if (element.key) addToExtracts(element.key, element);
			await invoke("extract_archive", {
				filePath: archive,
				savePath: dest,
				fileName: name,
				del: false,
				emit: true,
				key: element.key,
				currentSid: 999,
				game: store.get(GAME),
			});
			info("[IMM] Archive extracted:", archive);
			// await validateModDownload(dest, true);
			success++;
		} catch (err) {
			error("[IMM] Error extracting archive:", err);
			addToast({ type: "error", message: textData._Toasts.ErrInstall.replace("<item/>", name) });
		}
	}
	const extractPromises = archives.map((archive) => extractArchive(archive));
	await Promise.all(extractPromises);
	addToast({
		type: "success",
		message: textData._Toasts.SuccessInstall.replace("<success/>", success.toString()).replace(
			"<total/>",
			archives.length.toString()
		),
	});
}
