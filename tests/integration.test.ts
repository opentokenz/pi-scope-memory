import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { loadConfig, writeConfig } from "../src/config.ts";
import { resolveScope } from "../src/scope.ts";
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

/** Model shape the command layer reads: reasoning capability plus per-level support. */
function fakeModel(provider: string, id: string): Record<string, unknown> {
	return {
		provider,
		id,
		reasoning: true,
		// Shaped like deepseek-v4.1-flash: medium and xhigh are unsupported.
		...(provider === "openai"
			? { thinkingLevelMap: { low: "low", high: "high", max: "max", medium: null, xhigh: null } }
			: {}),
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
		streamSimple?: (...args: unknown[]) => { result: () => Promise<unknown> };
	} = {},
): ExtensionContext {
	return {
		cwd,
		mode: options.hasUI ? "tui" : "print",
		hasUI: options.hasUI === true,
		signal: undefined,
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
		model: fakeModel("anthropic", "test-model"),
		modelRegistry: {
			complete: options.complete ?? (async () => assistantMessage("[]")),
			find: (provider: string, id: string) => (provider === "nope" ? undefined : fakeModel(provider, id)),
			hasConfiguredAuth: () => true,
			streamSimple:
				options.streamSimple ??
				((_model: unknown, _context: unknown, _options: unknown) => ({
					result: async () => assistantMessage("[]"),
				})),
			getAvailable: () => [fakeModel("anthropic", "test-model"), fakeModel("openai", "gpt-x")],
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
	ctx: Record<string, unknown> = {},
): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = h.tools.get(toolName);
	assert.ok(tool, `tool ${toolName} 未注册`);
	return tool.execute("call-1", params, undefined, undefined, ctx).then((result) => ({
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

test("/sm verify 重新核对证据并在恢复后回到 active", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		title: "hikari 连接池",
		content: "后端连接池使用 hikari 标识。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});

	writeFile(join(root, "backend"), "src/db.ts", "export const pool = 'pg';\n");
	await h.commands.get("sm")?.handler("verify", makeCtx(join(root, "backend"), notices) as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("标记 review 1")), notices.join("\n"));

	writeFile(join(root, "backend"), "src/db.ts", "export const pool = 'hikari';\n");
	await h.commands.get("sm")?.handler("verify", makeCtx(join(root, "backend"), notices) as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("恢复 active 1")), notices.join("\n"));
	await h.shutdown();
});

test("读取证据文件时追加一次性记忆提示", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	await execute(h, "scope_memory_save", {
		action: "upsert",
		kind: "fact",
		title: "连接池使用 HikariCP",
		content: "后端连接池使用 HikariCP。",
		evidence: [{ repo: "backend", path: "src/db.ts" }],
	});

	const handler = h.handlers.get("tool_result");
	assert.ok(handler);
	const ctx = makeCtx(join(root, "backend"), notices) as unknown as ExtensionContext;
	const read = (path: string) =>
		handler(
			{
				type: "tool_result",
				toolCallId: `read-${path}`,
				toolName: "read",
				input: { path },
				content: [{ type: "text", text: "export const pool = 'hikari';" }],
				isError: false,
			},
			ctx,
		);

	const first = (await read("src/db.ts")) as { content?: { text: string }[] } | undefined;
	assert.match(first?.content?.map((part) => part.text).join("\n") ?? "", /长期记忆提示/);
	assert.match(first?.content?.map((part) => part.text).join("\n") ?? "", /连接池使用 HikariCP/);

	const second = (await read("src/db.ts")) as { content?: { text: string }[] } | undefined;
	assert.ok(!second?.content?.some((part) => part.text.includes("长期记忆提示")), "同一路径只提示一次");
	const unrelated = (await read("src/other.ts")) as { content?: { text: string }[] } | undefined;
	assert.ok(!unrelated?.content?.some((part) => part.text.includes("长期记忆提示")), "无证据文件不提示");

	await execute(h, "scope_memory_search", { query: "HikariCP" });
	await h.commands.get("sm")?.handler("stats", makeCtx(root, notices) as unknown as ExtensionCommandContext);
	assert.ok(
		notices.some((notice) => /Memory Hints\s+shown 1 · followed 1/.test(notice)),
		notices.join("\n"),
	);
	await h.shutdown();
});

test("每个会话最多追加 3 条路径提示", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	const names = ["a.ts", "b.ts", "c.ts", "d.ts"];
	for (const name of names) {
		writeFile(join(root, "backend"), `src/${name}`, `export const ${name.replace(".", "_")} = true;\n`);
		await execute(h, "scope_memory_save", {
			action: "upsert",
			kind: "fact",
			title: `${name} 的约定`,
			content: `${name} 存放模块约定。`,
			evidence: [{ repo: "backend", path: `src/${name}` }],
		});
	}
	const handler = h.handlers.get("tool_result");
	assert.ok(handler);
	const ctx = makeCtx(join(root, "backend"), notices) as unknown as ExtensionContext;
	let hints = 0;
	for (const name of names) {
		const result = (await handler(
			{
				type: "tool_result",
				toolCallId: `read-${name}`,
				toolName: "read",
				input: { path: `src/${name}` },
				content: [{ type: "text", text: "content" }],
				isError: false,
			},
			ctx,
		)) as { content?: { text: string }[] } | undefined;
		if (result?.content?.some((part) => part.text.includes("长期记忆提示"))) hints += 1;
	}
	assert.equal(hints, 3);
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

	// 非交互模式的位置参数: /sm model <model> <level>
	await command.handler("model openai/gpt-x max", ctx as unknown as ExtensionCommandContext);
	const positional = loadConfig();
	if (positional.status === "loaded") {
		assert.equal(positional.config.defaults.learningModel, "openai/gpt-x");
		assert.equal(positional.config.defaults.learningThinkingLevel, "max");
	}
	await command.handler("model openai/gpt-x turbo", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("未知思考强度: turbo")));
	await command.handler("model openai/gpt-x low high", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("参数过多")));
	await command.handler("model openai/gpt-x low --thinking high", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("重复指定")));
	await command.handler("model openai/gpt-x --thinking", ctx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("--thinking 后需要强度值")));

	await command.handler("model current", ctx as unknown as ExtensionCommandContext);
	const reset = loadConfig();
	if (reset.status === "loaded") assert.equal(reset.config.defaults.learningModel, "current");
	await h.shutdown();
});

test("/sm model 在交互模式下先选模型，再选思考强度", async () => {
	const { base } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const command = h.commands.get("sm");
	assert.ok(command);

	const titles: string[] = [];
	const modelCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async (title, items) => {
			titles.push(title);
			if (title.includes("选择学习模型")) {
				return items.find((item) => item.startsWith("openai/gpt-x"));
			}
			return items.find((item) => item.startsWith("high"));
		},
	});
	await command.handler("model", modelCtx as unknown as ExtensionCommandContext);
	assert.equal(titles.length, 2, "选完模型后应继续弹出思考强度选择器");
	assert.match(titles[0] ?? "", /选择学习模型/);
	assert.match(titles[1] ?? "", /选择学习思考强度/);
	const picked = loadConfig();
	assert.equal(picked.status, "loaded");
	if (picked.status === "loaded") {
		assert.equal(picked.config.defaults.learningModel, "openai/gpt-x");
		assert.equal(picked.config.defaults.learningThinkingLevel, "high");
	}
	assert.ok(notices.some((notice) => notice.includes("学习模型: openai/gpt-x")));
	assert.ok(notices.some((notice) => notice.includes("学习思考强度: high")));

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

	const cancelThinkingCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async (title, items) => {
			if (title.includes("选择学习模型")) return items.find((item) => item.startsWith("anthropic/test-model"));
			return undefined;
		},
	});
	await command.handler("model", cancelThinkingCtx as unknown as ExtensionCommandContext);
	const afterCancelThinking = loadConfig();
	if (afterCancelThinking.status === "loaded") {
		assert.equal(afterCancelThinking.config.defaults.learningModel, "anthropic/test-model");
		assert.equal(afterCancelThinking.config.defaults.learningThinkingLevel, "low", "第二步取消时保留原强度");
	}
	assert.ok(notices.some((notice) => notice.includes("保持 low")));

	const cancelCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async () => undefined,
	});
	await command.handler("model", cancelCtx as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("已取消")));
	const afterCancel = loadConfig();
	if (afterCancel.status === "loaded") assert.equal(afterCancel.config.defaults.learningModel, "anthropic/test-model");
	await h.shutdown();
});

test("思考强度选择器只展示模型支持的等级", async () => {
	const { base } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const command = h.commands.get("sm");
	assert.ok(command);

	const offered: string[][] = [];
	const ctx = makeCtx(base, notices, {
		hasUI: true,
		select: async (title, items) => {
			if (title.includes("选择学习模型")) return items.find((item) => item.startsWith("openai/gpt-x"));
			offered.push(items);
			return items.find((item) => item.startsWith("high"));
		},
	});
	await command.handler("model", ctx as unknown as ExtensionCommandContext);

	const levels = (offered[0] ?? []).map((item) => item.split(" — ")[0] ?? "");
	assert.ok(levels.includes("inherit"), "inherit 是策略而不是具体强度，必须保留");
	assert.ok(levels.includes("off"));
	assert.ok(levels.includes("high"));
	assert.ok(!levels.includes("medium"), "模型把 medium 映射为 null，不应出现在选择器里");
	assert.ok(!levels.includes("xhigh"));

	// 显式写入一个不受支持的强度仍然允许，但必须提示实际生效值。
	await command.handler("model openai/gpt-x medium", ctx as unknown as ExtensionCommandContext);
	assert.ok(
		notices.some((notice) => notice.includes("模型不支持 medium，实际按 high 运行")),
		`应提示实际强度，实际输出: ${notices.join(" / ")}`,
	);

	// 当前强度不受支持时，选择器仍要展示它，并标注实际生效值。
	const current: string[][] = [];
	const thinkingCtx = makeCtx(base, notices, {
		hasUI: true,
		select: async (_title, items) => {
			current.push(items);
			return undefined;
		},
	});
	await command.handler("model --thinking", thinkingCtx as unknown as ExtensionCommandContext);
	const marked = (current[0] ?? []).find((item) => item.startsWith("medium"));
	assert.ok(marked, "当前强度必须出现在选择器里");
	assert.match(marked ?? "", /实际按 high 运行/);
	await h.shutdown();
});

test("/sm model 修改后当前会话的学习调用立即生效", async () => {
	const { root } = enterpriseSetup();
	const notices: string[] = [];
	const h = harness(notices);
	const ctx = makeCtx(join(root, "backend"), notices, { sessionId: "learn-session" });
	await h.sessionStart(ctx);

	for (const [index, path] of ["src/a.ts", "src/b.ts", "src/c.ts"].entries()) {
		await h.handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolCallId: `obs-${index}`,
				input: { path },
				content: [],
				isError: false,
				details: undefined,
				toolName: "edit",
			},
			ctx,
		);
	}

	await h.commands.get("sm")?.handler("model --thinking high", ctx as unknown as ExtensionCommandContext);

	let captured: unknown = "unset";
	const learnCtx = makeCtx(join(root, "backend"), notices, {
		sessionId: "learn-session",
		streamSimple: (_model, _context, options) => {
			captured = (options as { reasoning?: unknown }).reasoning;
			return { result: async () => assistantMessage("[]") };
		},
	});
	await h.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, learnCtx);
	assert.equal(captured, "high", "同一会话内 /sm model 的设置必须立即生效");
	await h.shutdown();
});

test("UI 反馈：记忆工具调用时给出临时通知，不写页脚状态", async () => {
	const { root, base } = enterpriseSetup();
	const notices: string[] = [];
	let footerWrites = 0;
	const h = harness(notices);
	const ctx = makeCtx(join(root, "backend"), notices, { hasUI: true });
	const ui = (ctx as unknown as { ui: Record<string, unknown> }).ui;
	ui.setStatus = () => {
		footerWrites += 1;
	};
	await h.sessionStart(ctx);

	const saved = await execute(
		h,
		"scope_memory_save",
		{
			action: "upsert",
			kind: "fact",
			title: "Backend 使用 HikariCP",
			content: "Backend 连接池使用 HikariCP。",
			evidence: [{ repo: "backend", path: "src/db.ts" }],
		},
		ctx as unknown as Record<string, unknown>,
	);
	assert.match(saved.text, /已创建/);
	assert.ok(notices.some((notice) => notice.includes("记忆已创建: Backend 使用 HikariCP")));

	await execute(
		h,
		"scope_memory_search",
		{ query: "HikariCP" },
		ctx as unknown as Record<string, unknown>,
	);
	assert.ok(notices.some((notice) => notice.includes("记忆检索: 1 条匹配")));
	assert.equal(footerWrites, 0, "不应调用 setStatus 改写页脚");

	await h.shutdown();
	await h.sessionStart(
		makeCtx(join(base, "unrelated"), notices, { hasUI: true, sessionId: "outside" }),
	);
	assert.deepEqual(h.activeTools(), []);
	assert.equal(footerWrites, 0);
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

test("/sm init 拒绝未指定 --name 的重叠 Scope", async () => {
	const base = tempRoot();
	const { configPath } = useIsolatedHome(base);
	const outer = join(base, "outer");
	makeRepos(outer, ["backend"]);
	writeConfig(makeConfig([scopeConfig(outer)]), configPath);
	// 未注册为仓库的内层目录：不会命中「已属于 Scope」前置检查，直接落到重叠检查。
	const innerRoot = join(outer, "inner");
	makeRepos(innerRoot, ["service-a"]);
	const notices: string[] = [];
	const h = harness(notices);
	await h.commands.get("sm")?.handler("init", makeCtx(innerRoot, notices) as unknown as ExtensionCommandContext);
	assert.ok(notices.some((notice) => notice.includes("重叠")));
	const loaded = loadConfig(configPath);
	if (loaded.status === "loaded") assert.equal(loaded.config.scopes.length, 1);
	await h.shutdown();
});

test("/sm init --name 允许在已有 Scope 目录树内建立嵌套 Scope", async () => {
	const base = tempRoot();
	const { configPath, dataDir } = useIsolatedHome(base);
	const outer = join(base, "outer");
	makeRepos(outer, ["backend"]);
	writeConfig(makeConfig([scopeConfig(outer)]), configPath);
	const innerRoot = join(outer, "inner");
	makeRepos(innerRoot, ["service-a", "service-b"]);
	const notices: string[] = [];
	const h = harness(notices);

	await h.commands.get("sm")?.handler(
		"init --name inner",
		makeCtx(innerRoot, notices) as unknown as ExtensionCommandContext,
	);

	const loaded = loadConfig(configPath);
	assert.equal(loaded.status, "loaded");
	if (loaded.status !== "loaded") return;
	assert.equal(loaded.config.scopes.length, 2);
	const inner = loaded.config.scopes.find((scope) => scope.id === "inner");
	assert.equal(inner?.root, innerRoot);
	assert.deepEqual(inner?.repos, { "service-a": "service-a", "service-b": "service-b" });
	assert.ok(existsSync(join(dataDir, "scopes", "inner", "memory.sqlite")));
	assert.ok(notices.some((notice) => notice.includes("嵌套于")));

	// 运行时按最具体目录归属：内层目录进 inner，外层仓库仍属 outer。
	const innerResolved = resolveScope(loaded.config, join(innerRoot, "service-a"));
	assert.equal(innerResolved.active, true);
	if (innerResolved.active) assert.equal(innerResolved.resolved.scopeId, "inner");
	const outerResolved = resolveScope(loaded.config, join(outer, "backend"));
	assert.equal(outerResolved.active, true);
	if (outerResolved.active) assert.equal(outerResolved.resolved.scopeId, "enterprise");

	// 已注册仓库目录也可以用 --name 拆成独立内层 Scope。
	await h.commands.get("sm")?.handler(
		"init --name backend-solo",
		makeCtx(join(outer, "backend"), notices) as unknown as ExtensionCommandContext,
	);
	const split = loadConfig(configPath);
	assert.equal(split.status, "loaded");
	if (split.status === "loaded") {
		assert.ok(split.config.scopes.some((scope) => scope.id === "backend-solo"));
		const splitResolved = resolveScope(split.config, join(outer, "backend"));
		if (splitResolved.active) assert.equal(splitResolved.resolved.scopeId, "backend-solo");
	}
	await h.shutdown();
});

test("/sm recall 支持全局配置的提示词模板", async () => {
	const { root } = enterpriseSetup();
	const loaded = loadConfig();
	assert.equal(loaded.status, "loaded");
	if (loaded.status !== "loaded") return;
	loaded.config.prompts = {
		recall: "请检索 {scope}/{repo}，仓库: {repos}。主题: {topic}。先调用 scope_memory_search。",
	};
	writeConfig(loaded.config);

	const notices: string[] = [];
	const sent: string[] = [];
	const h = harness(notices, sent);
	await h.sessionStart(makeCtx(join(root, "backend"), notices));
	await h.commands.get("sm")?.handler(
		"recall 认证为什么放弃 Session",
		makeCtx(root, notices) as unknown as ExtensionCommandContext,
	);
	assert.equal(
		sent[0],
		"请检索 enterprise/backend，仓库: backend, frontend, sdk。主题: 认证为什么放弃 Session。先调用 scope_memory_search。",
	);

	// 模板缺少 {topic} 时，用户显式主题仍必须附加到消息末尾。
	const second = loadConfig();
	if (second.status === "loaded") {
		second.config.prompts = { recall: "请检索 {scope} 并调用 scope_memory_search" };
		writeConfig(second.config);
	}
	await h.sessionStart(makeCtx(join(root, "backend"), notices, { sessionId: "recall-2" }));
	await h.commands.get("sm")?.handler(
		"recall 支付回调",
		makeCtx(root, notices) as unknown as ExtensionCommandContext,
	);
	assert.equal(sent[1], "请检索 enterprise 并调用 scope_memory_search\n\n检索主题: 支付回调");

	// 未提供主题时，{topic} 替换为默认的推断语句。
	const third = loadConfig();
	if (third.status === "loaded") {
		third.config.prompts = { recall: "先调用 scope_memory_search，主题: {topic}" };
		writeConfig(third.config);
	}
	await h.sessionStart(makeCtx(join(root, "backend"), notices, { sessionId: "recall-3" }));
	await h.commands.get("sm")?.handler(
		"recall",
		makeCtx(root, notices) as unknown as ExtensionCommandContext,
	);
	assert.match(sent[2] ?? "", /从当前任务和本轮上下文推断/);
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
