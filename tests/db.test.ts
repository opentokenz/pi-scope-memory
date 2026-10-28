import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { closeMemoryDb, openMemoryDb } from "../src/db.ts";
import { saveMemory, searchMemories } from "../src/memory.ts";
import { resolveScope } from "../src/scope.ts";
import { cleanupTempDirs, makeConfig, scopeConfig, tempRoot, useIsolatedHome, writeFile } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => {
	cleanupTempDirs();
});

test("v1 数据库迁移到 trigram 索引并保留原有记忆", () => {
	const base = tempRoot();
	useIsolatedHome(base);
	const root = join(base, "workspace");
	writeFile(root, "README.md", "workspace\n");
	const config = makeConfig([scopeConfig(root, { repos: {} })]);
	const scope = resolveScope(config, root);
	assert.equal(scope.active, true);
	if (!scope.active) throw new Error("scope resolution failed");

	const db = openMemoryDb("enterprise");
	saveMemory(
		db,
		scope.resolved,
		{
			action: "upsert",
			kind: "preference",
			layer: "shared",
			title: "数据库表结构变更脚本归档规则",
			content: "数据库变更脚本统一放在 docs/sql/mysql/ 下，命名形如 YYYY-MM-DD-特性名.sql。",
		},
		config.defaults.retrieval,
	);

	// 模拟 v1：旧 tokenizer 的 FTS 表，版本号回到 1。触发器和 memories 数据保留。
	db.sqlite.exec("DROP TABLE memory_fts");
	db.sqlite.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
		title,
		content,
		content='memories',
		content_rowid='rowid',
		tokenize='porter'
	)`);
	db.sqlite.exec("PRAGMA user_version = 1");
	closeMemoryDb(db);

	const migrated = openMemoryDb("enterprise");
	try {
		const version = migrated.sqlite.prepare("PRAGMA user_version").get();
		assert.equal(Number(version?.user_version), 2);
		const ftsSql = migrated.sqlite
			.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'")
			.get();
		assert.match(String(ftsSql?.sql), /trigram/);

		const backupDir = join(base, "data", "scopes", "enterprise", "backups");
		assert.equal(existsSync(backupDir), true);
		assert.ok(readdirSync(backupDir).length > 0, "迁移前必须留下 VACUUM INTO 备份");

		const hits = searchMemories(
			migrated,
			scope.resolved,
			{ query: "数据库表结构变更脚本放在哪里" },
			config.defaults.retrieval,
		);
		assert.equal(hits.hits.length, 1, "重建后的索引必须能检索到原有记忆");
		assert.equal(hits.hits[0]?.matchedBy, "fts", "中文长句应由 trigram 索引命中");
	} finally {
		closeMemoryDb(migrated);
	}
});
