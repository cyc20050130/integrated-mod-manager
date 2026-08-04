import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeGameBananaImage,
	normalizeGameBananaPreviewMedia,
	normalizeGameBananaTopSubImage,
} from "../src/utils/gameBananaPreview.ts";

const base = "https://images.gamebanana.com/img/ss/Mods/23012/";

test("normalizes the preferred GameBanana image field without collapsing distinct URLs", () => {
	const first = normalizeGameBananaImage({ _sBaseUrl: base, _sFile: "first.png", _sFile530: "fallback.png" });
	const second = normalizeGameBananaImage({ _sBaseUrl: base, _sFile: "second.png" });
	assert.equal(first.kind, "ready");
	assert.equal(second.kind, "ready");
	if (first.kind !== "ready" || second.kind !== "ready") return;
	assert.notEqual(first.url, second.url);
});

test("falls through to valid alternate fields and distinguishes missing from malformed", () => {
	const alternate = normalizeGameBananaImage({
		_sBaseUrl: base,
		_sFile: "https://evil.example/file.png",
		_sFile530: "safe.png",
	});
	const missing = normalizeGameBananaPreviewMedia({ _aImages: [] });
	const malformed = normalizeGameBananaPreviewMedia({
		_aImages: [{ _sBaseUrl: base, _sFile: "https://evil.example/file.png" }],
	});
	assert.equal(alternate.kind, "ready");
	assert.equal(missing.kind, "missing");
	assert.equal(malformed.kind, "error");
});

test("rejects absolute overrides, unsafe hosts, and malformed TopSubs URLs", () => {
	assert.equal(normalizeGameBananaImage({ _sBaseUrl: base, _sFile: "//evil.example/a.png" }).kind, "error");
	assert.equal(normalizeGameBananaImage({ _sBaseUrl: "https://evil.example/", _sFile: "a.png" }).kind, "error");
	assert.equal(normalizeGameBananaTopSubImage("https://images.gamebanana.com/img/ss/Mods/23012/top.png").kind, "ready");
	assert.equal(normalizeGameBananaTopSubImage("javascript:alert(1)").kind, "error");
});
