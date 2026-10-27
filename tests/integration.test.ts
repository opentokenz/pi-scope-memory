import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { loadConfig, writeConfig } from "../src/config.ts";
import { assistantMessage, cleanupTempDirs, makeConfig, makeRepos, tempRoot, useIsolatedHome, writeFile, scopeConfig } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => cleanupTempDirs());

interface Harness {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
	tools: Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>;
	notices: string[];
	sent: string[];
	activeTools: () => string[];
	sessionStart: (ctx: ExtensionContext) => Promise<void>;
	shutdown: () => Promise<void>;
}

function harness(notices: string[] = [], sent: string[] = []): Harness {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, Harness["tools"] extends Map<string, infer T> ? T : never>();
	const active = new Set<string>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string; defaultActive?: boolean }) => {
			tools.set(tool.name, tool as never);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.clear();
			for (const name of names) active.add(name);
		},
		sendUserMessage: (content: string) => {
			sent.push(content);
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return {
		pi,
		handlers,
		commands,
		tools,
		notices,
		sent,
		activeTools: () => [...active],
		sessionStart: async (ctx) => {
			await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		},
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {} as ExtensionContext);
		},
	};
}

function makeCtx(
	cwd: string,
	notices: string[],
	options: {
		sessionId?: string;
		complete?: () => Promise<unknown>;
		hasUI?: boolean;
		select?: (title: string, items: string[]) => Promise<string | undefined>;
	} = {},
): ExtensionContext {
	return {
		cwd,
		mode: options.hasUI ? "tui" : "print",
		hasUI: options.hasUI === true,
		signal: undefined,
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
		model: { provider: "anthropic", id: "test-model" },
		modelRegistry: {
			complete: options.complete ?? (async () => assistantMessage("[]")),
			find: (provider: string, id: string) => (provider === "nope" ? undefined : { provider, id }),
			hasConfiguredAuth: () => true,
			getAvailable: () => [
				{ provider: "anthropic", id: "test-model" },
				{ provider: "openai", id: "gpt-x" },
			],
		},
		thinkingLevel: "medium",
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			select: options.select ?? (async () => undefined),
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		abort: () => {},
		shutdown: () => {},
	} as unknown as ExtensionContext;
}

function enterpriseSetup(): { base: string; root: string; configPath: string; dataDir: string } {
	const base = tempRoot();
	const { configPath, dataDir } = useIsolatedHome(base);
	const root = join(base, "enterprise");
	makeRepos(root, ["backend", "frontend", "shared-sdk"]);
	writeFile(join(root, "backend"), "src/db.ts", "export const pool = 'hikari';\n");
	writeConfig(makeConfig([scopeConfig(root)]), configPath);
	return { base, root, configPath, dataDir };
}

function execute(
	h: Harness,
	toolName: string,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = h.tools.get(toolName);
	assert.ok(tool, `tool ${toolName} 未注册`);
	return tool.execute("call-1", params, undefined, undefined, {}).then((result) => ({
		text: result.content.map((part) => part.text).join("\n"),
		details: result.details,
	}));
}

test("未配置目录：不激活记忆工具，也不创建数据库", async () => {
	const base = tempRoot();
	const { dataDir } = useIsolatedHome(base);
	const outside = join(base, "unrelated");
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(outside, notices));
	assert.deepEqual(h.activeTools(), []);
	assert.equal(existsSync(join(dataDir, "scopes")), false);
	await h.shutdown();
});

test("已配置仓库：会话启动激活工具，保存后跨会话在正确范围召回", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);

	const backendCtx = makeCtx(join(root, "backend"), notices, { sessionId: "session-backend" });
	await h.sessionStart(backendCtx);
	assert.ok(h.activeTools().includes("scope_memory_search"));
	assert.ok(h.activeTools().includes("scope_memory_save"));

	const saved = await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "decision",
		layer: "shared",
		title: "统一认证协议使用 Auth API V2",
		content: "Backend、Frontend 和 SDK 统一使用 Auth API V2。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});
	assert.match(saved.text, /已创建/);
	assert.ok(Array.isArray(saved.details.related), "保存结果必须携带检索到的相关记忆列表");

	const internal = await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		layer: "repo",
		title: "Backend 使用 HikariCP",
		content: "Backend 连接池使用 HikariCP。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});
	assert.match(internal.text, /已创建/);

	await h.shutdown();

	// 新 Session，从 Frontend 启动：能读到 Shared，读不到 Backend 内部记忆。
	const frontendCtx = makeCtx(join(root, "frontend"), notices, { sessionId: "session-frontend" });
	await h.sessionStart(frontendCtx);
	const sharedHit = await execute(h, "scope_memory_search", { query: "Auth API V2" });
	assert.match(sharedHit.text, /Auth API V2/);
	const isolated = await execute(h, "scope_memory_search", { query: "HikariCP" });
	assert.match(isolated.text, /没有匹配的记忆/);
	const crossRepo = await execute(h, "scope_memory_search", { query: "HikariCP", target: "all" });
	assert.match(crossRepo.text, /HikariCP/);
	await h.shutdown();

	// Scope 根目录：默认看到全部仓库。
	const rootCtx = makeCtx(root, notices, { sessionId: "session-root" });
	await h.sessionStart(rootCtx);
	const rootHit = await execute(h, "scope_memory_search", { query: "HikariCP" });
	assert.match(rootHit.text, /HikariCP/);
	await h.shutdown();
});

test("会话切到未配置目录时收回工具", async () => {
	const { root, base } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	assert.ok(h.activeTools().length > 0);
	await h.sessionStart(makeCtx(join(base, "unrelated"), notices));
	assert.deepEqual(h.activeTools(), []);
	await h.shutdown();
});

test("重复保存同一结论时更新而不是新增", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	const first = await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "constraint",
		title: "所有客户端必须兼容旧 Token",
		content: "所有客户端必须兼容旧 Token。",
	});
	const second = await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "constraint",
		title: "所有客户端必须兼容旧 Token",
		content: "所有客户端必须兼容旧 Token，服务端保留双验证。",
	});
	assert.match(first.text, /已创建/);
	assert.match(second.text, /已更新/);
	const stats = await h.commands.get("sm")?.handler("stats", makeCtx(root, notices) as unknown as ExtensionCommandContext);
	void stats;
	assert.ok(notices.some((notice) => notice.includes("Active Memories")));
	await h.shutdown();
});

test("/sm recall 发送检索指令而不是注入 System Prompt", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const sent: string[] = [];
	const h = harness(notices, sent);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	await h.commands.get("sm")?.handler("recall 认证模块以前为什么放弃 Session？", makeCtx(root, notices) as unknown as ExtensionCommandContext);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /scope_memory_search/);
	assert.match(sent[0] ?? "", /认证模块以前为什么放弃 Session/);
	assert.match(sent[0] ?? "", /backend/);
	await h.shutdown();
});

test("/sm model 查看、切换与校验", async () => {
	const { base } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const ctx = makeCtx(base, notices);
	const command = h.commands.get("sm");
	assert.ok(command);

	await command.handler("model", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("学习模型: current")));
	assert.ok(notices.some((notice) => notice.includes("学习思考强度: inherit")));
	assert.ok(notices.some((notice) => notice.includes("anthropic/test-model")));

	await command.handler("model anthropic/test-model", ctx as unknown as ExtensionCommandContext);
	const loaded = loadConfig();
	assert.equal(loaded.status, "loaded");
	if (loaded.status === "loaded") assert.equal(loaded.config.defaults.learningModel, "anthropic/test-model");

	await command.handler("model nope/x", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("未找到模型")));

	await command.handler("model --thinking high", ctx as unknown as ExtensionCommandContext);
	const thinking = loadConfig();
	if (thinking.status === "loaded") assert.equal(thinking.config.defaults.learningThinkingLevel, "high");

	await command.handler("model --thinking turbo", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("未知思考强度")));

	await command.handler("model anthropic/test-model --thinking low", ctx as unknown as ExtensionCommandContext);
	const both = loadConfig();
	if (both.status === "loaded") {
		assert.equal(both.config.defaults.learningModel, "anthropic/test-model");
		assert.equal(both.config.defaults.learningThinkingLevel, "low");
	}

	await command.handler("model current", ctx as unknown as ExtensionCommandContext);
	const reset = loadConfig();
	if (reset.status === "loaded") assert.equal(reset.config.defaults.learningModel, "current");
	await h.shutdown();
});

test("/sm model 在交互模式下用选择器选择模型与思考强度", async () => {
	const { base } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const command = h.commands.get("sm");
	assert.ok(command);

	let seenTitle = "";
	const modelCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async (title, items) => {
			seenTitle = title;
			return items.find((item) => item.startsWith("openai/gpt-x"));
		},
	});
	await command.handler("model", modelCtx as unknown as ExtensionCommandContext);
	assert.match(seenTitle, /选择学习模型/);
	const picked = loadConfig();
	assert.equal(picked.status, "loaded");
	if (picked.status === "loaded") assert.equal(picked.config.defaults.learningModel, "openai/gpt-x");
	assert.ok(notices.some((notice) => notice.includes("学习模型: openai/gpt-x")));

	const thinkingCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async (_title, items) => items.find((item) => item.startsWith("low")),
	});
	await command.handler("model --thinking", thinkingCtx as unknown as ExtensionCommandContext);
	const afterThinking = loadConfig();
	if (afterThinking.status === "loaded") {
		assert.equal(afterThinking.config.defaults.learningThinkingLevel, "low");
		assert.equal(afterThinking.config.defaults.learningModel, "openai/gpt-x");
	}
	assert.ok(notices.some((notice) => notice.includes("学习思考强度: low")));

	const cancelCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async () => undefined,
	});
	await command.handler("model", cancelCtx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("已取消")));
	const afterCancel = loadConfig();
	if (afterCancel.status === "loaded") assert.equal(afterCancel.config.defaults.learningModel, "openai/gpt-x");
	await h.shutdown();
});

test("/sm init 初始化 Scope，重复执行不覆盖已有仓库", async () => {
	const base = tempRoot();
	const { configPath, dataDir } = useIsolatedHome(base);
	const root = join(base, "acme");
	makeRepos(root, ["backend", "frontend"]);
	const notices: string[] = [];
	const h = harness(notices);
	const ctx = makeCtx(root, notices);

	await h.commands.get("sm")?.handler("init --name acme", ctx as unknown as ExtensionCommandContext);
	const loaded = loadConfig(configPath);
	assert.equal(loaded.status, "loaded");
	if (loaded.status !== "loaded") return;
	assert.equal(loaded.config.scopes.length, 1);
	const scope = loaded.config.scopes[0];
	assert.equal(scope?.id, "acme");
	assert.equal(scope?.enabled, true);
	assert.deepEqual(scope?.repos, { backend: "backend", frontend: "frontend" });
	assert.ok(existsSync(join(dataDir, "scopes", "acme", "memory.sqlite")));
	assert.ok(notices.some((notice) => notice.includes("/reload")));

	await h.commands.get("sm")?.handler("init --name acme", ctx as unknown as ExtensionCommandContext);
	const again = loadConfig(configPath);
	if (again.status === "loaded") {
		assert.equal(again.config.scopes.length, 1);
		assert.deepEqual(again.config.scopes[0]?.repos, { backend: "backend", frontend: "frontend" });
	}
	assert.ok(notices.some((notice) => notice.includes("已初始化")));

	// 已带 --name 初始化过，再次 init 不带 --name 也应复用原 ID 而不是报冲突。
	await h.commands.get("sm")?.handler("init", ctx as unknown as ExtensionCommandContext);
	const third = loadConfig(configPath);
	if (third.status === "loaded") {
		assert.equal(third.config.scopes.length, 1);
		assert.equal(third.config.scopes[0]?.id, "acme");
	}

	// 显式 --repos 只合并新仓库，不产生重复路径。
	await h.commands.get("sm")?.handler("init --repos backend,frontend", ctx as unknown as ExtensionCommandContext);
	const merged = loadConfig(configPath);
	if (merged.status === "loaded") {
		assert.deepEqual(merged.config.scopes[0]?.repos, { backend: "backend", frontend: "frontend" });
	}
	await h.shutdown();
});

test("/sm init 支持当前目录本身是仓库（单仓库 Scope）", async () => {
	const base = tempRoot();
	const { configPath } = useIsolatedHome(base);
	const root = join(base, "solo");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFile(root, "src/app.ts", "export const app = 1;\n");
	const notices: string[] = [];
	const h = harness(notices);
	const ctx = makeCtx(root, notices);

	await h.commands.get("sm")?.handler("init", ctx as unknown as ExtensionCommandContext);
	const loaded = loadConfig(configPath);
	assert.equal(loaded.status, "loaded");
	if (loaded.status !== "loaded") return;
	assert.equal(loaded.config.scopes.length, 1);
	assert.deepEqual(loaded.config.scopes[0]?.repos, { solo: "." });

	// 从仓库内的子目录启动时，仍然归属该仓库并激活工具。
	const nested = makeCtx(join(root, "src"), notices, { sessionId: "nested" });
	await h.sessionStart(nested);
	assert.ok(h.activeTools().includes("scope_memory_save"));
	const saved = await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		title: "单仓库布局可用",
		content: "仓库根目录就是 Scope 根目录时，以 . 注册为唯一仓库。",
		evidence: [{ path: "src/app.ts" }],
	});
	assert.match(saved.text, /已创建/);
	assert.match(saved.text, /src\/app\.ts/);
	await h.shutdown();
});

test("根目录本身是仓库时，一级子仓库优先注册", async () => {
	const base = tempRoot();
	const { configPath } = useIsolatedHome(base);
	const root = join(base, "mono");
	mkdirSync(join(root, ".git"), { recursive: true });
	makeRepos(root, ["backend"]);
	const notices: string[] = [];
	const h = harness(notices);
	await h.commands.get("sm")?.handler("init", makeCtx(root, notices) as unknown as ExtensionCommandContext);
	const loaded = loadConfig(configPath);
	if (loaded.status === "loaded") {
		assert.deepEqual(loaded.config.scopes[0]?.repos, { backend: "backend" });
	}
	await h.shutdown();
});

test("/sm init 拒绝重叠 Scope", async () => {
	const base = tempRoot();
	const { configPath } = useIsolatedHome(base);
	const outer = join(base, "outer");
	makeRepos(outer, ["backend"]);
	writeConfig(makeConfig([scopeConfig(outer)]), configPath);
	const innerRoot = join(outer, "backend");
	const notices: string[] = [];
	const h = harness(notices);
	// 通过嵌套目录触发冲突：根目录本身已在 Scope 内。
	await h.commands.get("sm")?.handler("init --name inner", makeCtx(innerRoot, notices) as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("已属于 Scope") || notice.includes("重叠")));
	const loaded = loadConfig(configPath);
	if (loaded.status === "loaded") assert.equal(loaded.config.scopes.length, 1);
	await h.shutdown();
});

test("/sm clear 默认只预览，--yes 才删除并生成备份", async () => {
	const { root, dataDir } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const ctx = makeCtx(join(root, "backend"), notices) as unknown as ExtensionCommandContext;
	await h.sessionStart(ctx);
	await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		title: "Backend 连接池",
		content: "Backend 使用 HikariCP。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});
	await h.commands.get("sm")?.handler("clear --repo backend", ctx);
	assert.ok(notices.some((notice) => notice.includes("未删除任何数据")));
	assert.ok(notices.some((notice) => notice.includes("记忆: 1 条")));

	await h.commands.get("sm")?.handler("clear --repo backend --yes", ctx);
	assert.ok(notices.some((notice) => notice.includes("已清理")));
	const dbPath = join(dataDir, "scopes", "enterprise", "memory.sqlite");
	assert.ok(existsSync(dbPath));
	const backups = readdirSync(join(dataDir, "scopes", "enterprise", "backups"));
	assert.ok(backups.length >= 1);
	assert.ok(readFileSync(join(dataDir, "scopes", "enterprise", "backups", backups[0] as string)).length > 0);
	await h.shutdown();
});

test("扩展不注册每轮上下文注入钩子（Prompt Cache 保障）", () => {
	const notices: string[] = [];
	const h = harness(notices);
	const allowed = new Set(["session_start", "tool_result", "turn_end", "message_end", "agent_settled", "session_shutdown"]);
	for (const event of h.handlers.keys()) {
		assert.ok(allowed.has(event), `不应注册 ${event} 钩子`);
	}
	assert.equal(h.handlers.has("before_agent_start"), false);
	assert.equal(h.handlers.has("context"), false);
	assert.equal(h.handlers.has("context_with_system"), false);
});

test("同一 Scope 多进程并发写入不会互相覆盖", async () => {
	const { root, dataDir } = enterpriseSetup();
	const notices: string[] = [];
	const a = harness(notices);
	const b = harness(notices);
	await a.sessionStart(makeCtx(join(root, "backend"), notices, { sessionId: "a" }));
	await b.sessionStart(makeCtx(join(root, "frontend"), notices, { sessionId: "b" }));
	await execute(a, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		title: "Backend 连接池",
		content: "Backend 使用 HikariCP 连接池。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});
	await execute(b, "scope_memory_save", {
		action: "upsert",
		kind: "preference",
		title: "前端重构后运行类型检查",
		content: "前端重构完成后必须运行 tsc。",
	});
	await a.shutdown();
	await b.shutdown();

	const reopened = harness(notices);
	await reopened.sessionStart(makeCtx(root, notices, { sessionId: "c" }));
	const all = await execute(reopened, "scope_memory_search", { query: "HikariCP OR tsc", target: "all" });
	assert.match(all.text, /HikariCP/);
	assert.match(all.text, /前端重构后运行类型检查/);
	assert.ok(existsSync(join(dataDir, "scopes", "enterprise", "memory.sqlite")));
	await reopened.shutdown();
});
