import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readMainOnlineSource() {
	return readFileSync(new URL("../src/_Main/MainOnline.tsx", import.meta.url), "utf8");
}

test("online list route loader does not reset scroll on every online data update", () => {
	const source = readMainOnlineSource();

	assert.match(source, /const onlineDataRef = useRef\(onlineData\)/);
	assert.match(source, /onlineDataRef\.current\[onlineCacheKey\]/);
	assert.doesNotMatch(
		source,
		/\}, \[initialLoad, onlineCacheKey, onlineData, onlinePath, onlineSort, onlineType, setOnlineData, types\]\);/
	);
});
