import type { Category } from "./types";

export const NTE_GAME_BANANA_ID = 23012;
const GAMEBANANA_API = "https://gamebanana.com/apiv11";
const NTE_ROOT_CATEGORIES = new Map<number, string>([
	[37906, "Skins"],
	[43029, "UI"],
	[37898, "Other"],
]);

type NteCategoryRecord = {
	_idRow?: number;
	_sName?: string;
	_nItemCount?: number;
	_nCategoryCount?: number;
	_sUrl?: string;
	_sIconUrl?: string;
};

function encode(value: string | number) {
	return encodeURIComponent(String(value));
}

const NTE_SORTS: Readonly<Record<string, string | null>> = Object.freeze({
	default: null,
	newest: "Generic_Newest",
	popular: "Generic_MostLiked",
	updated: "Generic_LatestModified",
});

export function normalizeNteSort(sort: string): string | null {
	if (!Object.hasOwn(NTE_SORTS, sort)) {
		throw new Error(`unsupported NTE sort: ${sort}`);
	}
	return NTE_SORTS[sort];
}

function appendNteSort(params: URLSearchParams, sort: string) {
	const normalized = normalizeNteSort(sort);
	if (normalized) params.set("_sSort", normalized);
}

export function buildNteHomeUrl({
	page = 1,
	sort = "default",
	type = "",
}: { page?: number; sort?: string; type?: string } = {}) {
	const params = new URLSearchParams();
	if (type) params.set("_csvModelInclusions", type);
	appendNteSort(params, sort);
	params.set("_nPage", String(Math.max(1, page)));
	return `${GAMEBANANA_API}/Game/${NTE_GAME_BANANA_ID}/Subfeed?${params.toString()}`;
}

export function buildNteSearchUrl(term: string, page = 1, type = "Mod") {
	return `${GAMEBANANA_API}/Util/Search/Results?_sModelName=${encode(type)}&_sOrder=best_match&_idGameRow=${NTE_GAME_BANANA_ID}&_sSearchString=${encode(term)}&_nPage=${Math.max(1, page)}`;
}

export function buildNteCategoryUrl(categoryId: number, page = 1, sort = "default") {
	if (!NTE_ROOT_CATEGORIES.has(categoryId)) {
		throw new Error(`unsupported NTE category: ${categoryId}`);
	}
	const params = new URLSearchParams();
	params.set("_nPerpage", "15");
	params.set("_aFilters[Generic_Category]", String(categoryId));
	appendNteSort(params, sort);
	params.set("_nPage", String(Math.max(1, page)));
	return `${GAMEBANANA_API}/Mod/Index?${params.toString()}`;
}

export function normalizeNteCategories(records: unknown): Category[] {
	if (!Array.isArray(records)) return [];
	return records.flatMap((record): Category[] => {
		if (!record || typeof record !== "object") return [];
		const value = record as NteCategoryRecord;
		const id = value._idRow;
		if (typeof id !== "number") return [];
		const name = NTE_ROOT_CATEGORIES.get(id);
		if (!name) return [];
		return [
			{
				_idRow: id,
				_sName: name,
				_nItemCount: Number.isFinite(value._nItemCount) ? Number(value._nItemCount) : 0,
				_nCategoryCount: Number.isFinite(value._nCategoryCount) ? Number(value._nCategoryCount) : 0,
				_sUrl: typeof value._sUrl === "string" ? value._sUrl : `https://gamebanana.com/mods/cats/${id}`,
				_sIconUrl: typeof value._sIconUrl === "string" ? value._sIconUrl : "",
			},
		];
	});
}
