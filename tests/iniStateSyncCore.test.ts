import test from "node:test";
import assert from "node:assert/strict";

import { syncIniStateFromText } from "../src/utils/iniStateSyncCore.js";

test("syncIniStateFromText writes file and namespace states back to config data", () => {
	const data = {
		"角色\\裙子Mod": {
			namespace: "AvatarDress",
			vars: {
				"config.ini": {
					skirt: {
						state: "0",
					},
				},
				namespace: {
					dress: {
						state: "short",
					},
				},
			},
		},
	};

	const result = syncIniStateFromText(
		[
			"; comment should be ignored",
			"$\\mods\\ShaderFixes\\角色\\裙子Mod\\config.ini\\skirt = 2",
			"$\\AvatarDress\\dress = long",
		].join("\n"),
		data,
		[{ path: "角色\\裙子Mod", namespace: "AvatarDress" }],
		"ShaderFixes"
	);

	assert.deepEqual(result.changedMods, ["角色\\裙子Mod"]);
	assert.equal(result.nextData["角色\\裙子Mod"].vars["config.ini"].skirt.state, "2");
	assert.equal(result.nextData["角色\\裙子Mod"].vars.namespace.dress.state, "long");
	assert.equal(data["角色\\裙子Mod"].vars["config.ini"].skirt.state, "0");
});

test("syncIniStateFromText only reports mods whose state actually changed", () => {
	const data = {
		"A\\One": {
			vars: {
				"a.ini": {
					alpha: {
						state: "1",
					},
				},
			},
		},
		"B\\Two": {
			vars: {
				"b.ini": {
					beta: {
						state: "5",
					},
				},
			},
		},
	};

	const result = syncIniStateFromText(
		[
			"$\\mods\\ShaderFixes\\A\\One\\a.ini\\alpha = 1",
			"$\\mods\\ShaderFixes\\B\\Two\\b.ini\\beta = 8",
		].join("\n"),
		data,
		[{ path: "A\\One" }, { path: "B\\Two" }],
		"ShaderFixes"
	);

	assert.deepEqual(result.changedMods, ["B\\Two"]);
	assert.equal(result.nextData["A\\One"].vars["a.ini"].alpha.state, "1");
	assert.equal(result.nextData["B\\Two"].vars["b.ini"].beta.state, "8");
});

test("syncIniStateFromText creates missing variable nodes for tracked mods", () => {
	const data = {
		"角色\\新Mod": {},
	};

	const result = syncIniStateFromText(
		"$\\mods\\ShaderFixes\\角色\\新Mod\\options.ini\\dress = ribbon",
		data,
		[{ path: "角色\\新Mod" }],
		"ShaderFixes"
	);

	assert.deepEqual(result.changedMods, ["角色\\新Mod"]);
	assert.equal(result.nextData["角色\\新Mod"].vars["options.ini"].dress.state, "ribbon");
});
