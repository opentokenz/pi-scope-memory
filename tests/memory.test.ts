import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { join } from "node:path";
import { closeMemoryDb, openMemoryDb, type MemoryDb } from "../src/db.ts";
import {
	MemoryError,
	checkFreshness,
	clearMemories,
	previewClear,
	saveMemory,
	searchMemories,
	type MemorySaveInput,
} from "../src/memory.ts";
import { resolveScope, type ResolvedScope } from "../src/scope.ts";
import type { MemoryConfig } from "../src/config.ts";
import { cleanupTempDirs, makeConfig, makeRepos, tempRoot, useIsolatedHome, writeFile, scopeConfig } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => {
	cleanupTempDirs();
});

interface Fixture {
	root: string;
	config: MemoryConfig;
	backend: ResolvedScope;
	frontend: ResolvedScope;
	db: MemoryDb;
}

function fixture(): Fixture {
	const base = tempRoot();
	useIsolatedHome(base);
	const root = join(base, "enterprise");
	makeRepos(root, ["backend", "frontend", "shared-sdk"]);
	writeFile(join(root, "backend"), "src/db.ts", "export const pool = 'hikari';\n");
	writeFile(join(root, "backend"), "src/auth/refresh.ts", "export function refresh() {}\n");
	writeFile(join(root, "frontend"), "src/api/auth.ts", "export const auth = 'v2';\n");
	const config = makeConfig([scopeConfig(root)]);
	const backend = resolveScope(config, join(root, "backend"));
	const frontend = resolveScope(config, join(root, "frontend"));
	assert.equal(backend.active, true);
	assert.equal(frontend.active, true);
	const db = openMemoryDb("enterprise");
	if (!backend.active || !frontend.active) throw new Error("scope resolution failed");
	return { root, config, backend: backend.resolved, frontend: frontend.resolved, db };
}

function save(fx: Fixture, scope: ResolvedScope, input: Omit<MemorySaveInput, "action"> & { action?: MemorySaveInput["action"] }) {
	return saveMemory(fx.db, scope, { ...input, action: input.action ?? "upsert" }, fx.config.defaults.retrieval);
}

test("Shared 记忆跨仓库可见，仓库内部记忆默认隔离", () => {
	const fx = fixture();
	try {
		const shared = save(fx, fx.backend, {
			kind: "decision",
			layer: "shared",
			title: "统一认证协议使用 Auth API V2",
			content: "Backend、Frontend 和 SDK 统一使用 Auth API V2。",
			evidence: [
				{ repo: "backend", path: "src/auth/refresh.ts" },
				{ repo: "frontend", path: "src/api/auth.ts" },
			],
		});
		assert.equal(shared.action, "created");
		assert.equal(shared.status, "active");
		assert.equal(shared.memory?.repoId, null);
		assert.deepEqual(shared.memory?.relatedPaths, ["backend/src/auth/refresh.ts", "frontend/src/api/auth.ts"]);

		const internal = save(fx, fx.backend, {
			kind: "fact",
			layer: "repo",
			title: "Backend 使用 HikariCP 连接池",
			content: "Backend 的连接池使用 HikariCP，maximumPoolSize 为 20。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		});
		assert.equal(internal.status, "active");

		const fromFrontend = searchMemories(fx.db, fx.frontend, { query: "认证" }, fx.config.defaults.retrieval);
		assert.ok(fromFrontend.hits.some((hit) => hit.memory.title.includes("Auth API V2")));

		const hidden = searchMemories(fx.db, fx.frontend, { query: "HikariCP" }, fx.config.defaults.retrieval);
		assert.equal(hidden.hits.length, 0);

		const crossRepo = searchMemories(
			fx.db,
			fx.frontend,
			{ query: "HikariCP", target: "all" },
			fx.config.defaults.retrieval,
		);
		assert.equal(crossRepo.hits.length, 1);
		assert.equal(crossRepo.hits[0]?.memory.repoId, "backend");

		const fromBackend = searchMemories(fx.db, fx.backend, { query: "认证" }, fx.config.defaults.retrieval);
		assert.ok(fromBackend.hits.some((hit) => hit.memory.repoId === null));
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("中文子串与英文标识符都能检索", () => {
	const fx = fixture();
	try {
		save(fx, fx.backend, {
			kind: "pitfall",
			title: "JWT 刷新竞态",
			content: "并发刷新 Token 会产生竞态，必须使用 singleflight 合并请求。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		const chinese = searchMemories(fx.db, fx.backend, { query: "刷新" }, fx.config.defaults.retrieval);
		assert.equal(chinese.hits.length, 1);
		const identifier = searchMemories(fx.db, fx.backend, { query: "singleflight" }, fx.config.defaults.retrieval);
		assert.equal(identifier.hits.length, 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("保存前自动检索：重复内容更新原记忆而不是新增", () => {
	const fx = fixture();
	try {
		const first = save(fx, fx.backend, {
			kind: "constraint",
			title: "所有客户端必须兼容旧 Token",
			content: "所有客户端必须兼容旧 Token，直到 V3 全部上线。",
		});
		const second = save(fx, fx.backend, {
			kind: "constraint",
			title: "所有客户端必须兼容旧 Token",
			content: "所有客户端必须兼容旧 Token，直到 V3 全部上线，服务端保留双验证路径。",
		});
		assert.equal(first.action, "created");
		assert.equal(second.action, "updated");
		assert.equal(second.id, first.id);
		assert.ok(second.related.some((item) => item.relation === "duplicate"));
		const count = fx.db.sqlite.prepare("SELECT count(*) AS n FROM memories").get();
		assert.equal(Number(count?.n), 1);
		const revisions = fx.db.sqlite.prepare("SELECT count(*) AS n FROM memory_revisions").get();
		assert.ok(Number(revisions?.n) >= 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("冲突内容自动替代旧记忆，历史版本可追溯", () => {
	const fx = fixture();
	try {
		const old = save(fx, fx.backend, {
			kind: "decision",
			title: "Auth 存储方案",
			content: "AuthService 使用 Redis 保存 Session。",
		});
		const next = save(fx, fx.backend, {
			kind: "decision",
			title: "Auth 存储方案",
			content: "AuthService 已改为 JWT，并废弃 Redis Session。",
		});
		assert.equal(next.action, "superseded");
		assert.ok(next.id);
		assert.ok(next.related.some((item) => item.relation === "conflict"));

		const oldRow = fx.db.sqlite.prepare("SELECT status, superseded_by FROM memories WHERE id = ?").get(firstId(old.id));
		assert.equal(String(oldRow?.status), "superseded");
		assert.equal(String(oldRow?.superseded_by), next.id);

		const activeOnly = searchMemories(fx.db, fx.backend, { query: "Auth 存储" }, fx.config.defaults.retrieval);
		assert.ok(activeOnly.hits.every((hit) => hit.memory.status !== "superseded"));

		const historical = searchMemories(
			fx.db,
			fx.backend,
			{ query: "Auth 存储", includeHistorical: true },
			fx.config.defaults.retrieval,
		);
		assert.ok(historical.hits.some((hit) => hit.memory.id === old.id && hit.memory.status === "superseded"));
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("显式 supersede 与 invalidate", () => {
	const fx = fixture();
	try {
		const first = save(fx, fx.backend, {
			kind: "fact",
			title: "刷新接口返回结构",
			content: "刷新接口返回 { token: string }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		const replaced = save(fx, fx.backend, {
			action: "supersede",
			memoryId: first.id,
			kind: "fact",
			title: "刷新接口返回结构",
			content: "刷新接口返回 { accessToken, refreshToken }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		assert.equal(replaced.action, "superseded");
		assert.equal(replaced.memory?.supersedes, first.id);

		const invalidated = save(fx, fx.backend, {
			action: "invalidate",
			memoryId: replaced.id ?? "",
			kind: "fact",
			content: "",
		});
		assert.equal(invalidated.action, "invalidated");
		assert.equal(invalidated.status, "superseded");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("证据验证：实现事实有证据才 active，无证据是 candidate", () => {
	const fx = fixture();
	try {
		const verified = save(fx, fx.backend, {
			kind: "fact",
			title: "数据访问层使用 HikariCP",
			content: "后端数据访问层统一使用 HikariCP。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		});
		assert.equal(verified.status, "active");
		assert.ok(verified.memory?.verifiedAt);

		const unverified = save(fx, fx.backend, {
			kind: "fact",
			title: "后端已迁移到读写分离",
			content: "后端已迁移到读写分离，但尚未提交。",
		});
		assert.equal(unverified.status, "candidate");
		assert.ok(unverified.notes.some((note) => note.includes("candidate")));

		const badEvidence = save(fx, fx.backend, {
			kind: "fact",
			title: "前端已切换到 V3",
			content: "前端已经切换到 V3 接口。",
			evidence: [
				{ repo: "frontend", path: "../../etc/passwd" },
				{ repo: "unknown", path: "src/x.ts" },
			],
		});
		assert.equal(badEvidence.status, "candidate");
		assert.ok(badEvidence.notes.some((note) => note.includes("逃逸")));
		assert.ok(badEvidence.notes.some((note) => note.includes("未注册仓库")));
		assert.deepEqual(badEvidence.memory?.relatedPaths, []);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("跨仓库内容自动归入 Shared 层", () => {
	const fx = fixture();
	try {
		const result = save(fx, fx.backend, {
			kind: "constraint",
			title: "鉴权协议版本",
			content: "backend、frontend 和 sdk 必须同时使用 Auth API V2。",
		});
		assert.equal(result.memory?.repoId, null);
		assert.ok(result.notes.some((note) => note.includes("Shared")));
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("checkpoint 过期后默认不返回", () => {
	const fx = fixture();
	try {
		const checkpoint = save(fx, fx.backend, {
			kind: "checkpoint",
			title: "迁移进行中",
			content: "后端迁移完成，前端尚未验收。",
		});
		assert.equal(checkpoint.status, "active");
		assert.ok(checkpoint.memory?.expiresAt);
		fx.db.sqlite
			.prepare("UPDATE memories SET expires_at = ? WHERE id = ?")
			.run("2000-01-01T00:00:00.000Z", String(checkpoint.id));
		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.expired, 1);

		const hidden = searchMemories(fx.db, fx.backend, { query: "迁移" }, fx.config.defaults.retrieval);
		assert.equal(hidden.hits.length, 0);

		const stale = searchMemories(
			fx.db,
			fx.backend,
			{ query: "迁移" },
			{ ...fx.config.defaults.retrieval, includeStale: true },
		);
		assert.equal(stale.hits.length, 1);
		assert.equal(stale.hits[0]?.memory.status, "expired");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("证据文件变化后记忆进入 review 并降权", () => {
	const fx = fixture();
	try {
		const saved = save(fx, fx.backend, {
			kind: "fact",
			title: "刷新函数签名",
			content: "refresh() 返回 { token: string }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		assert.equal(saved.status, "active");
		writeFile(join(fx.root, "backend"), "src/auth/refresh.ts", "export function refresh(userId: string) {}\n");
		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.flagged, 1);
		const row = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(saved.id));
		assert.equal(String(row?.status), "review");

		const hits = searchMemories(fx.db, fx.backend, { query: "refresh" }, fx.config.defaults.retrieval);
		assert.equal(hits.hits.length, 1);
		assert.equal(hits.hits[0]?.memory.status, "review");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("clear --repo 只影响目标仓库，并清理关联版本", () => {
	const fx = fixture();
	try {
		save(fx, fx.backend, {
			kind: "fact",
			title: "Backend 连接池",
			content: "Backend 使用 HikariCP。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		});
		save(fx, fx.frontend, {
			kind: "fact",
			title: "Frontend 鉴权 Hook",
			content: "useAuth Hook 负责刷新 Token。",
			evidence: [{ repo: "frontend", path: "src/api/auth.ts" }],
		});
		save(fx, fx.backend, {
			kind: "decision",
			layer: "shared",
			title: "统一错误码",
			content: "所有仓库统一使用 SDK 错误码映射。",
		});

		const preview = previewClear(fx.db, fx.backend, { kind: "repo", repoId: "backend" });
		assert.equal(preview.memories, 1);
		const removed = clearMemories(fx.db, fx.backend, { kind: "repo", repoId: "backend" });
		assert.equal(removed.memories, 1);
		const remaining = fx.db.sqlite.prepare("SELECT coalesce(repo_id, 'shared') AS layer FROM memories ORDER BY 1").all();
		assert.deepEqual(
			remaining.map((row) => String(row.layer)),
			["frontend", "shared"],
		);
		const revisions = fx.db.sqlite
			.prepare("SELECT count(*) AS n FROM memory_revisions WHERE memory_id NOT IN (SELECT id FROM memories)")
			.get();
		assert.equal(Number(revisions?.n), 0);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("敏感内容与凭据被拒绝写入", () => {
	const fx = fixture();
	try {
		assert.throws(
			() =>
				save(fx, fx.backend, {
					kind: "fact",
					title: "连接配置",
					content: "api_key = FAKEVALUE1234567890",
				}),
			MemoryError,
		);
		assert.throws(
			() =>
				save(fx, fx.backend, {
					kind: "fact",
					title: "私钥位置",
					content: "-----BEGIN RSA PRIVATE KEY-----",
				}),
			/凭据/,
		);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("仓库参数不能逃逸当前 Scope", () => {
	const fx = fixture();
	try {
		assert.throws(
			() => searchMemories(fx.db, fx.backend, { query: "x", repo: "other-scope" }, fx.config.defaults.retrieval),
			/未知仓库/,
		);
		assert.throws(
			() => save(fx, fx.backend, { kind: "fact", repo: "other-scope", title: "x", content: "x" }),
			/未知仓库/,
		);
	} finally {
		closeMemoryDb(fx.db);
	}
});

function firstId(id: string | undefined): string {
	assert.ok(id);
	return id;
}
