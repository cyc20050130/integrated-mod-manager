import { addToast } from "@/_Toaster/ToastProvider";
import { save } from "@tauri-apps/plugin-dialog";
import { exists, readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { managedSRC, exts, GAMES } from "./consts";
import { apiClient } from "./api";
import {
	DATA,
	GAME,
	LAST_UPDATED,
	LINK_AUDIT_REPORT,
	LINK_AUDIT_RUNNING,
	PRESETS,
	PREVIEW_BACKFILL_STATE,
	store,
	TEXT_DATA,
} from "./vars";
import {
	Games,
	LinkAuditGameReport,
	LinkAuditModEntry,
	LinkAuditOrphanEntry,
	LinkAuditReport,
	LinkAuditSuggestion,
	ModData,
	OnlineMod,
	Preset,
	PreviewBackfillState,
} from "./types";
import { join } from "./hotreload";
import { loadNteConfigText, persistNteConfig } from "./nteConfigRevision";

const LINK_SCAN_SCOPE: Games[] = [...GAMES];
const PREVIEW_COOLDOWN_MS = 30 * 60 * 1000;
const PREVIEW_DELAY_MS = 900;
const SUGGESTION_THRESHOLD = 0.48;

let previewBackfillRunning = false;
const previewFailureCooldown = new Map<string, number>();

type ConfigGame = {
	game: Games;
	configPath: string;
	sourceDir: string;
	modRoot: string;
	data: Record<string, ModData>;
};

function readGameConfigText(game: Games, configPath: string) {
	return game === "NTE" ? loadNteConfigText() : readTextFile(configPath);
}

function normalizePathKey(path: string) {
	if (!path) return "";
	return path.replaceAll("/", "\\").replace(/\\+/g, "\\").replace(/^\\+/, "").trim();
}

function splitPath(path: string) {
	const normalized = normalizePathKey(path);
	const parts = normalized.split("\\").filter(Boolean);
	if (parts.length < 2) return { category: "", name: "", path: normalized };
	return {
		category: parts[0],
		name: parts.slice(1).join("\\"),
		path: `${parts[0]}\\${parts.slice(1).join("\\")}`,
	};
}

function normalizeComparableName(name: string) {
	return String(name || "")
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[_\-.()[\]{}]+/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeName(name: string) {
	return normalizeComparableName(name).split(" ").filter(Boolean);
}

function tokenJaccard(a: string[], b: string[]) {
	if (!a.length || !b.length) return 0;
	const aset = new Set(a);
	const bset = new Set(b);
	let intersection = 0;
	aset.forEach((token) => {
		if (bset.has(token)) intersection += 1;
	});
	const union = new Set([...aset, ...bset]).size;
	return union > 0 ? intersection / union : 0;
}

function buildSuggestion(
	local: LinkAuditModEntry,
	orphan: LinkAuditOrphanEntry,
	game: Games
): LinkAuditSuggestion | null {
	const localName = normalizeComparableName(local.name);
	const orphanName = normalizeComparableName(orphan.name);
	const localTokens = tokenizeName(local.name);
	const orphanTokens = tokenizeName(orphan.name);
	const tokenScore = tokenJaccard(localTokens, orphanTokens);

	let score = 0;
	const reasons: string[] = [];

	if (local.category === orphan.category) {
		score += 0.16;
		reasons.push("same category");
	}
	if (localName && orphanName && localName === orphanName) {
		score += 0.54;
		reasons.push("same normalized name");
	} else if (localName && orphanName && (localName.includes(orphanName) || orphanName.includes(localName))) {
		score += 0.35;
		reasons.push("name inclusion");
	}
	if (tokenScore > 0) {
		score += tokenScore * 0.34;
		reasons.push(`token overlap ${(tokenScore * 100).toFixed(0)}%`);
	}
	if (local.hasDataRecord) {
		score += 0.07;
		reasons.push("local data record exists");
	}
	if (/[^\x20-\x7E]/.test(orphan.name) && orphanName === localName) {
		score += 0.08;
		reasons.push("orphan name likely encoding-damaged");
	}

	if (score < SUGGESTION_THRESHOLD) return null;

	return {
		game,
		localPath: local.path,
		candidateDataPath: orphan.path,
		source: orphan.source,
		confidence: Math.min(0.99, Number(score.toFixed(2))),
		reason: reasons.join("; "),
	};
}

async function readGameConfig(game: Games): Promise<ConfigGame | null> {
	const configPath = `config${game}.json`;
	if (!(await exists(configPath))) return null;
	try {
		const parsed = JSON.parse(await readGameConfigText(game, configPath));
		const sourceDir = String(parsed?.sourceDir || "").trim();
		return {
			game,
			configPath,
			sourceDir,
			modRoot: sourceDir ? join(sourceDir, managedSRC) : "",
			data: (parsed?.data || {}) as Record<string, ModData>,
		};
	} catch {
		return null;
	}
}

async function listManagedMods(modRoot: string) {
	if (!modRoot || !(await exists(modRoot))) return [] as string[];
	const paths: string[] = [];
	const categories = await readDir(modRoot);
	for (const category of categories) {
		if (!category.isDirectory || !category.name) continue;
		const categoryPath = join(modRoot, category.name);
		let mods: Awaited<ReturnType<typeof readDir>> = [];
		try {
			mods = await readDir(categoryPath);
		} catch {
			continue;
		}
		for (const mod of mods) {
			if (!mod.isDirectory || !mod.name) continue;
			paths.push(`${category.name}\\${mod.name}`);
		}
	}
	return paths.sort((a, b) => a.localeCompare(b));
}

function toModEntry(path: string, dataMap: Record<string, ModData>): LinkAuditModEntry {
	const normalized = normalizePathKey(path);
	const details = splitPath(normalized);
	const record = dataMap[normalized];
	const source = String(record?.source || "").trim();
	return {
		path: details.path,
		category: details.category,
		name: details.name,
		hasDataRecord: Boolean(record),
		...(source ? { source } : {}),
	};
}

function toOrphanEntry(path: string, source: string): LinkAuditOrphanEntry {
	const details = splitPath(path);
	return {
		path: details.path,
		category: details.category,
		name: details.name,
		source,
	};
}

function summarize(games: LinkAuditGameReport[]) {
	return games.reduce(
		(acc, game) => {
			acc.matched += game.matched.length;
			acc.unlinked += game.unlinked.length;
			acc.orphans += game.orphans.length;
			acc.suggestedMappings += game.suggestedMappings.length;
			return acc;
		},
		{ matched: 0, unlinked: 0, orphans: 0, suggestedMappings: 0 }
	);
}

function buildSuggestions(game: Games, unlinked: LinkAuditModEntry[], orphans: LinkAuditOrphanEntry[]) {
	const suggestions: LinkAuditSuggestion[] = [];
	const usedOrphans = new Set<string>();
	for (const local of unlinked) {
		let best: LinkAuditSuggestion | null = null;
		for (const orphan of orphans) {
			if (usedOrphans.has(orphan.path)) continue;
			const candidate = buildSuggestion(local, orphan, game);
			if (!candidate) continue;
			if (!best || candidate.confidence > best.confidence) {
				best = candidate;
			}
		}
		if (best) {
			suggestions.push(best);
			usedOrphans.add(best.candidateDataPath);
		}
	}
	return suggestions.sort((a, b) => b.confidence - a.confidence);
}

function hasObjectValues(value: unknown) {
	return typeof value === "object" && value !== null && Object.keys(value as Record<string, unknown>).length > 0;
}

function mergeModDataRecords(current: ModData | undefined, orphan: ModData | undefined): ModData {
	const next = {
		...(orphan || {}),
		...(current || {}),
	} as ModData;

	if (!next.source) next.source = String(current?.source || orphan?.source || "").trim();
	const updatedAt = current?.updatedAt ?? orphan?.updatedAt;
	if (updatedAt !== undefined && !next.updatedAt) next.updatedAt = updatedAt;
	const viewedAt = current?.viewedAt ?? orphan?.viewedAt;
	if (viewedAt !== undefined && !next.viewedAt) next.viewedAt = viewedAt;
	const note = current?.note ?? orphan?.note;
	if (note !== undefined && !next.note) next.note = note;
	if ((!next.tags || next.tags.length === 0) && orphan?.tags?.length) next.tags = [...orphan.tags];
	const namespace = current?.namespace ?? orphan?.namespace;
	if (namespace !== undefined && !next.namespace) next.namespace = namespace;
	if (!hasObjectValues(next.vars) && hasObjectValues(orphan?.vars)) next.vars = { ...(orphan?.vars || {}) };
	if (!next.crop && orphan?.crop) next.crop = { ...orphan.crop };

	return next;
}

function remapPresetPaths(paths: string[], fromPath: string, toPath: string) {
	let changed = false;
	const seen = new Set<string>();
	const next: string[] = [];

	for (const rawPath of paths || []) {
		const normalized = normalizePathKey(rawPath);
		const finalPath = normalized === fromPath ? toPath : rawPath;
		const finalKey = normalizePathKey(finalPath);
		if (!finalKey || seen.has(finalKey)) {
			if (normalized === fromPath) changed = true;
			continue;
		}
		if (normalized === fromPath && finalKey === toPath) changed = true;
		seen.add(finalKey);
		next.push(finalPath);
	}

	return { changed, paths: next };
}

export async function scanLinkIntegrity(scope: Games[] = LINK_SCAN_SCOPE): Promise<LinkAuditReport> {
	const gameReports: LinkAuditGameReport[] = [];
	for (const game of scope) {
		const scannedAt = new Date().toISOString();
		const emptyReport: LinkAuditGameReport = {
			game,
			configPath: `config${game}.json`,
			sourceDir: "",
			modRoot: "",
			scannedAt,
			matched: [],
			unlinked: [],
			orphans: [],
			suggestedMappings: [],
			warnings: [],
		};
		const cfg = await readGameConfig(game);
		if (!cfg) {
			emptyReport.warnings.push("config not found or unreadable");
			gameReports.push(emptyReport);
			continue;
		}

		const dataEntries = Object.entries(cfg.data || {});
		const normalizedData = Object.fromEntries(
			dataEntries.map(([key, value]) => [normalizePathKey(key), (value || {}) as ModData])
		);
		const linkedEntries = dataEntries
			.map(([key, value]) => ({
				path: normalizePathKey(key),
				source: String((value as ModData)?.source || "").trim(),
			}))
			.filter((entry) => entry.path && entry.source);
		const linkedPathSet = new Set(linkedEntries.map((entry) => entry.path));

		const localPaths = await listManagedMods(cfg.modRoot);
		const localPathSet = new Set(localPaths.map((path) => normalizePathKey(path)));

		const matched = [...localPathSet]
			.filter((path) => linkedPathSet.has(path))
			.map((path) => toModEntry(path, normalizedData));
		const unlinked = [...localPathSet]
			.filter((path) => !linkedPathSet.has(path))
			.map((path) => toModEntry(path, normalizedData));
		const orphanPaths = [...linkedPathSet].filter((path) => !localPathSet.has(path));
		const orphanMap = new Map(linkedEntries.map((entry) => [entry.path, entry.source]));
		const orphans = orphanPaths
			.map((path) => toOrphanEntry(path, orphanMap.get(path) || ""))
			.filter((entry) => entry.source);
		const suggestedMappings = buildSuggestions(game, unlinked, orphans);

		const warnings: string[] = [];
		if (!cfg.sourceDir) warnings.push("sourceDir not set");
		else if (!(await exists(cfg.modRoot))) warnings.push("managed mod root does not exist");

		gameReports.push({
			game,
			configPath: cfg.configPath,
			sourceDir: cfg.sourceDir,
			modRoot: cfg.modRoot,
			scannedAt,
			matched,
			unlinked,
			orphans,
			suggestedMappings,
			warnings,
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		scope,
		games: gameReports,
		summary: summarize(gameReports),
	};
}

export async function runLinkIntegrityScan(scope: Games[] = LINK_SCAN_SCOPE) {
	store.set(LINK_AUDIT_RUNNING, true);
	try {
		const report = await scanLinkIntegrity(scope);
		store.set(LINK_AUDIT_REPORT, report);
		return report;
	} finally {
		store.set(LINK_AUDIT_RUNNING, false);
	}
}

export async function applyLinkAuditSuggestions(
	report: LinkAuditReport | null = store.get(LINK_AUDIT_REPORT),
	scope: Games[] = LINK_SCAN_SCOPE,
	minConfidence = 0.58
) {
	const effectiveReport =
		report && report.scope.some((game) => scope.includes(game)) ? report : await scanLinkIntegrity(scope);
	const currentGame = store.get(GAME);
	let applied = 0;
	let skipped = 0;

	for (const gameReport of effectiveReport.games) {
		if (!scope.includes(gameReport.game)) continue;
		if (!(await exists(gameReport.configPath))) continue;

		let parsed: { data?: Record<string, ModData>; presets?: Preset[] } | null = null;
		try {
			parsed = JSON.parse(await readGameConfigText(gameReport.game, gameReport.configPath));
		} catch {
			continue;
		}

		const nextData = { ...((parsed?.data || {}) as Record<string, ModData>) };
		const nextPresets = Array.isArray(parsed?.presets)
			? parsed.presets.map((preset) => ({
					...preset,
					data: Array.isArray(preset?.data) ? [...preset.data] : [],
				}))
			: [];
		let changed = false;

		for (const suggestion of gameReport.suggestedMappings) {
			if (suggestion.confidence < minConfidence) {
				skipped += 1;
				continue;
			}

			const fromPath = normalizePathKey(suggestion.candidateDataPath);
			const toPath = normalizePathKey(suggestion.localPath);
			if (!fromPath || !toPath || fromPath === toPath) {
				skipped += 1;
				continue;
			}

			const orphanRecord = nextData[fromPath];
			if (!orphanRecord?.source) {
				skipped += 1;
				continue;
			}

			nextData[toPath] = mergeModDataRecords(nextData[toPath], orphanRecord);
			delete nextData[fromPath];

			for (const preset of nextPresets) {
				const remapped = remapPresetPaths(preset.data || [], fromPath, toPath);
				if (remapped.changed) {
					preset.data = remapped.paths;
				}
			}

			applied += 1;
			changed = true;
		}

		if (!changed || !parsed) continue;

		parsed.data = nextData;
		parsed.presets = nextPresets;
		const serialized = JSON.stringify(parsed, null, 2);
		if (gameReport.game === "NTE") await persistNteConfig(serialized);
		else await writeTextFile(gameReport.configPath, serialized);

		if (currentGame === gameReport.game) {
			store.set(DATA, nextData);
			store.set(PRESETS, nextPresets);
		}
	}

	return { applied, skipped, report: effectiveReport };
}

export async function exportLinkAuditReport(report: LinkAuditReport | null) {
	if (!report) return false;
	const target = await save({
		defaultPath: `IMM-link-audit-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.json`,
		filters: [{ name: "JSON files", extensions: ["json"] }],
	});
	if (!target) return false;
	await writeTextFile(target, JSON.stringify(report, null, 2));
	return true;
}

function sourceToModRoute(source: string) {
	const match = String(source || "").match(/mods\/(\d+)/i);
	const tail = match?.[1] || "";
	return tail ? `Mod/${tail}` : "";
}

async function hasPreviewImage(modDir: string) {
	try {
		if (!(await exists(modDir))) return false;
		const entries = await readDir(modDir);
		return entries.some((entry) => {
			if (entry.isDirectory || !entry.name) return false;
			if (!entry.name.toLowerCase().startsWith("preview.")) return false;
			const ext = entry.name.split(".").pop()?.toLowerCase() || "";
			return exts.includes(ext);
		});
	} catch {
		return false;
	}
}

async function fetchPreviewUrl(source: string) {
	const route = sourceToModRoute(source);
	if (!route) return "";
	try {
		const mod = (await apiClient.mod(route)) as Pick<OnlineMod, "_aPreviewMedia">;
		const image = mod?._aPreviewMedia?._aImages?.[0];
		if (!image?._sBaseUrl || !image?._sFile) return "";
		return `${image._sBaseUrl}/${image._sFile}`;
	} catch {
		return "";
	}
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPreviewBackfill(report: LinkAuditReport | null = store.get(LINK_AUDIT_REPORT)) {
	if (!report || previewBackfillRunning) return;
	previewBackfillRunning = true;
	const initial: PreviewBackfillState = {
		running: true,
		queued: 0,
		completed: 0,
		failed: 0,
		skippedCooldown: 0,
		lastRunAt: Date.now(),
	};
	store.set(PREVIEW_BACKFILL_STATE, initial);
	try {
		const tasks = [] as Array<{ game: Games; modPath: string; modDir: string; source: string }>;
		for (const gameReport of report.games) {
			for (const mod of gameReport.matched) {
				if (!mod.source) continue;
				const modDir = join(gameReport.modRoot, mod.path);
				if (!(await exists(modDir))) continue;
				if (await hasPreviewImage(modDir)) continue;
				tasks.push({ game: gameReport.game, modPath: mod.path, modDir, source: mod.source });
			}
		}
		store.set(PREVIEW_BACKFILL_STATE, (prev) => ({
			...prev,
			queued: tasks.length,
			lastRunAt: Date.now(),
		}));
		for (const task of tasks) {
			const cooldownUntil = previewFailureCooldown.get(task.source) || 0;
			if (cooldownUntil > Date.now()) {
				store.set(PREVIEW_BACKFILL_STATE, (prev) => ({
					...prev,
					skippedCooldown: prev.skippedCooldown + 1,
				}));
				continue;
			}
			const previewUrl = await fetchPreviewUrl(task.source);
			if (!previewUrl) {
				previewFailureCooldown.set(task.source, Date.now() + PREVIEW_COOLDOWN_MS);
				store.set(PREVIEW_BACKFILL_STATE, (prev) => ({
					...prev,
					failed: prev.failed + 1,
					lastError: `[${task.game}] ${task.modPath}: preview url missing`,
				}));
				continue;
			}
			try {
				await invoke("download_and_unzip", {
					fileName: "preview",
					downloadUrl: previewUrl,
					savePath: task.modDir,
					key: `preview_backfill_${task.game}_${task.modPath}_${Date.now()}`,
					emit: false,
					downloadOptions: {
						connectTimeoutSec: 8,
						stallTimeoutSec: 20,
						requestRetries: 2,
						progressIntervalMs: 1000,
						progressBytesThreshold: 262144,
						backoffBaseMs: 1500,
						maxConcurrentExtracts: 1,
					},
				});
				store.set(PREVIEW_BACKFILL_STATE, (prev) => ({
					...prev,
					completed: prev.completed + 1,
				}));
			} catch {
				previewFailureCooldown.set(task.source, Date.now() + PREVIEW_COOLDOWN_MS);
				store.set(PREVIEW_BACKFILL_STATE, (prev) => ({
					...prev,
					failed: prev.failed + 1,
					lastError: `[${task.game}] ${task.modPath}: preview download failed`,
				}));
			}
			await sleep(PREVIEW_DELAY_MS);
		}
		if (tasks.length > 0) {
			store.set(LAST_UPDATED, Date.now());
		}
	} finally {
		store.set(PREVIEW_BACKFILL_STATE, (prev) => ({ ...prev, running: false, lastRunAt: Date.now() }));
		previewBackfillRunning = false;
	}
}

let startupMaintenancePromise: Promise<void> | null = null;
export function startIntegrityMaintenanceOnLaunch() {
	if (startupMaintenancePromise) return startupMaintenancePromise;
	startupMaintenancePromise = (async () => {
		try {
			const report = await runLinkIntegrityScan();
			void runPreviewBackfill(report);
		} catch {
			const textData = store.get(TEXT_DATA) as { _Toasts?: { ErrOcc?: string } };
			addToast({
				type: "error",
				message: textData?._Toasts?.ErrOcc || "Link integrity maintenance failed",
			});
		}
	})();
	return startupMaintenancePromise;
}

export function resetIntegrityMaintenanceForGameSwitch() {
	// Game switch should allow another startup scan after init refresh.
	startupMaintenancePromise = null;
	const currentGame = store.get(GAME);
	if (!currentGame) {
		store.set(LINK_AUDIT_REPORT, null);
	}
}
