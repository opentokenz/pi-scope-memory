import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { join } from "node:path";
import { closeMemoryDb, openMemoryDb, type MemoryDb } from "../src/db.ts";
import {
	MemoryError,
	checkFreshness,
	clearMemories,
	listRecentTitles,
	previewClear,
	saveMemory,
	searchMemories,
	type MemorySaveInput,
} from "../src/memory.ts";
import { collectStats, formatStats } from "../src/stats.ts";
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

test("长正文改写后仍能识别为同一记忆", () => {
	const fx = fixture();
	try {
		const body =
			"用户身份与子系统授权按企业范围校验：企业用户只能看到本企业数据，" +
			"子系统超级管理员持有固定角色，可以跨企业维护基础数据。用户、企业和资质三类对象" +
			"在服务层统一走权限校验，控制器只负责参数绑定。新增子系统时沿用同一套角色模型，" +
			"不要另建一套身份表。注销使用 del_flag，停用和启用分别通知下游应用。";
		const first = save(fx, fx.backend, {
			kind: "decision",
			title: "用户身份与子系统授权模型",
			content: body,
		});
		const second = save(fx, fx.backend, {
			kind: "decision",
			title: "用户身份与子系统授权模型",
			content: `${body} 前端只负责展示服务端返回的权限结果。`,
		});
		assert.equal(first.action, "created");
		assert.equal(second.action, "updated");
		assert.equal(second.id, first.id);
		const count = fx.db.sqlite.prepare("SELECT count(*) AS n FROM memories").get();
		assert.equal(Number(count?.n), 1);
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

test("同标题的连续改写只更新一条记忆", () => {
	const fx = fixture();
	try {
		const versions = [
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键，任何子系统都可以推送企业入驻。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键，任何子系统都可以推送企业入驻，中台已有则复用。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键，任何子系统都可以推送企业入驻，中台已有则复用、没有则保存。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键，任何子系统都可以推送企业入驻，中台已有则复用、没有则保存；ERP 只在首次登记时推送。",
			"ERP 是企业档案与业务归属的权威来源；ERP 表与模型从 erp_merchant 改为 erp_tenant，未上线不做历史兼容。企业以统一社会信用代码为唯一键，任何子系统都可以推送企业入驻，中台已有则复用、没有则保存；ERP 只在首次登记时推送，之后改名不传导。",
		];
		let firstId: string | undefined;
		for (const [index, content] of versions.entries()) {
			const result = save(fx, fx.backend, {
				kind: "decision",
				title: "企业/租户职责边界",
				content,
			});
			if (index === 0) {
				firstId = result.id;
				assert.equal(result.action, "created");
			} else {
				assert.equal(result.action, "updated", `第 ${index + 1} 次改写应就地更新`);
				assert.equal(result.id, firstId);
			}
		}

		const counts = fx.db.sqlite
			.prepare("SELECT status, count(*) AS n FROM memories GROUP BY status")
			.all();
		assert.deepEqual(
			counts.map((row) => [String(row.status), Number(row.n)]),
			[["active", 1]],
		);
		const revisions = fx.db.sqlite.prepare("SELECT count(*) AS n FROM memory_revisions").get();
		assert.ok(Number(revisions?.n) >= versions.length, "每次改写都要留下 revision");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("保存结果不再列出已被替代的历史版本", () => {
	const fx = fixture();
	try {
		const old = save(fx, fx.backend, {
			kind: "decision",
			title: "Auth 存储方案",
			content: "AuthService 使用 Redis 保存 Session。",
		});
		const replaced = save(fx, fx.backend, {
			kind: "decision",
			title: "Auth 存储方案",
			content: "AuthService 已改为 JWT，并废弃 Redis Session。",
		});
		assert.equal(replaced.action, "superseded");
		assert.equal(replaced.memory?.supersedes, old.id);

		const next = save(fx, fx.backend, {
			kind: "decision",
			title: "Auth 存储方案",
			content: "AuthService 使用 JWT，并废弃 Redis Session；旧客户端保留双读直到 V3。",
		});
		assert.ok(next.related.length > 0);
		assert.ok(
			next.related.every((item) => item.status !== "superseded"),
			"related 不应再返回 superseded 的祖先版本",
		);
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

test("证据路径误带仓库前缀时按仓库根目录校正", () => {
	const fx = fixture();
	try {
		// Learning writes the scope-relative path, so the repository id shows up
		// twice. That must still verify instead of dropping to candidate.
		const prefixed = save(fx, fx.backend, {
			kind: "fact",
			title: "数据访问层使用 HikariCP",
			content: "后端数据访问层统一使用 HikariCP。",
			evidence: [{ repo: "backend", path: "backend/src/db.ts" }],
		});
		assert.equal(prefixed.status, "active");
		assert.equal(prefixed.memory?.evidence[0]?.path, "src/db.ts", "证据路径应归一化为仓库相对路径");

		// A real subdirectory that happens to share the repo id wins as written.
		writeFile(join(fx.root, "backend"), "backend/actual.ts", "export const nested = true;\n");
		const nested = save(fx, fx.backend, {
			kind: "fact",
			title: "嵌套同名目录",
			content: "backend 仓库下存在一个也叫 backend 的子目录。",
			evidence: [{ repo: "backend", path: "backend/actual.ts" }],
		});
		assert.equal(nested.status, "active");
		assert.equal(nested.memory?.evidence[0]?.path, "backend/actual.ts", "真实存在的原路径必须优先");
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

test("证据未写 repo 时按唯一匹配推断仓库", () => {
	const fx = fixture();
	try {
		const inferred = save(fx, fx.backend, {
			kind: "fact",
			layer: "shared",
			title: "数据访问层使用 HikariCP",
			content: "后端数据访问层统一使用 HikariCP。",
			evidence: [{ path: "src/db.ts" }],
		});
		assert.equal(inferred.status, "active");
		assert.equal(inferred.memory?.evidence[0]?.repo, "backend");
		assert.ok(inferred.notes.some((note) => note.includes("推断证据仓库")));

		writeFile(join(fx.root, "frontend"), "src/db.ts", "export const frontendDb = true;\n");
		const ambiguous = save(fx, fx.backend, {
			kind: "fact",
			layer: "shared",
			title: "两个仓库都有同名文件",
			content: "两个仓库都存在 src/db.ts。",
			evidence: [{ path: "src/db.ts" }],
		});
		assert.equal(ambiguous.status, "candidate");
		assert.ok(ambiguous.notes.some((note) => note.includes("无法唯一推断")));
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("仓库根下多一层项目目录时证据路径仍能校验", () => {
	const fx = fixture();
	try {
		writeFile(join(fx.root, "backend"), "backend/pom.xml", "<project/>\n");
		writeFile(
			join(fx.root, "backend"),
			"backend/backend-admin/src/test/java/FooTest.java",
			"class FooTest {}\n",
		);
		const result = save(fx, fx.backend, {
			kind: "fact",
			title: "集成测试位于内层项目的 admin 模块",
			content: "集成测试 FooTest 位于 app 内层项目的 backend-admin 模块。",
			evidence: [{ repo: "backend", path: "backend-admin/src/test/java/FooTest.java" }],
		});
		assert.equal(result.status, "active");
		assert.equal(result.memory?.evidence[0]?.path, "backend/backend-admin/src/test/java/FooTest.java");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("Scope 根目录保存仓库层记忆时从证据推断仓库", () => {
	const fx = fixture();
	try {
		const rootScope = resolveScope(fx.config, fx.root);
		assert.equal(rootScope.active, true);
		if (!rootScope.active) throw new Error("scope resolution failed");
		assert.equal(rootScope.resolved.repoId, undefined);

		const result = saveMemory(
			fx.db,
			rootScope.resolved,
			{
				action: "upsert",
				kind: "fact",
				layer: "repo",
				title: "数据访问层使用 HikariCP",
				content: "后端数据访问层统一使用 HikariCP。",
				evidence: [{ path: "src/db.ts" }],
			},
			fx.config.defaults.retrieval,
		);
		assert.equal(result.memory?.repoId, "backend");
		assert.ok(result.notes.some((note) => note.includes("推断仓库 backend")));
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
		const checkpointDays =
			(Date.parse(String(checkpoint.memory?.expiresAt)) - Date.now()) / 86_400_000;
		assert.ok(checkpointDays > 13.5 && checkpointDays < 14.5, "checkpoint 有效期保持 14 天");
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

test("review 状态的 checkpoint 到期后也会过期", () => {
	const fx = fixture();
	try {
		const checkpoint = save(fx, fx.backend, {
			kind: "checkpoint",
			title: "迁移进行中",
			content: "后端迁移完成，前端尚未验收。",
		});
		fx.db.sqlite
			.prepare("UPDATE memories SET status = 'review', expires_at = ? WHERE id = ?")
			.run("2000-01-01T00:00:00.000Z", String(checkpoint.id));
		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.expired, 1);
		const row = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(checkpoint.id));
		assert.equal(String(row?.status), "expired");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("目录证据不会被当成文件变化触发复核", () => {
	const fx = fixture();
	try {
		const saved = save(fx, fx.backend, {
			kind: "preference",
			title: "刷新与目录约定",
			content: "刷新逻辑放在 src/auth，配合同名测试文件。",
			evidence: [
				{ repo: "backend", path: "src/auth/refresh.ts" },
				{ repo: "backend", path: "src/auth" },
			],
		});
		assert.equal(saved.status, "active");
		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.flagged, 0);
		const row = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(saved.id));
		assert.equal(String(row?.status), "active");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("关联文件的无关改动不会降级记忆", () => {
	const fx = fixture();
	try {
		const saved = save(fx, fx.backend, {
			kind: "fact",
			title: "刷新函数签名",
			content: "refresh() 返回 { token: string }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		assert.equal(saved.status, "active");
		writeFile(
			join(fx.root, "backend"),
			"src/auth/refresh.ts",
			"// 补充注释\nexport function refresh(userId: string) {\n\treturn userId;\n}\n",
		);
		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.flagged, 0);
		assert.equal(freshness.restored, 0);
		const row = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(saved.id));
		assert.equal(String(row?.status), "active", "锚点仍在时不应降为 review");
		const revisions = fx.db.sqlite
			.prepare("SELECT operation FROM memory_revisions WHERE memory_id = ?")
			.all(String(saved.id));
		assert.ok(revisions.some((item) => item.operation === "reverify"), "重新核对要留下 revision");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("旧记忆在文件未变时补写锚点", () => {
	const fx = fixture();
	try {
		const saved = save(fx, fx.backend, {
			kind: "fact",
			title: "刷新函数签名",
			content: "refresh() 返回 { token: string }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		const id = String(saved.id);
		const row = fx.db.sqlite.prepare("SELECT evidence_json FROM memories WHERE id = ?").get(id);
		const withoutAnchors = (JSON.parse(String(row?.evidence_json)) as Record<string, unknown>[]).map(
			({ anchors: _anchors, ...rest }) => rest,
		);
		fx.db.sqlite
			.prepare("UPDATE memories SET evidence_json = ? WHERE id = ?")
			.run(JSON.stringify(withoutAnchors), id);

		const freshness = checkFreshness(fx.db, fx.backend);
		assert.equal(freshness.flagged, 0);
		const after = fx.db.sqlite.prepare("SELECT evidence_json, status FROM memories WHERE id = ?").get(id);
		const evidence = JSON.parse(String(after?.evidence_json)) as { anchors?: string[] }[];
		assert.ok(evidence[0]?.anchors?.includes("refresh"), "未变文件应补写锚点");
		assert.equal(String(after?.status), "active");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("引用的符号被删除后进入 review，恢复后自动回到 active", () => {
	const fx = fixture();
	try {
		const saved = save(fx, fx.backend, {
			kind: "fact",
			title: "刷新函数签名",
			content: "refresh() 返回 { token: string }。",
			evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
		});
		assert.equal(saved.status, "active");

		writeFile(join(fx.root, "backend"), "src/auth/refresh.ts", "export function renew() {}\n");
		const flagged = checkFreshness(fx.db, fx.backend);
		assert.equal(flagged.flagged, 1);
		const reviewRow = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(saved.id));
		assert.equal(String(reviewRow?.status), "review");
		const hits = searchMemories(fx.db, fx.backend, { query: "refresh" }, fx.config.defaults.retrieval);
		assert.equal(hits.hits.length, 1);
		assert.equal(hits.hits[0]?.memory.status, "review");

		writeFile(join(fx.root, "backend"), "src/auth/refresh.ts", "export function refresh() {}\n");
		const restored = checkFreshness(fx.db, fx.backend);
		assert.equal(restored.restored, 1);
		const activeRow = fx.db.sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(String(saved.id));
		assert.equal(String(activeRow?.status), "active", "证据恢复后应自动恢复 active");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习标题列表包含 review 记忆", () => {
	const fx = fixture();
	try {
		save(fx, fx.backend, {
			kind: "fact",
			title: "Backend 连接池",
			content: "Backend 使用 HikariCP。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		});
		fx.db.sqlite.prepare("UPDATE memories SET status = 'review'").run();
		const titles = listRecentTitles(fx.db, fx.backend);
		assert.equal(titles.length, 1);
		assert.equal(titles[0]?.status, "review");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("零命中检索与 review 比例出现在统计里", () => {
	const fx = fixture();
	try {
		save(fx, fx.backend, {
			kind: "fact",
			title: "Backend 连接池",
			content: "Backend 使用 HikariCP。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		});
		const miss = searchMemories(fx.db, fx.backend, { query: "订单号生成规则" }, fx.config.defaults.retrieval);
		assert.equal(miss.hits.length, 0);
		const stats = collectStats(fx.db, fx.backend, fx.config.defaults);
		assert.equal(stats.searchCalls, 1);
		assert.equal(stats.searchZeroCalls, 1);
		const text = formatStats(stats, "enterprise");
		assert.match(text, /Zero-hit Searches\s+1\/1 \(100%\)/);
		assert.match(text, /Review Ratio\s+0% \(0\/1\)/);
		assert.match(text, /Updates\/Supersedes\s+0\/0/);
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
