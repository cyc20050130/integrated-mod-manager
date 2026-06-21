import assert from "node:assert/strict";
import test from "node:test";

import { computeLatestRemoteTimestamp, computeModUpdateStatus } from "../src/utils/modUpdateStatus.ts";

test("computeLatestRemoteTimestamp includes profile update timestamps even when files are unchanged", () => {
	const latest = computeLatestRemoteTimestamp(
		{
			_tsDateUpdated: 1774174140,
			_tsDateModified: 1774173938,
			_aFiles: [{ _tsDateAdded: 1774173938 }],
		},
		1774173938000
	);

	assert.equal(latest, 1774174140000);
});

test("computeModUpdateStatus flags unseen updates when GameBanana reports newer update metadata than file timestamps", () => {
	const result = computeModUpdateStatus({
		updatedAt: 1774173938000,
		viewedAt: 1774173938000,
		profile: {
			_tsDateUpdated: 1774174140,
			_tsDateModified: 1774173938,
			_aFiles: [{ _tsDateAdded: 1774173938 }],
		},
	});

	assert.equal(result.latest, 1774174140000);
	assert.equal(result.modStatus, 2);
});
