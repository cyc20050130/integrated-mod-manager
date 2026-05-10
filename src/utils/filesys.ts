import defConfig from "../default.json";
import {
	exists as fsExists,
	mkdir as fsMkdir,
	readDir as fsReadDir,
	readTextFile as fsReadTextFile,
	rename,
	writeFile,
	writeTextFile as fsWriteTextFile,
} from "@tauri-apps/plugin-fs";
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
	LAST_UPDATED,
	MOD_LIST,
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
	Preset,
	Settings,
} from "./types";
import { openPath } from "@tauri-apps/plugin-opener";
import { error, info, warn } from "@/lib/logger";
import { addToExtracts } from "@/_LeftSidebar/components/Downloads";
import { normalizeDownloadList, withNormalizedDownloadSettings } from "./downloads";
import { syncIniStateFromText } from "./iniStateSyncCore.js";
export async function setGame(game: string) {
	try {
		const config = await readTextFile(`config.json`);
		const parsedConfig = JSON.parse(config);
		parsedConfig.game = game;
		await writeTextFile(`config.json`, JSON.stringify(parsedConfig, null, 2));
		return true;
	} catch {
		try {
			if (!(await exists(`config.json`))) {
				await writeTextFile(`config.json`, JSON.stringify({ ...defConfig, game }, null, 2));
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

function shouldUseNativePath(path: string) {
	return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}
async function exists(path: string) {
	if (shouldUseNativePath(path)) return pathExistsNative(path);
	try {
		return await fsExists(path);
	} catch (err) {
		info("[IMM] plugin fs exists() failed, using native fallback:", path, err);
		return pathExistsNative(path);
	}
}
async function mkdir(path: string, options: { recursive?: boolean } = {}) {
	if (shouldUseNativePath(path)) return mkdirNative(path, Boolean(options.recursive));
	try {
		return await fsMkdir(path, options);
	} catch (err) {
		info("[IMM] plugin fs mkdir() failed, using native fallback:", path, err);
		return mkdirNative(path, Boolean(options.recursive));
	}
}
async function readDir(path: string) {
	if (shouldUseNativePath(path)) return readDirNative(path);
	try {
		return await fsReadDir(path);
	} catch (err) {
		info("[IMM] plugin fs readDir() failed, using native fallback:", path, err);
		return readDirNative(path);
	}
}
async function readTextFile(path: string) {
	if (shouldUseNativePath(path)) return readTextFileNative(path);
	try {
		return await fsReadTextFile(path);
	} catch (err) {
		info("[IMM] plugin fs readTextFile() failed, using native fallback:", path, err);
		return readTextFileNative(path);
	}
}
async function writeTextFile(path: string, contents: string) {
	if (shouldUseNativePath(path)) return writeTextFileNative(path, contents);
	try {
		return await fsWriteTextFile(path, contents);
	} catch (err) {
		info("[IMM] plugin fs writeTextFile() failed, using native fallback:", path, err);
		return writeTextFileNative(path, contents);
	}
}

const sp = [UNCATEGORIZED, IGNORE, OLD_RESTORE];
let recentlyDownloaded: string[] = [];
store.sub(DOWNLOAD_LIST, () => {
	recentlyDownloaded = store.get(DOWNLOAD_LIST).completed.map((item) => item.path).filter((path): path is string => Boolean(path));
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
	await writeTextFile(`config${curConfig.game}.json`, JSON.stringify(config, null, 2));
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
	const promises: Promise<void>[] = [writeTextFile("config.json", JSON.stringify(config, null, 2))];
	if (config.game && !skip) {
		promises.push(writeTextFile(`config${config.game}.json`, JSON.stringify(gameConfig, null, 2)));
	}
	await Promise.all(promises);
}
export async function saveConfigs(skip = false, settings = store.get(SETTINGS)) {
	info("[IMM] Saving configs...");
	if (!isAppInitialized()) return;
	await persistConfigs({ settings }, skip);
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
type GuardedPathOptions = {
	allowedRoots?: string[];
	includeDefaultRoots?: boolean;
	recursive?: boolean;
};
function getGuardedFileRoots(extraRoots: string[] = [], includeDefaultRoots = true) {
	const defaultRoots = includeDefaultRoots ? [src, modRoot, tgt] : [];
	const roots = [...defaultRoots, ...extraRoots]
		.map((root) => String(root || "").trim())
		.filter(Boolean);
	return Array.from(new Set(roots));
}
export async function guardedRemove(path: string, options: GuardedPathOptions = {}) {
	const allowedRoots = getGuardedFileRoots(options.allowedRoots, options.includeDefaultRoots !== false);
	return invoke<void>("guarded_remove_path", {
		path,
		allowedRoots,
		recursive: Boolean(options.recursive),
	});
}
export async function guardedRename(
	from: string,
	to: string,
	options: Pick<GuardedPathOptions, "allowedRoots" | "includeDefaultRoots"> = {}
) {
	const allowedRoots = getGuardedFileRoots(options.allowedRoots, options.includeDefaultRoots !== false);
	return invoke<void>("guarded_rename_path", {
		from,
		to,
		allowedRoots,
	});
}
export async function guardedCopyFile(
	from: string,
	to: string,
	options: Pick<GuardedPathOptions, "allowedRoots" | "includeDefaultRoots"> = {}
) {
	const allowedRoots = getGuardedFileRoots(options.allowedRoots, options.includeDefaultRoots !== false);
	return invoke<void>("guarded_copy_file_path", {
		from,
		to,
		allowedRoots,
	});
}
export async function guardedImportFile(
	from: string,
	to: string,
	options: Pick<GuardedPathOptions, "allowedRoots" | "includeDefaultRoots"> = {}
) {
	const allowedRoots = getGuardedFileRoots(options.allowedRoots, options.includeDefaultRoots !== false);
	return invoke<void>("guarded_import_file_path", {
		from,
		to,
		allowedRoots,
	});
}
async function pathExistsNative(path: string) {
	try {
		return await invoke<boolean>("path_exists_native", { path });
	} catch (err) {
		info("[IMM] native exists() check failed:", path, err);
		return false;
	}
}
async function readDirNative(path: string) {
	return invoke<DirEntry[]>("read_dir_native", { path });
}
async function readTextFileNative(path: string) {
	return invoke<string>("read_text_file_native", { path });
}
async function writeTextFileNative(path: string, contents: string) {
	return invoke<void>("write_text_file_native", { path, contents });
}
async function mkdirNative(path: string, recursive = true) {
	return invoke<void>("mkdir_native", { path, recursive });
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
	const configs = ["", "WW", "ZZ", "GI", "SR", "EF"];
	for (const cfg of configs) {
		try {
			await rename(`config${cfg}.json`, `backups/MAN_${Date.now()}_config${cfg}.json.bak`);
		} catch (backupError) {
			warn(`[IMM] Skipping missing or locked config backup for ${cfg || "default"}:`, backupError);
		}
	}
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
	const entries = (await readDirRecr(path, "", 2)).map((entry: Mod) => {
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
		title: "Restoring from " + name,
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
			await guardedRemove(join(modRoot), { allowedRoots: [src], includeDefaultRoots: false });
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
	const d3dx_path = join(...tgt.split("\\").slice(0, -1), "d3dx_user.ini");
	let d3dx = "";
	try {
		info("[IMM] Reading d3dx_user.ini...", await pathExistsNative(d3dx_path));
		const targetParent = join(...tgt.split("\\").slice(0, -1));
		const backupPath = join(targetParent, `d3dx_user_pre_imm.ini.bak`);
		if (!(await pathExistsNative(backupPath))) {
			await guardedCopyFile(d3dx_path, backupPath, { allowedRoots: [targetParent], includeDefaultRoots: false });
		}
		if (modifyIni) d3dx = await readTextFileNative(d3dx_path);
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
			await writeTextFileNative(d3dx_path, d3dxLines.join("\n"));
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
				const parentDir = tgt.split("\\").slice(0, -1).join("\\");
				const iniPath = join(parentDir, "d3dx_user.ini");
				info("[IMM] Updating d3dx_user.ini at:", iniPath);

				try {
					if (await pathExistsNative(iniPath)) {
						const iniContent = await readTextFileNative(iniPath);
						const updatedContent = iniContent.split(OLD_managedTGT.toLowerCase()).join(managedTGT.toLowerCase());
						await writeTextFileNative(iniPath, updatedContent);
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
					const linkPath = join(newTgtPath, entry.path);
					await guardedRemove(linkPath);
					await mkdirNative(join(newTgtPath, entry.parent), true);
					try {
						await invoke("create_symlink", {
							linkPath: linkPath,
							targetPath: join(newSrcPath, entry.path),
						});
						info("[IMM] Fixed symlink:", linkPath, "->", join(newSrcPath, entry.path));
					} catch (err) {
						error("[IMM] Error creating symlink:", err);
					}
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
		const readPromises: Promise<{ item: DirEntry; entries: DirEntry[]; category: Pick<Category, "_sName" | "_sIconUrl"> }>[] = [];
		for (const item of before) {
			info("[IMM] Processing directory structure item:", item.name);
			const searchResult = catDB?.search(item.name, { prefix: true, fuzzy: 0.2 })[0] as
				| { _sName?: string; _sIconUrl?: string }
				| undefined;
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
				const modDirReadPromises: Promise<{ category: Pick<Category, "_sName" | "_sIconUrl">; entries: DirEntry[] }>[] = [];

				for (const item of modDirEntries) {
					if (!item.isDirectory) continue;

					const category =
						item.name === RESTORE
							? { _sName: RESTORE, _sIconUrl: "" }
							: (() => {
									const searchResult = catDB?.search(item.name, { prefix: true, fuzzy: 0.2 })[0] as
										| { _sName?: string; _sIconUrl?: string }
										| undefined;
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
						invoke<void>("create_symlink", {
							linkPath: join(target, key, name),
							targetPath: join(src, managedSRC, key, name),
						}).catch(() => {
							//console.error(`Error creating symlink for ${name}:`, error);
						}) as Promise<void>
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
		const modPath = join(modSrc, entry.path, "mod.json");

		if (data[entry.path]) {
			const modData = data[entry.path];
			delete modData.viewedAt;
			delete modData.updatedAt;
			await writeTextFile(modPath, JSON.stringify(modData, null, 2));
		}
	});
	await Promise.all(promises);
}
export async function remSavePresets() {
	const presets = store.get(PRESETS) || {};
	const presetFolder = join(tgt, "Presets");
	await mkdir(presetFolder, { recursive: true });
	const promises = presets.map(async (preset) => {
		const presetPath = join(presetFolder, `${preset.name}.txt`);
		await writeTextFile(presetPath, preset.data.join("\n"));
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
		while (await exists(finalTgt)) {
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
	const d3dxPath = join(...tgt.split("\\").slice(0, -1), "d3dx_user.ini");
	try {
		if (await exists(d3dxPath)) {
			let d3dx = await readTextFile(d3dxPath);
			for (const [oldPath, newPath] of Object.entries(iniChanges)) {
				d3dx = d3dx.split(oldPath).join(newPath);
			}
			await writeTextFile(d3dxPath, d3dx);
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
		await guardedRemove(join(src, managedSRC), { allowedRoots: [src], includeDefaultRoots: false });
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
						writeTextFile(join(src, entry.path, ".imm-collision-checklist"), Array.from(hashes).join("\n"));
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
		const modSrc = join(src, managedSRC);
		const modTgt = join(tgt, managedTGT);
		let categories = new Set([...store.get(CATEGORIES), { _sName: UNCATEGORIZED }].map((cat) => cat._sName));
		while (categories.size < 10) {
			await new Promise((res) => setTimeout(res, 100));
			categories = new Set([...store.get(CATEGORIES), { _sName: UNCATEGORIZED }].map((cat) => cat._sName));
		}
		await categorizeDir(modSrc);
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

				renameOperations.push(
					guardedRename(join(modSrc, entry.path), join(modSrc, newPath))
						.then(() => {
							entry.name = newName;
							entry.path = newPath;
						})
						.catch(() => {
							//console.error(`Error renaming ${entry.name}:`, error);
						})
				);
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
		//info(recentlyDownloaded);
		info(
			"[IMM] Mod list refreshed:",
			entries.map((e) => ({ path: e.path, enabled: e.enabled }))
		);
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
		await mkdir(path, { recursive: true });
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
	try {
		const enabled = add || (await toggleMod(path, false));
		await mkdir(join(src, managedSRC, ...newPath.split("\\").slice(0, -1)), { recursive: true });
		await guardedRename(add ? join(src, path) : join(src, managedSRC, path), join(src, managedSRC, newPath));
		store.set(DATA, (prev) => {
			if (prev[path]) {
				prev[newPath] = { ...prev[path] };
				delete prev[path];
			}
			return prev;
		});
		store.set(PRESETS, (prev) => {
			for (let i = 0; i < prev.length; i++) {
				if (prev[i].data.includes(path)) {
					prev[i].data = prev[i].data.filter((p) => p !== path);
					prev[i].data.push(newPath);
				}
			}
			return prev;
		});
		saveConfigs();
		info("[IMM] Mod name changed from", path, "to", newPath);
		await updatePrefsIniFromData(newPath, path);
		if (enabled) await toggleMod(newPath, true);
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
	const modSrc = join(src, managedSRC, path);
	const modTgt = join(tgt, managedTGT, path);

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
		throw error;
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

	const root = getD3DXUserIniPath(options.targetPath);
	if (!root || !(await exists(root))) return [] as string[];
	if (options.clearPrefsBeforeSync) {
		await Promise.all(
			mods.map((modPath) => guardedRemove(join(tgt, managedTGT, PREFS, modPath + ".ini")).catch(() => undefined))
		);
	}
	const rawIni = await readTextFile(root);
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
	const [category, name] = modPath.split("\\");
	const dir = join(tgt, managedTGT, PREFS, category);
	await mkdir(dir, { recursive: true });
	const root = join(dir, `${name}.ini`);
	if (oldPath) {
		const oldRoot = join(tgt, managedTGT, PREFS, oldPath);
		if (!(await exists(oldRoot))) return;
		await writeTextFile(root, (await readTextFile(oldRoot)).split(oldPath.toLowerCase()).join(modPath.toLowerCase()));
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
		await writeTextFile(
			root,
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
	await writeTextFile(path, lines.join("\n"));
	return true;
}
export function openFile(relPath: string) {
	openPath(join(modRoot, relPath));
}
export async function toggleMod(path: string, enabled: boolean, forced = false): Promise<boolean> {
	info("[IMM] Togglingx mod:", path, "Enabled:", enabled);
	try {
		const modSrc = join(src, managedSRC, path);
		const modTgt = join(tgt, managedTGT, path);

		if (enabled) {
			const [srcExists, tgtExists] = await Promise.all([exists(modSrc), exists(modTgt)]);
			if ((srcExists && !tgtExists) || forced) {
				await updatePrefsIniFromData(path);
				if (forced) return true;
				await mkdir(join(tgt, managedTGT, ...path.split("\\").slice(0, -1)), { recursive: true });
				try {
					await invoke("create_symlink", {
						linkPath: modTgt,
						targetPath: modSrc,
					});
				} catch (err) {
					error("[IMM] Error creating symlink:", err);
					return false;
				}
			}
		} else {
			await syncIniStateFromD3DXIni(path, {
				rewritePrefs: false,
				clearPrefsBeforeSync: true,
			});
			try {
				await guardedRemove(modTgt);
			} catch (err) {
				error("[IMM] Error removing mod:", err);
				return false;
			}
		}
	} catch (err) {
		error("[IMM] Error toggling mod:", err);
		return false;
	}
	info(`[IMM] Success mod ${enabled ? "enabled" : "disabled"}:`, path);
	return true;
}
export async function savePreviewImageFromData(relPath: string, type: string, data: Uint8Array) {
	const path = join(src, managedSRC, relPath);
	const previewPath = join(path, "preview." + type);
	info("[IMM] Saving preview image for:", path, previewPath);
	const removePromises = exts.map((ext) =>
		guardedRemove(path + "\\" + "preview." + ext).catch(() => {
			// Ignore errors if file doesn't exist
		})
	);
	await Promise.all(removePromises);
	await writeFile(previewPath, data);
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
	saveConfigs();

	addToast({ type: "success", message: textData._Toasts.ImgSaved });
}
export async function savePreviewImage(path: string) {
	try {
		path = join(src, managedSRC, path);
		const file = await open({
			multiple: false,
			directory: false,
			filters: [{ name: "Image", extensions: exts }],
		});

		if (!file) return false;

		// Remove existing preview images in parallel

		const removePromises = exts.map((ext) =>
			guardedRemove(path + "\\" + "preview." + ext).catch(() => {
				// Ignore errors if file doesn't exist
			})
		);
		await Promise.all(removePromises);

		// Copy new preview image
		const fileExt = file.split(".").pop();
		await guardedImportFile(file, path + "\\" + "preview." + fileExt);
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
		const entries = (await readDirRecr(join(tgt, managedTGT), "", 2)).flatMap((x) => x.children || []);
		const disablePromises: Promise<boolean>[] = entries.map((entry) => toggleMod(entry.path, false));
		await Promise.all(disablePromises);
		await guardedRemove(join(tgt, managedTGT), { recursive: true });
		await mkdir(join(tgt, managedTGT), { recursive: true });

		// Apply mods in parallel batches to improve performance
		const batchSize = 10;
		for (let i = 0; i < data.length; i += batchSize) {
			const batch = data.slice(i, i + batchSize);
			await Promise.all(
				batch.map((mod) =>
					toggleMod(mod, true).catch((err = "unknown") => {
						error(`[IMM] Error toggling mod ${mod}:`, err);
					})
				)
			);
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
		const archiveName = archive.split("\\").pop() || "";
		const [name] = archiveName.split(".");
		const root = join(src, managedSRC, UNCATEGORIZED);
		await mkdir(root, { recursive: true });
		let counter = 0;
		let finalName = name;
		while (await exists(join(root, finalName))) {
			finalName = `${name} (${++counter})`;
		}
		const dest = join(root, finalName);
		await mkdir(dest, { recursive: true });
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
