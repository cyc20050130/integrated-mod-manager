import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type CapabilityPermission =
	| string
	| {
			identifier?: string;
			allow?: string[] | Array<{ path?: string }>;
	  };

type CapabilityConfig = {
	permissions?: CapabilityPermission[];
};

type TauriConfig = {
	app?: {
		security?: {
			assetProtocol?: {
				scope?: string[];
			};
		};
	};
};

function readJson<T>(relativePath: string) {
	return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8")) as T;
}

test("desktop capability fs and opener scopes allow APPDATA for XXMI paths", () => {
	const capability = readJson<CapabilityConfig>("src-tauri/capabilities/default.json");
	const permissions = capability.permissions || [];
	const fsScope = permissions.find(
		(permission) => typeof permission !== "string" && permission.identifier === "fs:scope"
	) as Extract<CapabilityPermission, { identifier?: string }> | undefined;
	const openerScope = permissions.find(
		(permission) => typeof permission !== "string" && permission.identifier === "opener:allow-open-path"
	) as Extract<CapabilityPermission, { identifier?: string }> | undefined;

	assert.ok(fsScope);
	assert.ok(openerScope);
	assert.ok(Array.isArray(fsScope.allow));
	assert.ok(Array.isArray(openerScope.allow));
	assert.ok((fsScope.allow as string[]).includes("$APPDATA/**"));
	assert.ok((openerScope.allow as Array<{ path?: string }>).some((entry) => entry.path === "$APPDATA/**"));
});

test("asset protocol scope allows APPDATA previews from XXMI-managed folders", () => {
	const tauriConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");
	const scope = tauriConfig.app?.security?.assetProtocol?.scope || [];

	assert.ok(scope.includes("$APPDATA/**"));
});
