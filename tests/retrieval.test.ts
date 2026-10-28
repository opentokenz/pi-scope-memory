import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { join } from "node:path";
import { closeMemoryDb, openMemoryDb, type MemoryDb } from "../src/db.ts";
import { saveMemory, searchMemories, type MemorySaveInput } from "../src/memory.ts";
import { resolveScope, type ResolvedScope } from "../src/scope.ts";
import type { MemoryConfig } from "../src/config.ts";
import { cleanupTempDirs, makeConfig, makeRepos, scopeConfig, tempRoot, useIsolatedHome, writeFile } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => {
	cleanupTempDirs();
});

interface Fixture {
	root: string;
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
	writeFile(join(root, "backend"), "docs/sql/mysql/2026-10-28-marketing-category.sql", "alter table marketing;\n");
	const config = makeConfig([scopeConfig(root)]);
	const backend = resolveScope(config, join(root, "backend"));
	assert.equal(backend.active, true);
	if (!backend.active) throw new Error("scope resolution failed");
	return { root, config, backend: backend.resolved, db: openMemoryDb("enterprise") };
}

function save(fx: Fixture, input: Omit<MemorySaveInput, "action">) {
	return saveMemory(fx.db, fx.backend, { ...input, action: "upsert" }, fx.config.defaults.retrieval);
}

test("证据路径里的数字不能把无关记忆判成命中", () => {
	const fx = fixture();
	try {
		save(fx, {
			kind: "constraint",
			title: "营销分类活动类目：一级必填、二级继承",
			content: "营销分类与活动类目的关系约束：一级营销分类必须关联活动类目，二级分类不单独维护。",
			evidence: [{ repo: "backend", path: "docs/sql/mysql/2026-10-28-marketing-category.sql" }],
		});

		// 查询里的 192.0.2.10 会拆出 token "10"，证据路径 2026-10-28 也包含 "10"。
		// 路径子串命中不能单独让这条营销记忆变成 Jenkins 排障的检索结果。
		const hits = searchMemories(
			fx.db,
			fx.backend,
			{ query: "生产 Jenkins 节点 192.0.2.10 反向 SSH 隧道 22222 kexTimeout" },
			fx.config.defaults.retrieval,
		);
		assert.deepEqual(
			hits.hits.map((hit) => hit.memory.title),
			[],
		);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("只共享一个泛化中文词的记忆不算命中", () => {
	const fx = fixture();
	try {
		save(fx, {
			kind: "preference",
			title: "规则类单测放在 web-admin 测试模块并按名筛选执行",
			content: "规则类单测统一放在 web-admin 的测试模块，按类名筛选执行。",
		});
		save(fx, {
			kind: "decision",
			title: "资质采用配置驱动方案",
			content: "资质字段由配置驱动，规则类校验集中在 ErpTenantRules。",
		});

		const hits = searchMemories(fx.db, fx.backend, { query: "订单号生成规则" }, fx.config.defaults.retrieval);
		assert.deepEqual(
			hits.hits.map((hit) => hit.memory.title),
			[],
		);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("完整标识符和短查询仍然能检索到", () => {
	const fx = fixture();
	try {
		save(fx, {
			kind: "pitfall",
			title: "hub 单测用 -Dtest 过滤时需加 -Dsurefire.failIfNoSpecifiedTests=false",
			content:
				"在 services/cloud 下用 ./mvnw -Dtest=DirectoryServiceTest 运行指定单测时，上游被 -am 拉起的模块没有匹配测试会导致构建失败。",
		});
		const keyword = searchMemories(
			fx.db,
			fx.backend,
			{ query: "hub 单测 -Dtest 过滤" },
			fx.config.defaults.retrieval,
		);
		assert.equal(keyword.hits.length, 1);
		assert.match(keyword.hits[0]?.memory.title ?? "", /-Dtest/);

		save(fx, {
			kind: "pitfall",
			title: "JWT 刷新竞态",
			content: "并发刷新 Token 会产生竞态，必须使用 singleflight 合并请求。",
		});
		const short = searchMemories(fx.db, fx.backend, { query: "刷新" }, fx.config.defaults.retrieval);
		assert.equal(short.hits.length, 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("中文长句里共享的四字短语仍然能召回", () => {
	const fx = fixture();
	try {
		save(fx, {
			kind: "preference",
			title: "MySQL 结构变更脚本按 docs/sql/mysql/日期-特性名.sql 归档",
			content:
				"数据库变更脚本统一放在 docs/sql/mysql/ 下，命名形如 YYYY-MM-DD-<特性描述>.sql，与功能代码同一次提交。",
		});
		const hits = searchMemories(
			fx.db,
			fx.backend,
			{ query: "数据库表结构变更脚本放在哪里" },
			fx.config.defaults.retrieval,
		);
		assert.equal(hits.hits.length, 1);
		assert.match(hits.hits[0]?.memory.title ?? "", /结构变更脚本/);
		assert.equal(hits.hits[0]?.matchedBy, "fts", "中文长句应由 trigram 索引命中");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("检索结果返回足够长的正文而不是截断在 200 字", () => {
	const fx = fixture();
	try {
		const prefix =
			"排查 Maven 单测是否真的执行时，先看 surefire-reports 的用例数和报告目录，" +
			"不要只看 BUILD SUCCESS。上游模块被 -am 拉起但没有匹配用例时，构建可能显示成功，" +
			"实际一个测试都没有跑。报告目录停留在上一次运行，是常见的误判来源。" +
			"尤其是多模块项目里，父模块的 test 阶段被跳过时，子模块报告仍然存在，" +
			"只看终端输出和 BUILD 结果就会把没有执行当成已经通过，后续回归全部失效。";
		const tail = "结论：先核对 surefire-reports 的时间戳，再判断用例是否执行。";
		save(fx, {
			kind: "pitfall",
			title: "判断 Maven 用例是否真正执行要看 surefire-reports",
			content: `${prefix}${tail}`,
		});

		const hits = searchMemories(fx.db, fx.backend, { query: "surefire" }, fx.config.defaults.retrieval);
		assert.equal(hits.hits.length, 1);
		assert.ok(hits.hits[0]?.snippet.includes("时间戳"), "正文尾部结论必须出现在检索结果里");
	} finally {
		closeMemoryDb(fx.db);
	}
});
