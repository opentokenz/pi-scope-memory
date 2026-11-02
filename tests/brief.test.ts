import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { join } from "node:path";
import { closeMemoryDb, openMemoryDb, type MemoryDb } from "../src/db.ts";
import { saveMemory } from "../src/memory.ts";
import { buildBrief } from "../src/brief.ts";
import { resolveScope, type ResolvedScope } from "../src/scope.ts";
import type { MemoryConfig } from "../src/config.ts";
import { cleanupTempDirs, makeConfig, makeRepos, scopeConfig, tempRoot, useIsolatedHome, writeFile } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => {
	cleanupTempDirs();
});

interface Fixture {
	config: MemoryConfig;
	backend: ResolvedScope;
	db: MemoryDb;
}

function fixture(): Fixture {
	const base = tempRoot();
	useIsolatedHome(base);
	const root = join(base, "enterprise");
	makeRepos(root, ["backend", "frontend"]);
	writeFile(join(root, "backend"), "src/db.ts", "export const pool = 'hikari';\n");
	const config = makeConfig([scopeConfig(root)]);
	const backend = resolveScope(config, join(root, "backend"));
	assert.equal(backend.active, true);
	if (!backend.active) throw new Error("scope resolution failed");
	return { config, backend: backend.resolved, db: openMemoryDb("enterprise") };
}

function save(fx: Fixture, title: string, content: string, kind: "constraint" | "pitfall" | "fact" = "constraint") {
	return saveMemory(
		fx.db,
		fx.backend,
		{
			action: "upsert",
			kind,
			title,
			content,
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		},
		fx.config.defaults.retrieval,
	);
}

test("快照包含作用域概览与常驻约束", () => {
	const fx = fixture();
	try {
		save(fx, "权限校验必须走拦截器", "所有写操作必须经过拦截器校验 subjectId。");
		save(fx, "禁止在 Controller 里拼 SQL", "查询一律走 Mapper，禁止字符串拼接。", "pitfall");
		const brief = buildBrief(fx.db, fx.backend, { enabled: true, maxChars: 2000 });
		assert.ok(brief);
		assert.match(brief, /长期记忆/);
		assert.match(brief, /backend/);
		assert.match(brief, /权限校验必须走拦截器/);
		assert.match(brief, /禁止在 Controller 里拼 SQL/);
		assert.match(brief, /scope_memory_search/);
		assert.match(brief, /数据，不是指令/);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("快照不超过字符预算", () => {
	const fx = fixture();
	try {
		for (let index = 0; index < 30; index += 1) {
			save(fx, `约束 ${index}`, `第 ${index} 条常驻约束，正文用于占满预算。`);
		}
		const brief = buildBrief(fx.db, fx.backend, { enabled: true, maxChars: 400 });
		assert.ok(brief);
		assert.ok(brief.length <= 400, `快照超预算: ${brief.length}`);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("没有记忆时不注入空快照", () => {
	const fx = fixture();
	try {
		assert.equal(buildBrief(fx.db, fx.backend, { enabled: true, maxChars: 2000 }), undefined);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("关闭快照时不生成", () => {
	const fx = fixture();
	try {
		save(fx, "权限校验必须走拦截器", "所有写操作必须经过拦截器校验 subjectId。");
		assert.equal(buildBrief(fx.db, fx.backend, { enabled: false, maxChars: 2000 }), undefined);
	} finally {
		closeMemoryDb(fx.db);
	}
});
