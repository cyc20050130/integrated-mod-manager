import { invoke } from "@tauri-apps/api/core";

import GAME_DATA from "@/gameData.json";
import { VERSION } from "./consts";
import { saveConfigs } from "./filesys";
import { buildNteCategoryUrl, buildNteHomeUrl, buildNteSearchUrl, normalizeNteCategories } from "./gameBananaNte";
import type { RegisteredGame } from "./gameRegistry";
import type { Category } from "./types";
import { SETTINGS, store } from "./vars";

const API_BASE_URL = "https://gamebanana.com/apiv11/";
const CATEGORY_TIMEOUTS_MS = [2_000, 5_000] as const;

type HealthCheckResponse = {
	client?: string;
};

type GameDataEntry = {
	id: { categories: string; game: string };
	categoryList: Category[];
	generic: { categories: Category[]; types: Category[] };
};

export interface GameBananaCategoryResult {
	categories: Category[];
	types: Category[];
}

function cloneCategory(category: Category): Category {
	return Object.freeze({ ...category });
}

function cloneCategories(categories: readonly Category[]): readonly Category[] {
	return Object.freeze(categories.map(cloneCategory));
}

function createAbortError(): DOMException {
	return new DOMException("The request was aborted", "AbortError");
}

export function isGameBananaAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError") ||
		/gamebanana request cancelled/i.test(String(error || ""))
	);
}

let requestSequence = 0;

function createRequestId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
	return `renderer-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export async function fetchGameBananaJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw createAbortError();

	const requestId = createRequestId();
	const cancelNativeRequest = () => {
		void invoke("cancel_gamebanana_request", { requestId }).catch(() => undefined);
	};
	signal?.addEventListener("abort", cancelNativeRequest, { once: true });

	try {
		const payload = await invoke<T>("fetch_gamebanana_json", { url, requestId });
		if (signal?.aborted) throw createAbortError();
		return payload;
	} catch (error) {
		if (signal?.aborted || isGameBananaAbortError(error)) throw createAbortError();
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelNativeRequest);
	}
}

function requestSignalWithTimeout(timeoutMs: number, parent?: AbortSignal) {
	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	parent?.addEventListener("abort", abortFromParent, { once: true });
	const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		dispose() {
			window.clearTimeout(timeoutId);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export class GameBananaProvider {
	readonly game: RegisteredGame;
	readonly gameId: string;
	readonly categoryRootId: string;
	readonly categoryList: readonly Category[];
	readonly genericCategories: readonly Category[];
	readonly types: readonly Category[];

	constructor(game: RegisteredGame) {
		const config = GAME_DATA[game] as GameDataEntry;
		this.game = game;
		this.gameId = config.id.game;
		this.categoryRootId = config.id.categories;
		this.categoryList = cloneCategories(config.categoryList);
		this.genericCategories = cloneCategories(config.generic.categories);
		this.types = cloneCategories(config.generic.types);
		Object.freeze(this);
	}

	get fallbackCategories(): Category[] {
		return [...this.categoryList, ...this.genericCategories].map((category) => ({ ...category }));
	}

	get fallbackTypes(): Category[] {
		return this.types.map((category) => ({ ...category }));
	}

	async makeRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
		return fetchGameBananaJson<T>(`${API_BASE_URL}${endpoint}`, options.signal ?? undefined);
	}

	async categories(signal?: AbortSignal): Promise<GameBananaCategoryResult> {
		if (this.game === "NTE") {
			const profile = await this.makeRequest<{ _aModRootCategories?: unknown }>(
				`Game/${this.gameId}/ProfilePage`,
				signal ? { signal } : {}
			);
			const rootCategories = normalizeNteCategories(profile._aModRootCategories);
			return { categories: rootCategories, types: rootCategories.map((category) => ({ ...category })) };
		}

		let lastError: unknown = new Error("Category fetch exhausted retries");
		for (const timeoutMs of CATEGORY_TIMEOUTS_MS) {
			const attempt = requestSignalWithTimeout(timeoutMs, signal);
			try {
				const response = await this.makeRequest<Category[]>(
					`Mod/Categories?_idCategoryRow=${this.categoryRootId}&_sSort=a_to_z&_bShowEmpty=true`,
					{ signal: attempt.signal }
				);
				if (!response) throw new Error("Empty category response");
				const categories = [...response.filter((category) => category._idRow !== 31838), ...this.genericCategories];
				return {
					categories: categories.map((category) => ({ ...category })),
					types: this.fallbackTypes,
				};
			} catch (error) {
				lastError = error;
				if (signal?.aborted) throw createAbortError();
			} finally {
				attempt.dispose();
			}
		}
		throw lastError;
	}

	home({ sort = "default", page = 1, type = "" }: { sort?: string; page?: number; type?: string }) {
		if (this.game === "NTE") return buildNteHomeUrl({ sort, page, type });
		return `${API_BASE_URL}Game/${this.gameId}/Subfeed?${
			type ? `_csvModelInclusions=${encodeURIComponent(type)}&` : ""
		}_sSort=${encodeURIComponent(sort)}&_nPage=${Math.max(1, page)}`;
	}

	category({
		cat = "",
		sort = "default",
		page = 1,
		runtimeCategories = [],
	}: {
		cat?: string;
		sort?: string;
		page?: number;
		runtimeCategories?: readonly Category[];
	}) {
		const parts = cat.split("/").filter(Boolean);
		const categoryName = parts.length > 1 ? parts[1] : parts[0] || "";
		const configuredPool = parts.length > 1 ? this.categoryList : this.types;
		const category =
			configuredPool.find((entry) => entry._sName === categoryName) ||
			runtimeCategories.find((entry) => entry._sName === categoryName);
		const categoryId = category?._idRow || 0;
		if (this.game === "NTE") return buildNteCategoryUrl(categoryId, page, sort);
		return `${API_BASE_URL}Mod/Index?_nPerpage=15&_aFilters%5BGeneric_Category%5D=${categoryId}&_sSort=${encodeURIComponent(
			sort
		)}&_nPage=${Math.max(1, page)}`;
	}

	banner() {
		return `${API_BASE_URL}Game/${this.gameId}/TopSubs`;
	}

	mod<T = unknown>(mod = "Mod/0", signal?: AbortSignal): Promise<T> {
		return this.makeRequest<T>(`${mod}/ProfilePage`, signal ? { signal } : {});
	}

	updates<T = unknown>(mod = "Mod/0", signal?: AbortSignal): Promise<T> {
		return this.makeRequest<T>(`${mod}/Updates?_nPage=1&_nPerpage=5`, signal ? { signal } : {});
	}

	comments<T = unknown>(mod = "Mod/0", page = 1, signal?: AbortSignal): Promise<T> {
		return this.makeRequest<T>(`${mod}/Posts?_nPage=${page}&_nPerpage=15&_sSort=popular`, signal ? { signal } : {});
	}

	nestedComments<T = unknown>(postId = "0", signal?: AbortSignal): Promise<T> {
		return this.makeRequest<T>(`Post/${postId}/Posts?_nPage=1&_nPerpage=15`, signal ? { signal } : {});
	}

	search({ term = "", page = 1, type = "" }) {
		if (this.game === "NTE") return buildNteSearchUrl(term, page, type || "Mod");
		return `${API_BASE_URL}Util/Search/Results?_sModelName=${encodeURIComponent(
			type
		)}&_sOrder=best_match&_idGameRow=${this.gameId}&_sSearchString=${encodeURIComponent(term)}&_nPage=${Math.max(
			1,
			page
		)}`;
	}
}

const providers = new Map<RegisteredGame, GameBananaProvider>();

export function getGameBananaProvider(game: RegisteredGame): GameBananaProvider {
	let provider = providers.get(game);
	if (!provider) {
		provider = new GameBananaProvider(game);
		providers.set(game, provider);
	}
	return provider;
}

let healthCheckPromise: Promise<void> | null = null;

export function runServiceHealthCheckOnce(game: RegisteredGame, client: string): Promise<void> {
	if (healthCheckPromise) return healthCheckPromise;
	healthCheckPromise = (async () => {
		try {
			const data = await invoke<HealthCheckResponse>("service_health_check", {
				version: VERSION || "2.0.1",
				game,
				client: client || null,
			});
			if (!client && data.client) {
				store.set(SETTINGS, (previous) => ({
					...previous,
					global: {
						...previous.global,
						clientDate: data.client || previous.global.clientDate || "",
					},
				}));
				await saveConfigs();
			}
		} catch {
			// Best-effort telemetry must not affect startup or catalog availability.
		}
	})();
	return healthCheckPromise;
}
