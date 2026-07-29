import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("production CSP limits network and image origins", () => {
	const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
		app?: { security?: { csp?: string | null } };
	};
	const csp = config.app?.security?.csp || "";

	assert.ok(csp);
	const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] || "";
	const imageSrc = csp.match(/img-src\s+([^;]+)/)?.[1] || "";
	assert.ok(connectSrc);
	assert.ok(imageSrc);
	assert.match(connectSrc, /http:\/\/ipc\.localhost/);
	assert.doesNotMatch(connectSrc.replace("http://ipc.localhost", ""), /https?:/);
	assert.doesNotMatch(imageSrc, /https?:/);
	assert.match(imageSrc, /asset:/);
	assert.match(imageSrc, /data:/);
	assert.match(csp, /object-src 'none'/);
	assert.doesNotMatch(connectSrc, /(^|\s)\*(?:\s|$)/);
});
