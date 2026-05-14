import assert from "node:assert/strict";
import test from "node:test";
import {
	getPortableUpdateUrl,
	isPortableInstallDir,
} from "../src/utils/updateMode.ts";

test("portable install detection treats D drive launch outside LocalAppData as portable", () => {
	assert.equal(
		isPortableInstallDir("D:\\Integrated Mod Manager (IMM)", "C:\\Users\\cyc20\\AppData\\Local"),
		true
	);
});

test("portable install detection treats LocalAppData install as managed", () => {
	assert.equal(
		isPortableInstallDir(
			"C:\\Users\\cyc20\\AppData\\Local\\Integrated Mod Manager (IMM)",
			"C:\\Users\\cyc20\\AppData\\Local"
		),
		false
	);
});

test("portable update url reads windows installer url from updater raw json", () => {
	assert.equal(
		getPortableUpdateUrl({
			platforms: {
				"windows-x86_64": {
					url: "https://github.com/cyc20050130/integrated-mod-manager/releases/download/v3.2.17/Integrated.Mod.Manager.IMM._3.2.17_x64-setup.exe",
				},
			},
		}),
		"https://github.com/cyc20050130/integrated-mod-manager/releases/download/v3.2.17/Integrated.Mod.Manager.IMM._3.2.17_x64-setup.exe"
	);
});

test("portable update url returns null when updater json has no windows asset", () => {
	assert.equal(getPortableUpdateUrl({ platforms: {} }), null);
});
