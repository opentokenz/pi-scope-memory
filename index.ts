import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { registerSmCommand } from "./src/commands.ts";
import { DEFAULT_DEFAULTS, errorMessage, loadConfig } from "./src/config.ts";
import { closeMemoryDb, getMeta, openMemoryDb, setMeta, type MemoryDb } from "./src/db.ts";
import { captureToolResult, recordTurn, runLearningBatch, shouldLearn } from "./src/learning.ts";
import { checkFreshness } from "./src/memory.ts";
import { resolveScope, type ResolvedScope } from "./src/scope.ts";
import { recordSessionUsage } from "./src/stats.ts";
import {
	activateMemoryTools,
	createMemoryRuntime,
	deactivateMemoryTools,
	registerMemoryTools,
	type MemoryRuntime,
} from "./src/tools.ts";

const FRESHNESS_INTERVAL_MS = 60 * 60 * 1000;

export default function scopeMemoryExtension(pi: ExtensionAPI): void {
	const runtime = createMemoryRuntime();

	registerSmCommand({ pi, runtime });
	registerMemoryTools(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		await startSession(pi, runtime, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!runtime.active || !runtime.db) return;
		try {
			captureToolResult(runtime.db, runtime.sessionId, event);
		} catch (error) {
			reportQuietly(ctx, `采集工具事件失败: ${errorMessage(error)}`);
		}
	});

	pi.on("turn_end", async () => {
		if (!runtime.active || !runtime.db) return;
		try {
			recordTurn(runtime.db);
		} catch {
			// Counting turns is advisory; never disturb the main loop.
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!runtime.active || !runtime.db) return;
		try {
			recordMessageUsage(runtime, event, ctx);
		} catch (error) {
			reportQuietly(ctx, `记录用量失败: ${errorMessage(error)}`);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!runtime.active || !runtime.db || !runtime.scope) return;
		if (!ctx.isIdle()) return;
		if (!shouldLearn(runtime.db, runtime.defaults)) return;
		try {
			const outcome = await runLearningBatch(ctx, {
				db: runtime.db,
				scope: runtime.scope,
				defaults: runtime.defaults,
				sessionId: runtime.sessionId,
			});
			if (outcome.status === "ok") {
				runtime.lastLearnedAt = new Date().toISOString();
				const changes = outcome.created + outcome.updated + outcome.superseded;
				if (changes > 0) {
					ctx.ui.notify(
						`记忆学习完成: 新增 ${outcome.created} · 更新 ${outcome.updated} · 替代 ${outcome.superseded} · 跳过 ${outcome.skipped}`,
						"info",
					);
				}
			} else if (outcome.status === "error") {
				reportQuietly(ctx, `记忆学习失败，事件已保留: ${outcome.reason ?? "unknown"}`);
			}
		} catch (error) {
			reportQuietly(ctx, `记忆学习异常: ${errorMessage(error)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		closeMemoryDb(runtime.db);
		runtime.db = undefined;
		runtime.scope = undefined;
		runtime.active = false;
	});
}

async function startSession(pi: ExtensionAPI, runtime: MemoryRuntime, ctx: ExtensionContext): Promise<void> {
	closeMemoryDb(runtime.db);
	runtime.db = undefined;
	runtime.scope = undefined;
	runtime.active = false;
	runtime.sessionId = safeSessionId(ctx);

	const loaded = loadConfig();
	if (loaded.status === "missing") {
		runtime.defaults = structuredClone(DEFAULT_DEFAULTS);
		deactivateMemoryTools(pi);
		return;
	}
	if (loaded.status === "invalid") {
		runtime.defaults = structuredClone(DEFAULT_DEFAULTS);
		deactivateMemoryTools(pi);
		reportQuietly(ctx, `配置无效，记忆未启用: ${loaded.error}`);
		return;
	}

	runtime.defaults = loaded.config.defaults;
	const resolution = resolveScope(loaded.config, ctx.cwd);
	if (!resolution.active) {
		// Staying silent here is intentional: directories outside a configured
		// scope must behave exactly like a Pi without this extension.
		deactivateMemoryTools(pi);
		return;
	}

	let db: MemoryDb;
	try {
		db = openMemoryDb(resolution.resolved.scopeId);
	} catch (error) {
		deactivateMemoryTools(pi);
		reportQuietly(ctx, `无法打开记忆数据库: ${errorMessage(error)}`);
		return;
	}

	runtime.db = db;
	runtime.scope = resolution.resolved;
	runtime.active = true;
	activateMemoryTools(pi);

	try {
		runFreshnessCheckIfDue(db, resolution.resolved);
	} catch (error) {
		reportQuietly(ctx, `记忆复核检查失败: ${errorMessage(error)}`);
	}
}

function runFreshnessCheckIfDue(db: MemoryDb, scope: ResolvedScope): void {
	const last = getMeta(db, "last_freshness_check");
	const now = Date.now();
	if (last !== undefined) {
		const parsed = Date.parse(last);
		if (Number.isFinite(parsed) && now - parsed < FRESHNESS_INTERVAL_MS) return;
	}
	setMeta(db, "last_freshness_check", new Date(now).toISOString());
	checkFreshness(db, scope);
}

function recordMessageUsage(runtime: MemoryRuntime, event: MessageEndEvent, ctx: ExtensionContext): void {
	if (!runtime.db) return;
	const message = event.message;
	if (!message || message.role !== "assistant") return;
	const usage = message.usage;
	if (!usage) return;
	recordSessionUsage(
		runtime.db,
		runtime.sessionId,
		{
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost?.total ?? 0,
		},
		message.provider ?? ctx.model?.provider,
		message.model ?? ctx.model?.id,
	);
}

function safeSessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return `session-${process.pid}`;
	}
}

function reportQuietly(ctx: ExtensionContext, message: string): void {
	try {
		ctx.ui.notify(`pi-scope-memory: ${message}`, "warning");
	} catch {
		// UI may be unavailable in print/JSON modes.
	}
}
