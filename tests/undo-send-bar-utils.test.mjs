import assert from "node:assert/strict";
import test from "node:test";
import * as bar from "../src/components/compose/undo-send-utils.ts";
import * as avatar from "../src/components/progressive-avatar-image-utils.ts";

test("the countdown rounds up, stops short of the queue release and never goes negative", () => {
	const until = 100_000;
	assert.equal(bar.undoCountdownSeconds(until, 90_000), 10);
	assert.equal(bar.undoCountdownSeconds(until, until - bar.UNDO_SAFETY_MARGIN_MS - 1), 1);
	assert.equal(bar.undoCountdownSeconds(until, until - bar.UNDO_SAFETY_MARGIN_MS), 0);
	assert.equal(bar.undoCountdownSeconds(until, until + 5_000), 0);
});

test("the subject link points at the queued message in Sent", () => {
	assert.equal(bar.sentMessageHref("abc123"), "/sent/abc123");
	assert.equal(bar.sentMessageHref("a/b c"), "/sent");
	assert.equal(bar.sentMessageHref('x"><img src=x>'), "/sent");
});

function memoryStore() {
	const data = new Map();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: (key) => void data.delete(key),
	};
}

test("a loaded versioned avatar is remembered until its cache lifetime ends", () => {
	const store = memoryStore();
	const src = "/api/profile/avatar?v=123";
	assert.equal(avatar.wasAvatarLoaded(src, 1_000, store), false);
	avatar.rememberAvatarLoaded(src, 1_000, store);
	assert.equal(avatar.wasAvatarLoaded(src, 2_000, store), true);
	assert.equal(avatar.wasAvatarLoaded("/api/profile/avatar?v=124", 2_000, store), false);
	assert.equal(avatar.wasAvatarLoaded(src, 1_000 + avatar.AVATAR_LOADED_TTL_MS + 1, store), false);
});

test("an unversioned avatar is revalidated by the server, so it is never remembered", () => {
	const store = memoryStore();
	avatar.rememberAvatarLoaded("/api/profile/avatar", 1_000, store);
	assert.equal(avatar.wasAvatarLoaded("/api/profile/avatar", 2_000, store), false);
	assert.equal(store.getItem(avatar.AVATAR_LOADED_STORAGE_KEY), null);
});

test("the remembered list is bounded and survives corrupt storage", () => {
	const store = memoryStore();
	for (let i = 0; i < 250; i++) avatar.rememberAvatarLoaded(`/a?v=${i}`, 1_000 + i, store);
	assert.equal(Object.keys(JSON.parse(store.getItem(avatar.AVATAR_LOADED_STORAGE_KEY))).length, 200);
	assert.equal(avatar.wasAvatarLoaded("/a?v=0", 2_000, store), false);
	assert.equal(avatar.wasAvatarLoaded("/a?v=249", 2_000, store), true);
	store.setItem(avatar.AVATAR_LOADED_STORAGE_KEY, "{not json");
	assert.equal(avatar.wasAvatarLoaded("/a?v=1", 2_000, store), false);
	avatar.rememberAvatarLoaded("/a?v=1", 2_000, store);
	assert.equal(avatar.wasAvatarLoaded("/a?v=1", 2_001, store), true);
	assert.equal(avatar.wasAvatarLoaded("/a?v=1", 2_000, null), false);
});

test("the stored list is parsed once until it changes, and signing out forgets it", () => {
	let reads = 0;
	const base = memoryStore();
	const store = { ...base, getItem: (key) => (reads++, base.getItem(key)) };
	avatar.rememberAvatarLoaded("/a?v=1", 1_000, store);
	const original = JSON.parse;
	let parses = 0;
	JSON.parse = (...args) => (parses++, original(...args));
	try {
		for (let i = 0; i < 50; i++) assert.equal(avatar.wasAvatarLoaded("/a?v=1", 2_000, store), true);
		assert.equal(parses, 0);
	} finally {
		JSON.parse = original;
	}
	avatar.forgetLoadedAvatars(store);
	assert.equal(avatar.wasAvatarLoaded("/a?v=1", 2_000, store), false);
	assert.equal(store.getItem(avatar.AVATAR_LOADED_STORAGE_KEY), null);
});
