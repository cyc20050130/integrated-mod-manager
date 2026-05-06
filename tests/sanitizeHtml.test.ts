import assert from "node:assert/strict";
import { test } from "node:test";

import { isSafeExternalUrl, sanitizeHtml } from "../src/utils/sanitizeHtml.ts";

test("sanitizeHtml removes script tags and event handlers", () => {
	const html = '<p onclick="alert(1)">ok</p><script>alert(2)</script><img src="x" onerror="alert(3)">';

	const sanitized = sanitizeHtml(html);

	assert.equal(sanitized.includes("<script"), false);
	assert.equal(sanitized.includes("onclick"), false);
	assert.equal(sanitized.includes("onerror"), false);
	assert.equal(sanitized.includes("ok"), true);
});

test("sanitizeHtml removes javascript urls while preserving ordinary links", () => {
	const html = '<a href="javascript:alert(1)">bad</a><a href="https://example.com/mod">good</a>';

	const sanitized = sanitizeHtml(html);

	assert.equal(sanitized.includes("javascript:"), false);
	assert.equal(sanitized.includes("https://example.com/mod"), true);
});

test("sanitizeHtml adds noopener noreferrer to blank-target links", () => {
	const html = '<a href="https://example.com/mod" target="_blank">good</a>';

	const sanitized = sanitizeHtml(html);

	assert.match(sanitized, /rel="[^"]*noopener[^"]*"/);
	assert.match(sanitized, /rel="[^"]*noreferrer[^"]*"/);
});

test("sanitizeHtml removes file and data urls", () => {
	const html = '<a href="file:///C:/secret.txt">file</a><img src="data:text/html;base64,PHNjcmlwdA==">';

	const sanitized = sanitizeHtml(html);

	assert.equal(sanitized.includes("file:"), false);
	assert.equal(sanitized.includes("data:"), false);
});

test("isSafeExternalUrl only allows http and https urls", () => {
	assert.equal(isSafeExternalUrl("https://example.com/mod"), true);
	assert.equal(isSafeExternalUrl("http://example.com/mod"), true);
	assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
	assert.equal(isSafeExternalUrl("file:///C:/secret.txt"), false);
	assert.equal(isSafeExternalUrl("/relative/path"), false);
});
