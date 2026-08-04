import assert from "node:assert/strict";
import test from "node:test";

import {
	NTE_GAME_BANANA_ID,
	buildNteCategoryUrl,
	buildNteHomeUrl,
	buildNteSearchUrl,
	normalizeNteSort,
	normalizeNteCategories,
} from "../src/utils/gameBananaNte.ts";

test("NTE provider scopes home and search requests to GameBanana game 23012", () => {
	assert.match(buildNteHomeUrl({ page: 2, sort: "newest", type: "Mod" }), /Game\/23012\/Subfeed/);
	assert.match(buildNteHomeUrl({ page: 2, sort: "newest", type: "Mod" }), /_nPage=2/);
	assert.match(buildNteSearchUrl("Iroi swimsuit", 3), /_idGameRow=23012/);
	assert.match(buildNteSearchUrl("Iroi swimsuit", 3), /_nPage=3/);
	assert.equal(NTE_GAME_BANANA_ID, 23012);
});

test("NTE sort values map only the four UI options to approved GameBanana values", () => {
	const defaultHome = new URL(buildNteHomeUrl({ sort: "default" }));
	assert.equal(defaultHome.searchParams.has("_sSort"), false);
	assert.equal(new URL(buildNteCategoryUrl(37906, 1, "default")).searchParams.has("_sSort"), false);

	const expected = new Map([
		["newest", "Generic_Newest"],
		["popular", "Generic_MostLiked"],
		["updated", "Generic_LatestModified"],
	]);
	for (const [sort, apiSort] of expected) {
		assert.equal(new URL(buildNteHomeUrl({ sort })).searchParams.get("_sSort"), apiSort);
		assert.equal(new URL(buildNteCategoryUrl(37906, 1, sort)).searchParams.get("_sSort"), apiSort);
	}

	assert.equal(normalizeNteSort("default"), null);
	assert.throws(() => normalizeNteSort(""), /unsupported NTE sort/);
	assert.throws(() => normalizeNteSort("Generic_Newest"), /unsupported NTE sort/);
	assert.throws(() => buildNteHomeUrl({ sort: "date" }), /unsupported NTE sort/);
});

test("NTE category URLs use only the approved root category ids", () => {
	assert.match(buildNteCategoryUrl(37906, 1), /Generic_Category%5D=37906/);
	assert.match(buildNteCategoryUrl(43029, 1), /Generic_Category%5D=43029/);
	assert.match(buildNteCategoryUrl(37898, 1), /Generic_Category%5D=37898/);
	assert.throws(() => buildNteCategoryUrl(99999, 1), /unsupported NTE category/);
});

test("NTE provider normalizes live root categories and tolerates unknown future categories", () => {
	const categories = normalizeNteCategories([
		{ _idRow: 37906, _sName: "Skins", _nItemCount: 208, _nCategoryCount: 22, _sUrl: "https://gamebanana.com/mods/cats/37906" },
		{ _idRow: 43029, _sName: "UI", _nItemCount: 16, _nCategoryCount: 0, _sUrl: "https://gamebanana.com/mods/cats/43029" },
		{ _idRow: 37898, _sName: "Other/Misc", _nItemCount: 7, _nCategoryCount: 0, _sUrl: "https://gamebanana.com/mods/cats/37898" },
		{ _idRow: 50000, _sName: "New Future Bucket", _nItemCount: 1, _nCategoryCount: 0, _sUrl: "https://gamebanana.com/mods/cats/50000" },
	]);

	assert.deepEqual(categories.map((category) => category._sName), ["Skins", "UI", "Other"]);
	assert.equal(categories[2]._idRow, 37898);
});
