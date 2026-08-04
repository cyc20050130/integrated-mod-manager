import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readMainOnlineSource() {
	return readFileSync(new URL("../src/_Main/MainOnline.tsx", import.meta.url), "utf8");
}

test("online route changes cancel stale requests and fail closed", () => {
	const source = readMainOnlineSource();

	assert.match(source, /const requestGenerationRef = useRef\(0\)/);
	assert.match(source, /routeControllerRef\.current\?\.abort\(\)/);
	assert.match(source, /const generation = \+\+requestGenerationRef\.current/);
	assert.match(source, /controller\.signal\.aborted \|\| generation !== requestGenerationRef\.current/);
	assert.match(source, /\[onlinePath\]: \[\]/);
	assert.match(source, /clearCurrentCatalog\(\);\s*setOnlineLoadError\(onlineErrorMessage\(error\)\)/);
	assert.doesNotMatch(source, /onlineDataRef/);
});
