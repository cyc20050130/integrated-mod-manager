import { invoke } from "@tauri-apps/api/core";

const SUPPORTED_GAMES = ["WW", "ZZ", "GI", "SR", "EF", "NTE"] as const;
type SupportedGame = (typeof SUPPORTED_GAMES)[number];
type JsonObject = Record<string, unknown>;

export type AppConfigSnapshot = {
	stateRevision: string;
	globalRevision: number;
	gameRevision: number | null;
	global: JsonObject;
	game: JsonObject | null;
};

export type AppStateBootstrapStatus =
	| {
			status: "ready";
			revision: string;
			runtimeRoot: string;
			migratedFromSnapshot: string | null;
		}
	| {
			status: "recoveryRequired";
			error: string;
			controlRoot: string;
			snapshotCandidates: string[];
		}
	| { status: "pending" };

export function getAppStateBootstrapStatus() {
	return invoke<AppStateBootstrapStatus>("get_app_state_bootstrap_status");
}

export function retryAppStateBootstrap() {
	return invoke<AppStateBootstrapStatus>("retry_app_state_bootstrap");
}

export type ManagedConfigTarget = { kind: "global" } | { kind: "game"; game: SupportedGame };

let globalRevision: number | null = null;
const gameRevisions = new Map<SupportedGame, number>();
let saveQueue: Promise<void> = Promise.resolve();
let refreshQueue: Promise<void> = Promise.resolve();

function acceptSnapshot(snapshot: AppConfigSnapshot, game?: SupportedGame) {
	globalRevision = snapshot.globalRevision;
	if (game && typeof snapshot.gameRevision === "number") gameRevisions.set(game, snapshot.gameRevision);
}

export function acceptCommittedAppConfigSnapshot(snapshot: AppConfigSnapshot, game: string) {
	const gameName = asSupportedGame(game);
	if (!gameName) throw new Error("Committed application state has an invalid game identity.");
	acceptSnapshot(snapshot, gameName);
}

function asSupportedGame(value: unknown): SupportedGame | null {
	return typeof value === "string" && SUPPORTED_GAMES.includes(value as SupportedGame)
		? (value as SupportedGame)
		: null;
}

export function getManagedConfigTarget(path: string): ManagedConfigTarget | null {
	const normalized = path.replaceAll("/", "\\");
	if (normalized === "config.json") return { kind: "global" };
	const match = /^config(WW|ZZ|GI|SR|EF|NTE)\.json$/i.exec(normalized);
	if (!match) return null;
	const game = asSupportedGame(match[1].toUpperCase());
	return game ? { kind: "game", game } : null;
}

async function loadSnapshot(game?: SupportedGame) {
	const snapshot = await invoke<AppConfigSnapshot>("load_app_config", { game: game ?? null });
	acceptSnapshot(snapshot, game);
	return snapshot;
}

export async function readManagedConfigText(target: ManagedConfigTarget) {
	const snapshot = await loadSnapshot(target.kind === "game" ? target.game : undefined);
	const value = target.kind === "global" ? snapshot.global : snapshot.game;
	if (!value) throw new Error(`Managed ${target.kind} configuration is missing.`);
	return JSON.stringify(value, null, 2);
}

export function refreshAppConfigRevision(game?: SupportedGame) {
	const refresh = refreshQueue.then(async () => {
		await loadSnapshot(game);
	});
	refreshQueue = refresh.catch(() => undefined);
	return refresh;
}

export async function persistAppConfig(global?: JsonObject, game?: JsonObject) {
	const gameName = game ? asSupportedGame(game.game) : null;
	if (game && !gameName) throw new Error("Managed game configuration has an invalid game identity.");
	const save = saveQueue.then(async () => {
		await refreshQueue;
		if (globalRevision === null || (gameName && !gameRevisions.has(gameName))) {
			await loadSnapshot(gameName ?? undefined);
		}
		const snapshot = await invoke<AppConfigSnapshot>("save_app_config", {
			global: global ?? null,
			game: game ?? null,
			expectedGlobalRevision: global ? globalRevision : null,
			expectedGameRevision: gameName ? gameRevisions.get(gameName) : null,
		});
		acceptSnapshot(snapshot, gameName ?? undefined);
	});
	saveQueue = save.catch(() => undefined);
	await save;
}

export async function persistGameConfigWithModPreview(
	gameConfig: JsonObject,
	relativePath: string,
	previewUrl: string
) {
	const gameName = asSupportedGame(gameConfig.game);
	if (!gameName) throw new Error("Managed game configuration has an invalid game identity.");
	const save = saveQueue.then(async () => {
		await refreshQueue;
		if (globalRevision === null || !gameRevisions.has(gameName)) await loadSnapshot(gameName);
		const expectedGameRevision = gameRevisions.get(gameName);
		if (typeof expectedGameRevision !== "number") {
			throw new Error(`Managed ${gameName} configuration revision is unavailable.`);
		}
		const snapshot = await invoke<AppConfigSnapshot>("bind_gamebanana_mod", {
			game: gameName,
			relativePath,
			previewUrl,
			gameConfig,
			expectedGameRevision,
		});
		acceptSnapshot(snapshot, gameName);
	});
	saveQueue = save.catch(() => undefined);
	await save;
}

export async function writeManagedConfigText(target: ManagedConfigTarget, contents: string) {
	const value = JSON.parse(contents) as JsonObject;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Managed configuration must be a JSON object.");
	}
	if (target.kind === "global") await persistAppConfig(value);
	else await persistAppConfig(undefined, value);
}

export async function persistRuntimeConfigs(global: JsonObject, game?: JsonObject) {
	await persistAppConfig(global, game);
}
