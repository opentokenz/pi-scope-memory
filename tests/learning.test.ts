import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { closeMemoryDb, openMemoryDb, type MemoryDb } from "../src/db.ts";
import {
	captureToolResult,
	extractCandidates,
	isInterestingToolResult,
	recordTurn,
	runContextLearning,
	runLearningBatch,
	shouldLearn,
	type LearningDeps,
} from "../src/learning.ts";
import { saveMemory, searchMemories } from "../src/memory.ts";
import { recordLearningUsage } from "../src/stats.ts";
import { resolveScope, type ResolvedScope } from "../src/scope.ts";
import type { DefaultsConfig, MemoryConfig } from "../src/config.ts";
import { assistantMessage, cleanupTempDirs, makeConfig, makeRepos, tempRoot, useIsolatedHome, writeFile, scopeConfig } from "./helpers.ts";

after(cleanupTempDirs);
beforeEach(() => cleanupTempDirs());

interface Fixture {
	root: string;
	config: MemoryConfig;
	scope: ResolvedScope;
	db: MemoryDb;
}

function fixture(): Fixture {
	const base = tempRoot();
	useIsolatedHome(base);
	const root = join(base, "enterprise");
	makeRepos(root, ["backend", "frontend"]);
	writeFile(join(root, "backend"), "src/auth/refresh.ts", "export function refresh() {}\n");
	const config = makeConfig([scopeConfig(root)]);
	const resolution = resolveScope(config, join(root, "backend"));
	if (!resolution.active) throw new Error("scope resolution failed");
	return { root, config, scope: resolution.resolved, db: openMemoryDb("enterprise") };
}

function toolResult(overrides: Partial<ToolResultEvent> & { toolName: string }): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `call-${Math.random().toString(36).slice(2)}`,
		input: {},
		content: [],
		isError: false,
		details: undefined,
		...overrides,
	} as unknown as ToolResultEvent;
}

interface CapturedRequest {
	reasoning?: unknown;
	systemPrompt?: string;
	prompt?: string;
}

function fakeContext(
	reply: string | (() => Promise<never>),
	captured: CapturedRequest = {},
	thinkingLevel: string | undefined = "high",
	message: Record<string, unknown> = {},
): ExtensionContext {
	const respond = async () =>
		typeof reply === "string" ? assistantMessage(reply, message) : reply();
	return {
		model: { provider: "anthropic", id: "test-model", reasoning: true },
		thinkingLevel,
		modelRegistry: {
			streamSimple: (
				_model: unknown,
				context: { systemPrompt?: string; messages?: { content?: { text?: string }[] }[] },
				options?: { reasoning?: unknown },
			) => {
				captured.reasoning = options?.reasoning;
				captured.systemPrompt = context.systemPrompt;
				captured.prompt = context.messages?.[0]?.content?.[0]?.text;
				return { result: respond };
			},
			find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
			hasConfiguredAuth: () => true,
		},
		signal: undefined,
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

test("事件采集只记录有价值的事件，并用 toolCallId 去重", () => {
	const fx = fixture();
	try {
		const read = toolResult({ toolName: "read", input: { path: "src/a.ts" } });
		assert.equal(isInterestingToolResult(read), false);
		assert.equal(captureToolResult(fx.db, "session-1", read), false);

		const grep = toolResult({ toolName: "grep", input: { pattern: "x" } });
		assert.equal(captureToolResult(fx.db, "session-1", grep), false);

		const edit = toolResult({
			toolName: "edit",
			toolCallId: "edit-1",
			input: { path: "src/auth/refresh.ts" },
		});
		assert.equal(captureToolResult(fx.db, "session-1", edit), true);
		assert.equal(captureToolResult(fx.db, "session-1", edit), false, "同一 toolCallId 不重复记录");

		const repeatedEdit = toolResult({
			toolName: "edit",
			toolCallId: "edit-2",
			input: { path: "src/auth/refresh.ts" },
		});
		assert.equal(captureToolResult(fx.db, "session-1", repeatedEdit), false, "同内容事件在待处理窗口内合并");

		const failingTest = toolResult({
			toolName: "bash",
			toolCallId: "bash-1",
			input: { command: "pnpm test auth" },
			isError: true,
			content: [{ type: "text", text: "1 test failed: refresh race" }],
		});
		assert.equal(captureToolResult(fx.db, "session-1", failingTest), true);

		const rows = fx.db.sqlite
			.prepare("SELECT event_type, payload_json FROM observations ORDER BY created_at")
			.all();
		assert.equal(rows.length, 2);
		assert.equal(String(rows[0]?.event_type), "file_change");
		assert.match(String(rows[0]?.payload_json), /src\/auth\/refresh\.ts/);
		assert.equal(String(rows[1]?.event_type), "test_failure");
		assert.match(String(rows[1]?.payload_json), /refresh race/);
		const payload = JSON.parse(String(rows[1]?.payload_json)) as Record<string, unknown>;
		assert.equal(payload.ok, false);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习触发条件：达到事件数或轮次阈值", () => {
	const fx = fixture();
	try {
		const defaults = fx.config.defaults;
		assert.equal(shouldLearn(fx.db, defaults), false);
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		// minEvents = 3 in the test config, so two more are needed.
		assert.equal(shouldLearn(fx.db, defaults), false);
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w2", input: { path: "src/b.ts" } }),
		);
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w3", input: { path: "src/c.ts" } }),
		);
		assert.equal(shouldLearn(fx.db, defaults), true);

		const off: DefaultsConfig = { ...defaults, autoLearn: false };
		assert.equal(shouldLearn(fx.db, off), false);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("轮次阈值在事件不足时也能触发", () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		recordTurn(fx.db);
		assert.equal(shouldLearn(fx.db, fx.config.defaults), false);
		recordTurn(fx.db);
		assert.equal(shouldLearn(fx.db, fx.config.defaults), true);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习思考强度：inherit 跟随会话，off 不发送 reasoning", async () => {
	const fx = fixture();
	try {
		const inherit = { reasoning: "unset" as unknown };
		const reply = '[]';
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "t1", input: { path: "src/a.ts" } }),
		);
		const withHigh = await runLearningBatch(fakeContext(reply, inherit, "high"), {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningThinkingLevel: "inherit" },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(withHigh.status, "ok");
		assert.equal(inherit.reasoning, "high");

		const off = { reasoning: "unset" as unknown };
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "t2", input: { path: "src/b.ts" } }),
		);
		await runLearningBatch(fakeContext(reply, off, "high"), {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningThinkingLevel: "off" },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(off.reasoning, undefined);

		const fixed = { reasoning: "unset" as unknown };
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "t3", input: { path: "src/c.ts" } }),
		);
		await runLearningBatch(fakeContext(reply, fixed, "high"), {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningThinkingLevel: "low" },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(fixed.reasoning, "low");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习提示词可在全局配置中定制，并始终追加 JSON 输出契约", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "p1", input: { path: "src/a.ts" } }),
		);
		const custom: CapturedRequest = {};
		const customOutcome = await runLearningBatch(fakeContext("[]", custom), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {
				learningSystem: "自定义提炼器规则",
				learningGuidance: "优先记录认证相关约束",
			},
			sessionId: "s",
		});
		assert.equal(customOutcome.status, "ok");
		assert.match(custom.systemPrompt ?? "", /^自定义提炼器规则/);
		assert.match(custom.systemPrompt ?? "", /优先记录认证相关约束/);
		assert.match(custom.systemPrompt ?? "", /只输出 JSON 数组/);

		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "p2", input: { path: "src/b.ts" } }),
		);
		const builtIn: CapturedRequest = {};
		await runLearningBatch(fakeContext("[]", builtIn), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {},
			sessionId: "s",
		});
		assert.match(builtIn.systemPrompt ?? "", /工程知识提炼器/);
		assert.match(builtIn.systemPrompt ?? "", /只输出 JSON 数组/);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习提示词列出仓库挂载布局并区分改写与替代", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "l1", input: { path: "src/a.ts" } }),
		);
		const captured: CapturedRequest = {};
		await runLearningBatch(fakeContext("[]", captured), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {},
			sessionId: "s",
		});
		assert.match(captured.prompt ?? "", /可用仓库（证据路径必须相对于仓库根目录）/);
		assert.match(captured.prompt ?? "", /- backend: backend/);
		assert.match(captured.prompt ?? "", /- frontend: frontend/);
		assert.match(captured.prompt ?? "", /backend\/backend/);
		assert.match(captured.prompt ?? "", /同一结论的补充或改写/);
		assert.match(captured.systemPrompt ?? "", /项目子目录/);
		assert.match(captured.systemPrompt ?? "", /不要用 replaces/);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习提示词会标注已有记忆的 review 状态", async () => {
	const fx = fixture();
	try {
		saveMemory(
			fx.db,
			fx.scope,
			{
				action: "upsert",
				kind: "fact",
				title: "刷新函数签名",
				content: "refresh() 返回 { token: string }。",
				evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
			},
			fx.config.defaults.retrieval,
		);
		fx.db.sqlite.prepare("UPDATE memories SET status = 'review'").run();
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "r1", input: { path: "src/a.ts" } }),
		);
		const captured: CapturedRequest = {};
		await runLearningBatch(fakeContext("[]", captured), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {},
			sessionId: "s",
		});
		assert.match(captured.prompt ?? "", /\[backend\|review\]/);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("学习输出解析容忍代码块与无效字段", () => {
	const parsed = extractCandidates(
		[
			"```json",
			JSON.stringify([
				{
					kind: "pitfall",
					title: "刷新竞态",
					content: "并发刷新需要 singleflight。",
					layer: "repo",
					repo: "backend",
					evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
					tags: ["auth"],
				},
				{ kind: "unknown-kind", content: "忽略" },
				{ kind: "fact", content: "" },
			]),
			"```",
		].join("\n"),
	);
	assert.ok(parsed);
	assert.equal(parsed?.length, 1);
	assert.equal(parsed?.[0]?.kind, "pitfall");
	assert.equal(parsed?.[0]?.evidence[0]?.path, "src/auth/refresh.ts");

	assert.equal(extractCandidates("没有 JSON"), undefined);
	assert.equal(extractCandidates("[{broken"), undefined);

	// Prose after the array must not swallow the closing bracket.
	const withTrailingProse = `${JSON.stringify([{ kind: "fact", title: "标题", content: "正文", evidence: [] }])}\n（依据 README[1]）`;
	assert.equal(extractCandidates(withTrailingProse)?.length, 1);
});

test("学习批次写入记忆、记录用量并清空待处理事件", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "edit", toolCallId: "e1", input: { path: "src/auth/refresh.ts" } }),
		);
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "bash", toolCallId: "e2", input: { command: "pnpm test" }, isError: true }),
		);
		const reply = JSON.stringify([
			{
				kind: "pitfall",
				title: "Token 刷新竞态",
				content: "并发刷新 Token 会产生竞态，使用 singleflight 合并请求。",
				layer: "repo",
				repo: "backend",
				evidence: [{ repo: "backend", path: "src/auth/refresh.ts" }],
				tags: ["auth"],
			},
			{
				kind: "decision",
				title: "认证协议版本",
				content: "backend 与 frontend 统一使用 Auth API V2。",
				layer: "shared",
				evidence: [],
			},
		]);
		const outcome = await runLearningBatch(fakeContext(reply), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {},
			sessionId: "s",
		});
		assert.equal(outcome.status, "ok");
		assert.equal(outcome.processed, 2);
		assert.equal(outcome.created, 2);
		const pending = fx.db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
		assert.equal(Number(pending?.n), 0);
		const usage = fx.db.sqlite
			.prepare("SELECT count(*) AS n, sum(input_tokens) AS tokens FROM usage_stats WHERE source = 'learning'")
			.get();
		assert.equal(Number(usage?.n), 1);
		assert.equal(Number(usage?.tokens), 100);

		const hits = searchMemories(fx.db, fx.scope, { query: "singleflight" }, fx.config.defaults.retrieval);
		assert.equal(hits.hits.length, 1);
		assert.equal(hits.hits[0]?.memory.status, "active");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("一次学习最多保存一条 checkpoint", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "c1", input: { path: "src/a.ts" } }),
		);
		const reply = JSON.stringify([
			{ kind: "checkpoint", title: "阶段一完成", content: "后端改造完成，等待验收。" },
			{ kind: "checkpoint", title: "阶段二完成", content: "前端改造完成，等待验收。" },
		]);
		const outcome = await runLearningBatch(fakeContext(reply), {
			db: fx.db,
			scope: fx.scope,
			defaults: fx.config.defaults,
			prompts: {},
			sessionId: "s",
		});
		assert.equal(outcome.status, "ok");
		assert.equal(outcome.created, 1);
		assert.equal(outcome.skipped, 1);
		const count = fx.db.sqlite.prepare("SELECT count(*) AS n FROM memories WHERE kind = 'checkpoint'").get();
		assert.equal(Number(count?.n), 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("预算耗尽时暂停学习并保留事件；0 表示不限额", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		recordLearningUsage(fx.db, "s", {
			input: 5000,
			output: 1000,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
		});
		const budgeted = await runLearningBatch(fakeContext("[]"), {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningTokenBudgetPerDay: 100 },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(budgeted.status, "skipped");
		assert.match(budgeted.reason ?? "", /budget/);
		const pending = fx.db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
		assert.equal(Number(pending?.n), 1, "超预算时事件必须保留");

		const unlimited = await runLearningBatch(fakeContext("[]"), {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningTokenBudgetPerDay: 0 },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(unlimited.status, "ok");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("模型不可用时保留事件并记录错误", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		const ctx = fakeContext("[]");
		(ctx.modelRegistry as unknown as { streamSimple: unknown }).streamSimple = () => ({
			result: async () => {
				throw new Error("provider down");
			},
		});
		const outcome = await runLearningBatch(ctx, {
			db: fx.db,
			scope: fx.scope,
			defaults: { ...fx.config.defaults, learningTokenBudgetPerDay: 100_000 },
			prompts: {},
			sessionId: "s",
		});
		assert.equal(outcome.status, "error");
		const pending = fx.db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
		assert.equal(Number(pending?.n), 1);
		const error = fx.db.sqlite.prepare("SELECT value FROM meta WHERE key = 'last_learning_error'").get();
		assert.match(String(error?.value), /provider down/);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("输出被截断时救回完整候选，并如实报告截断而不是非法 JSON", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "edit", toolCallId: "e1", input: { path: "src/auth/refresh.ts" } }),
		);
		// A real truncation: the array never closes and the second candidate is cut
		// mid-string, exactly what a maxTokens cut-off produces.
		const truncated = [
			'[{"kind":"pitfall","title":"刷新竞态","content":"并发刷新需要 singleflight 合并。","layer":"repo","repo":"backend","evidence":[{"repo":"backend","path":"src/auth/refresh.ts"}],"tags":["auth"]},',
			'{"kind":"fact","title":"认证协议","content":"统一使用 Auth API',
		].join("");
		const outcome = await runLearningBatch(
			fakeContext(truncated, {}, "high", {
				stopReason: "length",
				usage: { input: 900, output: 6000, cacheRead: 0, cacheWrite: 0, totalTokens: 6900, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
			}),
			{ db: fx.db, scope: fx.scope, defaults: fx.config.defaults, prompts: {}, sessionId: "s" },
		);
		assert.equal(outcome.status, "ok");
		assert.equal(outcome.created, 1, "截断前的完整候选必须被保存");
		assert.match(outcome.reason ?? "", /截断/);
		const saved = fx.db.sqlite.prepare("SELECT title FROM memories").all();
		assert.equal(saved.length, 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("截断且没有完整候选时保留事件并报告截断", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		const outcome = await runLearningBatch(
			fakeContext('[{"kind":"pitfall","title":"刷新竞', {}, "high", {
				stopReason: "length",
				usage: { input: 900, output: 6000, cacheRead: 0, cacheWrite: 0, totalTokens: 6900, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
			}),
			{ db: fx.db, scope: fx.scope, defaults: fx.config.defaults, prompts: {}, sessionId: "s" },
		);
		assert.equal(outcome.status, "error");
		assert.match(outcome.reason ?? "", /截断/);
		const pending = fx.db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
		assert.equal(Number(pending?.n), 1, "颗粒无收时事件必须保留");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("非法 JSON 触发有限重试而不是无限循环", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } }),
		);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const outcome = await runLearningBatch(fakeContext("not json"), {
				db: fx.db,
				scope: fx.scope,
				defaults: fx.config.defaults,
				prompts: {},
			sessionId: "s",
			});
			assert.equal(outcome.status, "error");
		}
		const rows = fx.db.sqlite.prepare("SELECT processed, attempts FROM observations").all();
		assert.equal(rows.length, 1);
		assert.equal(Number(rows[0]?.attempts), 3);
		assert.equal(Number(rows[0]?.processed), 1);
	} finally {
		closeMemoryDb(fx.db);
	}
});

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantDialogue(text: string): AgentMessage {
	return assistantMessage(text) as unknown as AgentMessage;
}

const CONTEXT_REPLY = JSON.stringify([
	{
		kind: "decision",
		title: "认证刷新使用 refresh token 轮换",
		content: "认证刷新采用 refresh token 轮换，不退回 Session。",
		layer: "repo",
		repo: "backend",
		evidence: [{ repo: "backend", path: "src/auth/refresh.ts", reason: "刷新逻辑实现位置" }],
		tags: ["auth"],
	},
]);

function contextDeps(fx: Fixture): LearningDeps {
	return { db: fx.db, scope: fx.scope, defaults: fx.config.defaults, prompts: {}, sessionId: "s" };
}

test("手动提炼：会话记录是来源，用户输入只作为提炼提示", async () => {
	const fx = fixture();
	try {
		captureToolResult(
			fx.db,
			"s",
			toolResult({ toolName: "write", toolCallId: "w1", input: { path: "src/auth/refresh.ts" } }),
		);
		const captured: CapturedRequest = {};
		const outcome = await runContextLearning(fakeContext(CONTEXT_REPLY, captured), contextDeps(fx), {
			messages: [
				userMessage("认证刷新必须使用 refresh token 轮换，不要改回 Session。"),
				assistantDialogue("已确认：轮换逻辑位于 backend/src/auth/refresh.ts。"),
			],
			hint: "只记录认证刷新相关的约束",
		});

		assert.equal(outcome.status, "ok");
		assert.equal(outcome.created, 1);
		assert.match(captured.prompt ?? "", /只记录认证刷新相关的约束/);
		assert.match(captured.prompt ?? "", /不要改回 Session/);
		assert.match(captured.prompt ?? "", /不是事实来源/);
		assert.match(captured.systemPrompt ?? "", /当前会话记录/);

		const pending = fx.db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
		assert.equal(Number(pending?.n), 1, "手动提炼不应消费自动学习的事件队列");
		const usage = fx.db.sqlite.prepare("SELECT count(*) AS n FROM usage_stats WHERE source = 'learning'").get();
		assert.equal(Number(usage?.n), 1, "手动提炼的用量必须计入学习成本");
		const hits = searchMemories(
			fx.db,
			fx.scope,
			{ query: "refresh token 轮换" },
			fx.config.defaults.retrieval,
		);
		assert.ok(hits.hits.length > 0, "提炼结果必须能从同一 Scope 检索到");
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("手动提炼：没有对话时跳过且不调用模型", async () => {
	const fx = fixture();
	try {
		const captured: CapturedRequest = {};
		const outcome = await runContextLearning(fakeContext(CONTEXT_REPLY, captured), contextDeps(fx), {
			messages: [],
		});
		assert.equal(outcome.status, "skipped");
		assert.match(outcome.reason ?? "", /没有可提炼的对话/);
		assert.equal(captured.prompt, undefined);
	} finally {
		closeMemoryDb(fx.db);
	}
});

test("手动提炼：使用独立提示词，不与观察事件提示词混用", async () => {
	const fx = fixture();
	try {
		const messages = [userMessage("记录一条偏好。"), assistantDialogue("好的。")];
		const autoOnly: CapturedRequest = {};
		await runContextLearning(fakeContext(CONTEXT_REPLY, autoOnly), {
			...contextDeps(fx),
			prompts: { learningSystem: "只处理观察事件的规则" },
		}, { messages });
		assert.match(autoOnly.systemPrompt ?? "", /当前会话记录/);
		assert.doesNotMatch(autoOnly.systemPrompt ?? "", /只处理观察事件的规则/);

		const explicit: CapturedRequest = {};
		await runContextLearning(fakeContext(CONTEXT_REPLY, explicit), {
			...contextDeps(fx),
			prompts: {
				learningSystem: "只处理观察事件的规则",
				manualLearningSystem: "自定义会话提炼规则",
				learningGuidance: "优先记录认证相关约束",
			},
		}, { messages });
		assert.match(explicit.systemPrompt ?? "", /^自定义会话提炼规则/);
		assert.match(explicit.systemPrompt ?? "", /优先记录认证相关约束/);
		assert.match(explicit.systemPrompt ?? "", /只输出 JSON 数组/);
		assert.doesNotMatch(explicit.systemPrompt ?? "", /只处理观察事件的规则/);
	} finally {
		closeMemoryDb(fx.db);
	}
});
