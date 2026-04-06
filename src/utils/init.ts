import {
	CATEGORIES,
	DATA,
	DOWNLOAD_LIST,
	ERR,
	FIRST_LOAD,
	GAME,
	IMM_UPDATE,
	LANG,
	MAIN_FUNC_STATUS,
	NOTICE,
	NOTICE_OPEN,
	ONLINE_DATA,
	PRESETS,
	resetAtoms,
	SAVED_LANG,
	SETTINGS,
	SOURCE,
	store,
	TARGET,
	TEXT_DATA,
	TYPES,
	UPDATER_OPEN,
	XXMI_DIR,
	XXMI_MODE,
} from "./vars";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { path } from "@tauri-apps/api";
import { invoke } from "@tauri-apps/api/core";
// import { currentMonitor, PhysicalSize } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { exists, mkdir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import defConfig from "../default.json";
import defConfigXX from "../defaultXX.json";
import { apiClient } from "./api";
import { GAMES, VERSION } from "./consts";
import { switchGameTheme } from "./theme";
import { executeXXMI, isGameProcessRunning } from "./autolaunch";
// import { updateIni } from "./iniUpdater";
import { join, setHotreload, stopWindowMonitoring } from "./hotreload";
import { registerGlobalHotkeys } from "./hotkeyUtils";
import TEXT from "@/textData.json";
import { unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { compareVersions, safeLoadJson, sanitizeGlobalSettings, setImageServer } from "./utils";
import { addToast } from "@/_Toaster/ToastProvider";
import { Category, Games, Preset, Settings } from "./types";
import { toResumableDownloadList, withNormalizedDownloadSettings } from "./downloads";
import { resetPageCounts } from "@/_Main/MainOnline";
import { info } from "@/lib/logger";
// import { v2_0_4_migration } from "./filesys";
let paths = {
	"": "",
	exe: "",
	WW: "",
	ZZ: "",
	GI: "",
	SR: "",
	XX: "",
	EF: "",
};
let isInPrePostLaunch = {
	WW: false,
	ZZ: false,
	GI: false,
	SR: false,
	EF: false,
	"": false,
};

export function getPaths() {
	return paths;
}
let config: any = { ...defConfig };
let configXX: any = { ...defConfigXX };
let dataDir = "";
let appData = "";
let prevGame = "";
let categories: Category[] = [];
let isInitialized = false;
async function getXXMIConfig(path = store.get(XXMI_DIR)) {
	try {
		return JSON.parse(await readTextFile(join(path, "XXMI Launcher Config.json")));
	} catch (e) {
		info("[IMM] Failed to read XXMI Launcher config:", e);
		return null;
	}
}
export async function setPrePostLaunch(game: Games, value: boolean) {
	const data = await getXXMIConfig();
	if (!data) return;
	if (!data.Importers[game + "MI"]) return;
	const cmd = `start imm://mode/${game.toLowerCase()}`;
	if (value) {
		if (!data.Importers[game + "MI"].Importer.run_pre_launch.includes(cmd))
			data.Importers[game + "MI"].Importer.run_pre_launch = [
				cmd,
				...data.Importers[game + "MI"].Importer.run_pre_launch.split(" && "),
			]
				.filter((x: string) => x.trim() !== "")
				.join(" && ");
	} else {
		if (data.Importers[game + "MI"].Importer.run_pre_launch.includes(cmd)) {
			data.Importers[game + "MI"].Importer.run_pre_launch = data.Importers[game + "MI"].Importer.run_pre_launch
				.split(" && ")
				.filter((x: string) => x.trim() !== cmd)
				.join(" && ");
		}
		if (data.Importers[game + "MI"].Importer.run_post_load.includes(cmd)) {
			data.Importers[game + "MI"].Importer.run_post_load = data.Importers[game + "MI"].Importer.run_post_load
				.split(" && ")
				.filter((x: string) => x.trim() !== cmd)
				.join(" && ");
		}
	}
	await writeTextFile(join(store.get(XXMI_DIR), "XXMI Launcher Config.json"), JSON.stringify(data, null, 2));
}
export async function readXXMIConfig(path: string) {
	paths = {
		"": "",
		exe: "",
		WW: "",
		ZZ: "",
		GI: "",
		SR: "",
		XX: "",
		EF: "",
	};
	isInPrePostLaunch = {
		WW: false,
		ZZ: false,
		GI: false,
		SR: false,
		EF: false,
		"": false,
	};
	if (path && path != "") {
		const data = await getXXMIConfig(path);
		if (!data) return;
		info("[IMM] Loaded XXMI Launcher config:", data);
		GAMES.forEach((game) => {
			if (data.Importers[game + "MI"]) {
				const xxPath = (data.Importers[game + "MI"].Importer.importer_folder || "").replace(/\\/g, "/");
				info(`[IMM] Resolved ${game}MI path:`, xxPath);
				paths[game as Games] = xxPath == `${game}MI/` ? join(path, `${game}MI`) : join(...xxPath.split("/"));
				const startCmd = `start imm://mode/${game.toLowerCase()}`;
				if (
					data.Importers[game + "MI"].Importer?.run_pre_launch.includes(startCmd) ||
					data.Importers[game + "MI"].Importer?.run_post_load.includes(startCmd)
				)
					isInPrePostLaunch[game as Games] = true;
			}
		});
		paths.XX = path;
		store.set(XXMI_DIR, path);
	}
	info("[IMM] Resolved game paths:", paths);
}
export function getDataDir() {
	return dataDir;
}
export function getPrevGame() {
	return prevGame;
}
export const window = getCurrentWebviewWindow();
export function changeWindowTitle(title: string) {
	window.setTitle(title);
}
export async function setWindowType(type: number) {
	if (type == 0) {
		// if (await window.isMaximized())
		window.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(true);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 1) {
		window.unmaximize();
		// window.setFullscreen(false);
		// window.setDecorations(false);
		// currentMonitor().then((x) => {
		// 	if (x?.size) window.setSize(new PhysicalSize(x.size.width * 0.8, x.size.height * 0.8));
		// });
	} else if (type == 2) {
		window.maximize();
		// window.setFullscreen(true);
	}
}
invoke<string>("get_image_server_url").then((url) => {
	setImageServer(url + "/preview");
});
export async function updateConfig(oconfig = null as any) {
	if (!oconfig) oconfig = JSON.parse(await readTextFile("config.json"));
	info("[IMM] Updating config from:", oconfig);
	if (compareVersions(oconfig.version || "0.0.0", "2.1.0") >= 0) return oconfig;
	let config = {
		version: VERSION,
		updatedAt: new Date().toISOString(),
		bgOpacity: oconfig.settings.opacity || 1,
		winOpacity: 1,
		winType: oconfig.settings.type || 0,
		bgType: oconfig.settings.bgType || 2,
		listType: 0,
		nsfw: oconfig.settings.nsfw || 1,
		toggleClick: oconfig.settings.toggle || 2,
		ignore: "",
		clientDate: oconfig.settings.clientDate || "",
		XXMI: "",
		lang: oconfig.settings.lang || "",
		game: "",
	};
	let data = oconfig.data || {};
	let keys = Object.keys(data);
	for (let key of keys) {
		if (key.startsWith("\\")) {
			data[key.substring(1)] = data[key];
			delete data[key];
		}
	}
	let presets = oconfig.presets.map((preset: Preset) => {
		let newPreset: Preset = { name: preset.name || "Preset", data: [], hotkey: preset?.hotkey || "" };
		if (preset.data && Array.isArray(preset.data)) {
			newPreset.data = preset.data.map((item: string) => (item.startsWith("\\") ? item.substring(1) : item));
		}
		return newPreset;
	});
	await writeTextFile(
		`configWW.json`,
		JSON.stringify(
			{
				version: VERSION,
				categories: [],
				settings: {
					launch: oconfig.settings.launch || 0,
					hotReload: oconfig.settings.hotReload || 1,
					onlineType: oconfig.settings.onlineType || "Mod",
					customCategories: {},
					download: { ...defConfigXX.settings.download },
				},
				data: oconfig.data || {},
				presets: presets || [],
				downloads: {
					queue: [],
					downloading: [],
					extracting: [],
					completed: [],
					failed: [],
				},
				updatedAt: new Date().getTime(),
			},
			null,
			2
		)
	);
	store.set(FIRST_LOAD, true);
	return config;
}
export async function verifyGameDir(game: Games) {
	const XXPath = paths[game];
	const dirs = {
		targetDir: "",
		sourceDir: "",
	};
	try {
		(await readTextFile(join(XXPath, "d3dx.ini"))).split("\n").forEach((line: string) => {
			const [key, value] = line.split("=").map((x: string) => x.trim());
			if (key == "include_recursive") {
				const isPath = value.slice(1, 3) == ":\\";
				dirs.targetDir = isPath ? value : join(XXPath, value);
				dirs.sourceDir = isPath ? value : join(XXPath, value);
			}
		});
	} catch (e) {
		info(`[IMM] Failed to read d3dx.ini for ${game}:`, e);
		dirs.sourceDir = "";
		dirs.targetDir = "";
	}
	return dirs;
}
export async function initGame(game: Games, status = true) {
	info(`[IMM] Initializing game: ${game}...`);
	store.set(ONLINE_DATA, {});
	if (await exists(`config${game}.json`)) {
		configXX = JSON.parse(await readTextFile(`config${game}.json`));
	} else configXX = { ...defConfigXX };
	const defKeys = Object.keys(defConfigXX);
	defKeys.forEach((key) => {
		if (!(key in configXX)) {
			(configXX as any)[key] = (defConfigXX as any)[key];
		}
	});
	configXX.settings = withNormalizedDownloadSettings({
		...defConfigXX.settings,
		...configXX.settings,
		customCategories: {
			...defConfigXX.settings.customCategories,
			...(configXX.settings?.customCategories || {}),
		},
		download: {
			...defConfigXX.settings.download,
			...(configXX.settings?.download || {}),
		},
	});
	configXX.downloads = toResumableDownloadList(configXX.downloads);
	configXX.game = game;
	if (configXX.settings.launch === 2 && !isInPrePostLaunch[game]) configXX.settings.launch = 0;
	else if (isInPrePostLaunch[game]) configXX.settings.launch = 2;
	switchGameTheme(game);

	if (!configXX.custom) {
		configXX = { ...configXX, ...(await verifyGameDir(game)) };
	} else {
		dataDir = configXX.targetDir;
	}
	await writeTextFile(`config${game}.json`, JSON.stringify(configXX, null, 2));
	apiClient.setGame(game as any);
	await setCategories(game, status);
	invoke("set_window_icon", { game });
	// Validate source and target dirs
	if (configXX.sourceDir && !(await exists(join(configXX.sourceDir)))) configXX.sourceDir = "";
	if (configXX.targetDir && !(await exists(configXX.targetDir))) configXX.targetDir = "";
	status && store.set(MAIN_FUNC_STATUS, "Validating source and target directories");
	info("[IMM] Validating source and target directories...", configXX.sourceDir, configXX.targetDir);
	store.set(SOURCE, configXX.sourceDir || "");
	store.set(TARGET, configXX.targetDir || "");
	store.set(XXMI_MODE, configXX.custom || 0);
	store.set(
		SETTINGS,
		(prev) => ({ global: { ...prev.global, game }, game: { ...prev.game, ...configXX.settings } }) as Settings
	);
	store.set(TYPES, apiClient.generic.types);
	store.set(DATA, configXX.data || {});
	store.set(PRESETS, configXX.presets || []);
	store.set(DOWNLOAD_LIST, toResumableDownloadList(configXX.downloads));
	return configXX;
}
store.sub(SETTINGS, async () => {
	const settings = store.get(SETTINGS);
	if (isInitialized) {
		config = { ...config, ...settings.global };
		configXX = { ...configXX, settings: { ...configXX.settings, ...settings.game } };
	}
	if (settings.global.game != store.get(GAME)) store.set(GAME, settings.global.game);
	// const compare = {
	// 	src: [settings.global.game, settings.global.lang],
	// 	to: [GAME, LANG],
	// 	names: ["game", "lang"],
	// };
	// for (let i = 0; i < compare.src.length; i++) {
	// 	if (compare.src[i] !== store.get(compare.to[i])) {
	// 		if (compare.names[i] === "lang" && compare.src[i])
	// 			store.set(TEXT_DATA, TEXT[compare.src[i] as "en"] || TEXT["en"]);
	// 		// else if (compare.names[i] === "game" && compare.src[i]) await initGame(compare.src[i]);
	// 		store.set(compare.to[i] as any, compare.src[i]);
	// 	}
	// }
});
store.sub(SAVED_LANG, () => {
	const lang = store.get(SAVED_LANG);
	store.set(TEXT_DATA, TEXT[store.get(SAVED_LANG) as "en"] || TEXT["en"]);
	if (lang) {
		store.set(LANG, lang);
	}
});
export async function setCategories(game = prevGame, status = true) {
	info("[IMM] Setting categories...");

	// await new Promise((resolve) => setTimeout(resolve, 10000));
	if (!game) return;
	prevGame = game;
	try {
		status && store.set(MAIN_FUNC_STATUS, "Fetching game categories from Gamebanana");
		categories = await apiClient.categories();
		//info("Fetched categories:", categories);
		if (!categories || categories.length == 0) throw "No categories found, please verify the directories again";
	} catch (e) {
		status && store.set(MAIN_FUNC_STATUS, "Unable to reach Gamebanana");
		info("[IMM] Failed to fetch categories from API, using local config if available.", e);
		categories =
			configXX.categories && configXX.categories.length > 0
				? configXX.categories
				: [...apiClient.categoryList, ...apiClient.generic.categories];
	} finally {
		//info("Using categories:", categories,apiClient.categoryList,configXX.categories);
		if (!categories || categories.length == 0) return;
		info("[IMM] Finalized categories:", categories);
		const catObj: { [key: string]: Category } = {};
		categories.forEach((cat) => {
			catObj[cat._sName] = cat;
		});
		const customCats = configXX.settings.customCategories || {};
		for (let key of Object.keys(customCats)) {
			catObj[key] = { ...catObj[key], _sName: key, ...customCats[key] };
		}
		categories = Object.values(catObj).map((cat) => ({ ...cat, _sIconUrl: cat._sIconUrl || "/who.jpg" }));
		store.set(CATEGORIES, categories);
	}
}
function removeHelpers() {
	stopWindowMonitoring();
	unregisterAll();
	resetPageCounts();
}
export async function launchGame() {
	if (await exists(config.XXMI))
		isGameProcessRunning(config.game).then((running) => {
			if (!running) {
				executeXXMI(join(config.XXMI, "Resources\\Bin\\XXMI Launcher.exe"));
				addToast({
					type: "info",
					message: "Launching Game",
				});
			}
		});
}
async function initHelpers() {
	info("[IMM] Initializing helpers...");
	if (configXX.settings.launch == 1 && GAMES.includes(config.game)) {
		launchGame();
	}
	setHotreload(configXX.settings.hotReload as 0 | 1 | 2, config.game, configXX.targetDir);

	registerGlobalHotkeys();
}
export async function checkWWMM() {
	info("[IMM] Checking for WWMM config...");
	const wwmmPath = await path.join(await path.localDataDir(), "Wuwa Mod Manager (WWMM)", "config.json");
	if (await exists(wwmmPath)) {
		//info('exists')
		return (await readTextFile(wwmmPath)) || null;
	}
	return null;
}
export async function maintainBackups() {
	info("[IMM] Maintaining backups...");
	store.set(MAIN_FUNC_STATUS, "Maintaining backups");
	const files = GAMES.map((g) => `config${g}.json`);
	files.push("config.json");
	mkdir("backups", { recursive: true });
	const backupPath = "backups\\AUTO_";
	for (const file of files) {
		if (await exists(file)) {
			try {
				const data = JSON.parse(await readTextFile(file));
				delete data.categories;
				if (await exists(backupPath + file + ".bak")) {
					try {
						const backupData = JSON.parse(await readTextFile(backupPath + file + ".bak"));
						if (
							backupData.updatedAt &&
							new Date().getTime() - new Date(backupData.updatedAt).getTime() > 24 * 60 * 60 * 1000
						) {
							info(`[IMM] Creating backup for: ${file}...`);
							try {
								remove(backupPath + file + ".bak.bak");
							} catch {}
							await writeTextFile(backupPath + file + ".bak.bak", await readTextFile(backupPath + file + ".bak"));
							await writeTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
						}
					} catch {
						info(`[IMM] Detected corrupted backup file: ${file}.bak, creating new backup...`);
						await writeTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
					}
				} else {
					info(`[IMM] Creating initial backup for: ${file}...`);
					await writeTextFile(backupPath + file + ".bak", JSON.stringify(data, null, 2));
				}
			} catch (e) {
				info(`[IMM] Detected corrupted config file: ${file}, restoring from backup...`);
				store.set(MAIN_FUNC_STATUS, `Config file corrupted, restoring from backup`);
				if (await exists(backupPath + file + ".bak")) {
					try {
						const backupData = JSON.parse(await readTextFile(backupPath + file + ".bak"));
						await writeTextFile(file, JSON.stringify(backupData, null, 2));
						info(`[IMM] Successfully restored backup for: ${file}`);
					} catch (e) {
						info(`[IMM] Detected corrupted backup config file: ${file}.bak, restoring from secondary backup...`);
						if (await exists(backupPath + file + ".bak.bak")) {
							try {
								const backupData2 = JSON.parse(await readTextFile(backupPath + file + ".bak.bak"));
								await writeTextFile(file, JSON.stringify(backupData2, null, 2));
								await writeTextFile(backupPath + file + ".bak", JSON.stringify(backupData2, null, 2));
								info(`[IMM] Successfully restored secondary backup for: ${file}`);
							} catch (e) {
								info(`[IMM] Failed to restore secondary backup for: ${file}:`, e);
								info(`[IMM] Manual intervention required to fix config file: ${file}`);
								store.set(
									ERR,
									`Corrupted config file detected: ${file}, ${backupPath + file + ".bak"} & ${
										backupPath + file + ".bak.bak"
									}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
								);
							}
						} else {
							store.set(
								ERR,
								`Corrupted config file detected: ${file} & ${
									backupPath + file + ".bak"
								}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
							);
						}
					}
				} else {
					info(`[IMM] No backup found for corrupted config file: ${file}. Manual intervention required.`);
					store.set(
						ERR,
						`Corrupted config file detected: ${file}. Unable to proceed, please restore manually or press ESC x3 to reset IMM.`
					);
				}
			}
		}
	}
}
let cwd = "";
let runtimeDirPromise: Promise<string> | null = null;
export function getCwd() {
	return cwd;
}
async function readRuntimeDataDir() {
	if (!runtimeDirPromise) {
		runtimeDirPromise = invoke<string>("get_runtime_data_dir").catch(async () =>
			join(await path.localDataDir(), "Integrated Mod Manager (IMM) Data")
		);
	}
	return runtimeDirPromise;
}
function parseUpdateBody(update: Update | null, lang: string) {
	if (!update?.body) return {};
	try {
		const parsed = JSON.parse(update.body);
		return parsed[lang as keyof typeof parsed] || parsed;
	} catch {
		return {};
	}
}
export async function refreshAppUpdateCheck(openUpdater = false) {
	store.set(IMM_UPDATE, {
		version: VERSION,
		date: "",
		body: "{}",
		status: "checking",
		raw: null,
		error: "",
	});
	try {
		const update = await check({ timeout: 15000 });
		if (!update) {
			store.set(IMM_UPDATE, {
				version: VERSION,
				date: "",
				body: "{}",
				status: "up_to_date",
				raw: null,
				error: "",
			});
			if (openUpdater) store.set(UPDATER_OPEN, true);
			return null;
		}

		const lang = config.lang || "en";
		const parsedBody: any = parseUpdateBody(update, lang);
		const notice = parsedBody.notice || {};
		const lastConfig = config.notice || 0;
		let noticeOpen = false;
		if (notice.id > 0 && compareVersions(notice.ver || "0.0.0", VERSION) > 0) {
			store.set(NOTICE, (prev: any) => ({ ...prev, ...notice }));
			if (notice.id !== lastConfig || notice.ignoreable == 0) {
				noticeOpen = true;
				store.set(NOTICE_OPEN, true);
			}
		}

		store.set(IMM_UPDATE, {
			version: update.version,
			date: update.date || "",
			body: JSON.stringify(parsedBody) || "{}",
			status: "available",
			raw: update,
			error: "",
		});
		if (openUpdater || (!noticeOpen && compareVersions(update.version || "0.0.0", config.ignore || VERSION) > 0)) {
			store.set(UPDATER_OPEN, true);
		}
		store.set(SETTINGS, (prev) => ({
			...prev,
			global: sanitizeGlobalSettings({
				...prev.global,
				notice: notice.id || prev.global.notice || 0,
			}),
		}));
		return update;
	} catch (error: any) {
		store.set(IMM_UPDATE, {
			version: VERSION,
			date: "",
			body: "{}",
			status: "error",
			raw: null,
			error: error?.message || String(error || "Update check failed"),
		});
		if (openUpdater) store.set(UPDATER_OPEN, true);
		return null;
	}
}
export async function main(useGame = "" as Games) {
	store.set(MAIN_FUNC_STATUS, "Initializing App");
	isInitialized = false;
	info("[IMM] Initializing application...");
	invoke("get_username");
	resetAtoms();
	removeHelpers();
	appData = await path.dataDir();
	cwd = await readRuntimeDataDir();
	const XXMI = `${appData}\\XXMI Launcher`;
	if (!(await exists("config.json"))) {
		store.set(MAIN_FUNC_STATUS, "Creating default config.json");
		info("[IMM] Creating default config.json...");
		await writeTextFile("config.json", JSON.stringify(defConfig, null, 2));
	}
	await maintainBackups();
	const rawConfig = JSON.parse(await readTextFile("config.json"));
	config = sanitizeGlobalSettings(safeLoadJson(structuredClone(defConfig), rawConfig));
	if (compareVersions(config.version || "0.0.0", "2.2.0") < 0) {
		config.chkModUpdates = true;
		config.bgType = 1;
	}
	config = sanitizeGlobalSettings(config);
	info("[IMM] Loaded config:", config);
	store.set(MAIN_FUNC_STATUS, "Config loaded");
	const savedLang = store.get(SAVED_LANG);
	if (!savedLang && config.lang) {
		store.set(SAVED_LANG, config.lang);
	}
	config.lang = store.get(SAVED_LANG) || config.lang;
	if (!config.XXMI && !config.game && !config.lang) {
		store.set(MAIN_FUNC_STATUS, "First time setup detected, checking for WWMM");
		info("[IMM] First time setup detected, checking for WWMM...");
		store.set(FIRST_LOAD, true);
		const temp = await checkWWMM();
		if (temp) config = await updateConfig(JSON.parse(temp));
	} else {
		store.set(FIRST_LOAD, false);
	}
	apiClient.setClient(config.clientDate || "");
	if ((config.XXMI == "" || !(await exists(config.XXMI))) && (await exists(XXMI))) {
		config.XXMI = XXMI;
	}
	paths.XX = config.XXMI;
	config.game = useGame || config.game;
	if (sessionStorage.getItem("imm-deep-link-game")) {
		config.game = sessionStorage.getItem("imm-deep-link-game") as Games;
		config.game = GAMES.includes(config.game) ? config.game : "";
		sessionStorage.removeItem("imm-deep-link-game");
	}
	if (config.game) apiClient.setGame(config.game);
	if (compareVersions(config.version || "0.0.0", "2.1.0") < 0) {
		config = await updateConfig();
	}
	info("[IMM] Saving config...");
	await writeTextFile("config.json", JSON.stringify(config, null, 2));
	await readXXMIConfig(config.XXMI || "");
	store.set(MAIN_FUNC_STATUS, "Initializing game");
	info("[IMM] Initializing game...");
	if (config.game) configXX = await initGame(config.game);
	info("[IMM] Setting window type...");
	if (config.winType > 1) setWindowType(config.winType);
	const bg = document.querySelector("body");
	if (bg)
		bg.style.backgroundColor = "color-mix(in oklab, var(--background) " + config.bgOpacity * 100 + "%, transparent)";

	store.set(SETTINGS, (prev) => ({
		global: sanitizeGlobalSettings({ ...prev.global, ...config }),
		game: { ...prev.game, ...configXX.settings },
	}));
	initHelpers();
	await refreshAppUpdateCheck(false);
	isInitialized = true;
	store.set(MAIN_FUNC_STATUS, "fin");
}
