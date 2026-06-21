import { addToast } from "@/_Toaster/ToastProvider";
import { invoke } from "@tauri-apps/api/core";
import { exists, mkdir, readDir } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { saveConfigs } from "./filesys";
import { join } from "./hotreload";
import { getCwd } from "./init";
import { WuwaModFixerState } from "./types";
import { SETTINGS, store } from "./vars";
import { executeWithArgs } from "./autolaunch";

const FIXER_LABEL = "Wuwa Mod Fixer";
const FIXER_RELEASES_URL = "https://github.com/Moonholder/Wuwa_Mod_Fixer";
const FIXER_TOOLS_SUBDIR = join("tools", "Wuwa_Mod_Fixer");
const BUNDLED_NOTES = "Bundled with IMM. No separate download is required.";

type BundledToolInfo = {
	version: string;
	exePath: string;
	sourcePath: string;
};

export type WuwaModFixerReleaseInfo = {
	version: string;
	tag: string;
	url: string;
	publishedAt: string;
	notes: string;
};

export type WuwaModFixerCheckResult = {
	installed: WuwaModFixerState;
	latest: WuwaModFixerReleaseInfo;
	updateAvailable: boolean;
};

function getStoredState(): WuwaModFixerState {
	return store.get(SETTINGS).global.wuwaModFixer;
}

function normalizeVersionTag(version = "") {
	return String(version || "").trim().replace(/^v/i, "");
}

function normalizeToolState(input?: Partial<WuwaModFixerState>): WuwaModFixerState {
	const current = getStoredState();
	return {
		version: typeof input?.version === "string" ? input.version : current.version || "",
		exePath: typeof input?.exePath === "string" ? input.exePath : current.exePath || "",
		checkedAt: Number.isFinite(input?.checkedAt) ? Number(input?.checkedAt) : current.checkedAt || 0,
		releaseUrl: typeof input?.releaseUrl === "string" ? input.releaseUrl : current.releaseUrl || "",
	};
}

async function persistToolState(input?: Partial<WuwaModFixerState>) {
	const nextState = normalizeToolState(input);
	store.set(SETTINGS, (prev) => ({
		...prev,
		global: {
			...prev.global,
			wuwaModFixer: nextState,
		},
	}));
	await saveConfigs();
	return nextState;
}

async function readRuntimeDir() {
	const cwd = getCwd();
	if (cwd) return cwd;
	return invoke<string>("get_runtime_data_dir");
}

async function getBaseToolDir() {
	return join(await readRuntimeDir(), FIXER_TOOLS_SUBDIR);
}

async function listChildDirectories(root: string) {
	if (!root || !(await exists(root))) return [] as string[];
	const entries = await readDir(root);
	return entries
		.filter((entry) => entry.isDirectory && entry.name)
		.map((entry) => join(root, entry.name || ""))
		.sort((left, right) => right.localeCompare(left));
}

async function findFixerExe(root: string, depth = 3): Promise<string> {
	if (!root || depth < 0 || !(await exists(root))) return "";
	const entries = await readDir(root);
	const directMatch = entries.find((entry) => {
		if (entry.isDirectory || !entry.name) return false;
		const lower = entry.name.toLowerCase();
		return lower.endsWith(".exe") && lower.includes("wuwa_mod_fixer");
	});
	if (directMatch?.name) {
		return join(root, directMatch.name);
	}
	if (depth === 0) return "";
	for (const entry of entries) {
		if (!entry.isDirectory || !entry.name) continue;
		const nested = await findFixerExe(join(root, entry.name), depth - 1);
		if (nested) return nested;
	}
	return "";
}

async function resolveInstalledState(): Promise<WuwaModFixerState> {
	const stored = getStoredState();
	if (stored.exePath && (await exists(stored.exePath))) {
		return stored;
	}

	const baseDir = await getBaseToolDir();
	const versionDirs = await listChildDirectories(baseDir);
	for (const versionDir of versionDirs) {
		const exePath = await findFixerExe(versionDir);
		if (!exePath) continue;
		const version = normalizeVersionTag(versionDir.split("\\").pop() || "");
		return persistToolState({
			version,
			exePath,
			releaseUrl: FIXER_RELEASES_URL,
		});
	}

	if (stored.exePath || stored.version) {
		return persistToolState({
			version: "",
			exePath: "",
			releaseUrl: FIXER_RELEASES_URL,
		});
	}
	return stored;
}

async function ensureBundledTool(): Promise<BundledToolInfo> {
	const bundled = await invoke<BundledToolInfo>("ensure_bundled_wuwa_mod_fixer");
	const nextState = await persistToolState({
		version: normalizeVersionTag(bundled.version),
		exePath: bundled.exePath,
		checkedAt: Date.now(),
		releaseUrl: FIXER_RELEASES_URL,
	});
	return {
		version: nextState.version,
		exePath: nextState.exePath,
		sourcePath: bundled.sourcePath,
	};
}

function toBundledReleaseInfo(version: string): WuwaModFixerReleaseInfo {
	return {
		version,
		tag: version ? `v${version}` : "",
		url: FIXER_RELEASES_URL,
		publishedAt: "",
		notes: BUNDLED_NOTES,
	};
}

export async function checkWuwaModFixerUpdate() {
	const ensured = await ensureBundledTool();
	const installed = await resolveInstalledState();
	return {
		installed,
		latest: toBundledReleaseInfo(ensured.version || installed.version),
		updateAvailable: false,
	} satisfies WuwaModFixerCheckResult;
}

export async function installOrUpdateWuwaModFixer() {
	const ensured = await ensureBundledTool();
	return persistToolState({
		version: ensured.version,
		exePath: ensured.exePath,
		checkedAt: Date.now(),
		releaseUrl: FIXER_RELEASES_URL,
	});
}

export async function launchWuwaModFixer() {
	const installed = await ensureBundledTool();
	if (!installed.exePath || !(await exists(installed.exePath))) {
		throw new Error(`${FIXER_LABEL} executable is missing from the bundled tool directory.`);
	}
	return executeWithArgs(installed.exePath, []);
}

export async function openWuwaModFixerFolder() {
	const baseDir = await getBaseToolDir();
	await mkdir(baseDir, { recursive: true });
	return openPath(baseDir);
}

type WuwaModFixerText = { _Main?: { _components?: { _WuwaModFixer?: { Warning?: string; Missing?: string; LaunchFailed?: string } } } };

export function getWuwaModFixerWarning(textData: WuwaModFixerText) {
	return (
		textData?._Main?._components?._WuwaModFixer?.Warning ||
		"If you already used a different fixer version on the same mod, restore that mod from backup before repairing again."
	);
}

export function getWuwaModFixerMissingMessage(textData: WuwaModFixerText) {
	return textData?._Main?._components?._WuwaModFixer?.Missing || `${FIXER_LABEL} is not ready yet.`;
}

export function showWuwaModFixerLaunchError(error: unknown, textData: WuwaModFixerText) {
	const message = error instanceof Error ? error.message : String(error || "Unknown error");
	addToast({
		type: "error",
		message: textData?._Main?._components?._WuwaModFixer?.LaunchFailed || message,
	});
}

export { FIXER_LABEL, FIXER_RELEASES_URL };
