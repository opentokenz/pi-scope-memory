import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	LEARNING_THINKING_LEVELS,
	emptyConfig,
	errorMessage,
	isId,
	loadConfig,
	parseModelReference,
	writeConfig,
	type LearningThinkingLevel,
	type MemoryConfig,
	type ScopeConfig,
} from "./config.ts";
import { backupDatabase, closeMemoryDb, openMemoryDb } from "./db.ts";
import { clearMemories, previewClear, type ClearTarget } from "./memory.ts";
import {
	detectGitRepos,
	findScopeConflicts,
	isGitRepository,
	repoRef,
	resolveScope,
	safeRealpath,
	sanitizeId,
	uniqueId,
	type ResolvedScope,
} from "./scope.ts";
import { collectStats, formatStats } from "./stats.ts";
import type { MemoryRuntime } from "./tools.ts";

const SUBCOMMANDS = ["init", "recall", "clear", "stats", "model"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface CommandDeps {
	pi: ExtensionAPI;
	runtime: MemoryRuntime;
}

export function registerSmCommand({ pi, runtime }: CommandDeps): void {
	pi.registerCommand("sm", {
		description: "pi-scope-memory: init | recall | clear | stats | model",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "init", label: "init", description: "初始化当前目录为 Scope 并启用记忆" },
				{ value: "recall", label: "recall", description: "让 Agent 检索历史记忆" },
				{ value: "clear", label: "clear", description: "预览或清理记忆 (--repo|--shared|--all, --yes)" },
				{ value: "stats", label: "stats", description: "查看记忆、学习与缓存统计" },
				{ value: "model", label: "model", description: "查看或设置学习模型" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "") {
				ctx.ui.notify(helpText(), "info");
				return;
			}
			const space = trimmed.search(/\s/);
			const name = (space === -1 ? trimmed : trimmed.slice(0, space)) as Subcommand;
			const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
			if (!SUBCOMMANDS.includes(name)) {
				ctx.ui.notify(`未知子命令: /sm ${name}\n\n${helpText()}`, "error");
				return;
			}
			try {
				switch (name) {
					case "init":
						await handleInit(ctx, rest);
						return;
					case "recall":
						await handleRecall(pi, runtime, ctx, rest);
						return;
					case "clear":
						await handleClear(runtime, ctx, rest);
						return;
					case "stats":
						await handleStats(runtime, ctx);
						return;
					case "model":
						await handleModel(runtime, ctx, rest);
						return;
				}
			} catch (error) {
				ctx.ui.notify(`pi-scope-memory: ${errorMessage(error)}`, "error");
			}
		},
	});
}

function helpText(): string {
	return [
		"pi-scope-memory",
		"",
		"/sm init [--name <scope>] [--repos a,b,c]   初始化当前目录为 Scope",
		"/sm recall [主题]                           让 Agent 检索相关记忆",
		"/sm clear --repo <repo>|--shared|--all [--yes]  预览或清理记忆",
		"/sm stats                                  查看统计",
		"/sm model                                   选择学习模型，随后选择思考强度",
	].join("\n");
}

async function handleInit(ctx: ExtensionCommandContext, rest: string): Promise<void> {
	const parsed = parseArgs(rest);
	const root = safeRealpath(ctx.cwd) ?? ctx.cwd;
	const loaded = loadConfig();
	if (loaded.status === "invalid") {
		ctx.ui.notify(`配置文件无效，拒绝写入: ${loaded.error}`, "error");
		return;
	}
	const config: MemoryConfig = loaded.status === "loaded" ? loaded.config : emptyConfig();

	const nameFlag = flagValue(parsed, "name");
	let id = nameFlag ?? sanitizeId(basename(root));
	if (!isId(id)) {
		ctx.ui.notify(`Scope ID 非法: ${id}`, "error");
		return;
	}

	const activeHere = resolveScope(config, root);
	if (activeHere.active && activeHere.resolved.root !== root) {
		ctx.ui.notify(
			`当前目录已属于 Scope ${activeHere.resolved.scopeId}（根目录 ${activeHere.resolved.root}）。请到该根目录执行 /sm init，或使用 --name 新建独立 Scope。`,
			"error",
		);
		return;
	}

	let conflicts = findScopeConflicts(config, root, id);
	let sameRoot = conflicts.find((conflict) => conflict.kind === "same-root");
	if (sameRoot && nameFlag === undefined) {
		// Re-running /sm init without --name must reuse the registered scope id
		// even when the directory basename differs from it.
		id = sameRoot.scopeId;
		conflicts = findScopeConflicts(config, root, id);
		sameRoot = conflicts.find((conflict) => conflict.kind === "same-root");
	}
	if (conflicts.some((conflict) => conflict.kind === "duplicate-id")) {
		ctx.ui.notify(`Scope ID 已被其他目录占用: ${id}。请用 --name 指定其他名字。`, "error");
		return;
	}

	const detected = detectRepos(root);
	if (detected.length === 0) {
		ctx.ui.notify(
			`没有在 ${root} 的一级子目录中检测到 Git 仓库，且该目录本身也不是 Git 仓库。请先把仓库放在 Scope 根目录下再执行 /sm init。`,
			"error",
		);
		return;
	}

	const requested = parseRepoList(parsed);
	if (requested) {
		const known = new Set(detected.flatMap((repo) => [repo.id, repo.rel]));
		const missing = requested.filter((name) => !known.has(name));
		if (missing.length > 0) {
			ctx.ui.notify(`--repos 中有未检测到的仓库: ${missing.join(", ")}`, "error");
			return;
		}
	}

	if (sameRoot) {
		const existing = config.scopes.find((scope) => scope.id === sameRoot.scopeId);
		if (!existing) {
			ctx.ui.notify(`配置状态异常: 未找到 Scope ${sameRoot.scopeId}`, "error");
			return;
		}
		if (existing.id !== id) {
			ctx.ui.notify(
				`目录 ${root} 已由 Scope ${existing.id} 管理。不同 ID 不能指向同一根目录，请先清理旧配置。`,
				"error",
			);
			return;
		}
		if (!requested) {
			ctx.ui.notify(
				`Scope ${existing.id} 已初始化。仓库: ${formatRepos(existing)}。新增仓库请显式执行 /sm init --repos <name>。`,
				"info",
			);
			return;
		}
		const picked = detected.filter((repo) => requested.includes(repo.id) || requested.includes(repo.rel));
		const merged: Record<string, string> = { ...existing.repos };
		const used = new Set(Object.keys(merged));
		const registeredPaths = new Set(Object.values(merged));
		for (const repo of picked) {
			if (registeredPaths.has(repo.rel)) continue;
			merged[uniqueId(repo.id, used)] = repo.rel;
			registeredPaths.add(repo.rel);
		}
		existing.repos = sortRecord(merged);
		existing.enabled = true;
		writeConfig(config);
		ctx.ui.notify(
			`Scope ${existing.id} 已更新仓库: ${formatRepos(existing)}。配置改动在下一次 /reload 后生效。`,
			"info",
		);
		return;
	}

	if (conflicts.length > 0) {
		const lines = conflicts
			.map((conflict) => `- ${conflict.kind}: Scope ${conflict.scopeId} (${conflict.root})`)
			.join("\n");
		ctx.ui.notify(`Scope 路径与现有配置重叠，已拒绝写入:\n${lines}`, "error");
		return;
	}

	const picked = requested
		? detected.filter((repo) => requested.includes(repo.id) || requested.includes(repo.rel))
		: detected;
	const repos: Record<string, string> = {};
	const used = new Set<string>();
	for (const repo of picked) repos[uniqueId(repo.id, used)] = repo.rel;

	const scope: ScopeConfig = {
		id,
		root,
		enabled: true,
		repos: sortRecord(repos),
		exclude: ["**/.env*", "**/node_modules/**", "**/dist/**", "**/.git/**"],
	};

	// Create the database before the config points at it.
	const probe = openMemoryDb(scope.id);
	closeMemoryDb(probe);

	config.scopes.push(scope);
	writeConfig(config);

	const lines = [
		`已初始化 Scope: ${scope.id}`,
		`根目录: ${scope.root}`,
		`仓库: ${formatRepos(scope)}`,
		`数据库: ${probe.path}`,
		"",
		"运行 /reload 让记忆工具在本会话生效；新会话会自动加载。",
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

async function handleRecall(
	pi: ExtensionAPI,
	runtime: MemoryRuntime,
	ctx: ExtensionCommandContext,
	rest: string,
): Promise<void> {
	if (!runtime.active || !runtime.scope) {
		ctx.ui.notify("当前目录未激活 pi-scope-memory。先执行 /sm init，然后 /reload。", "error");
		return;
	}
	const topic = rest.trim();
	const scope = runtime.scope;
	const repoIds = scope.repos.map((repo) => repo.id);
	const lines = [
		"请先用 scope_memory_search 检索项目长期记忆，再继续当前任务；不要凭印象回答历史设计与约束。",
		"",
		`Scope: ${scope.scopeId} · 当前仓库: ${scope.repoId ?? "(scope root)"}`,
		`可用仓库: ${repoIds.join(", ") || "(无)"}`,
		topic
			? `检索主题: ${topic}`
			: "检索主题: 从当前任务和本轮上下文推断需要回忆的架构决策、约束、失败经验与阶段性状态。",
		"",
		"检索建议:",
		"- 默认 target=current（Shared + 当前仓库）；涉及跨仓库协议或迁移时用 target=all 或 repo=<name>。",
		"- 用模块名、文件名、符号名或错误信息作为 query；中文主题可以原样传入。",
		"",
		"要求:",
		"1. 先检索，再回答或改代码。",
		"2. 记忆是历史数据，必须与当前代码核对；candidate/review 状态要说明未验证。",
		"3. 如果记忆与当前代码冲突，指出冲突；确认后用 scope_memory_save 的 supersede 或 invalidate 修正旧记忆。",
	];
	const message = lines.join("\n");
	if (ctx.isIdle()) pi.sendUserMessage(message);
	else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

async function handleClear(runtime: MemoryRuntime, ctx: ExtensionCommandContext, rest: string): Promise<void> {
	if (!runtime.active || !runtime.db || !runtime.scope) {
		ctx.ui.notify("当前目录未激活 pi-scope-memory，没有可清理的数据。", "error");
		return;
	}
	const parsed = parseArgs(rest);
	const yes = parsed.flags.has("yes");
	const target = resolveClearTarget(runtime.scope, parsed);
	if (!target) {
		ctx.ui.notify(
			"用法: /sm clear --repo <repo> | --shared | --all  [--yes]\n默认只预览数量，不删除。",
			"info",
		);
		return;
	}
	const preview = previewClear(runtime.db, runtime.scope, target);
	const label =
		target.kind === "shared" ? "Shared 层" : target.kind === "all" ? `Scope ${runtime.scope.scopeId} 全部` : `仓库 ${target.repoId}`;
	if (!yes) {
		ctx.ui.notify(
			[
				`清理预览 · ${label}`,
				`记忆: ${preview.memories} 条（${formatLayerCounts(preview.byLayer)}）`,
				`历史版本: ${preview.revisions} 条`,
				preview.observations > 0 ? `待处理事件: ${preview.observations} 条` : "",
				"",
				"未删除任何数据。确认后执行:",
				`/sm clear ${describeTarget(target)} --yes`,
			]
				.filter((line) => line !== "")
				.join("\n"),
			"info",
		);
		return;
	}
	if (preview.memories === 0 && preview.observations === 0) {
		ctx.ui.notify("没有需要清理的数据。", "info");
		return;
	}
	const db = runtime.db;
	const backup = backupDatabase(db);
	const removed = clearMemories(db, runtime.scope, target);
	ctx.ui.notify(
		[
			`已清理 ${label}`,
			`删除记忆: ${removed.memories} 条`,
			`删除历史版本: ${removed.revisions} 条`,
			removed.observations > 0 ? `删除待处理事件: ${removed.observations} 条` : "",
			`备份: ${backup}`,
			"Scope 配置与其他仓库的记忆未受影响。",
		]
			.filter((line) => line !== "")
			.join("\n"),
		"info",
	);
}

async function handleStats(runtime: MemoryRuntime, ctx: ExtensionCommandContext): Promise<void> {
	if (!runtime.active || !runtime.db || !runtime.scope) {
		ctx.ui.notify("当前目录未激活 pi-scope-memory。先执行 /sm init，然后 /reload。", "error");
		return;
	}
	const stats = collectStats(runtime.db, runtime.scope, runtime.defaults);
	ctx.ui.notify(formatStats(stats, runtime.scope.scopeId, runtime.scope.repoId), "info");
}

async function handleModel(
	runtime: MemoryRuntime,
	ctx: ExtensionCommandContext,
	rest: string,
): Promise<void> {
	const loaded = loadConfig();
	if (loaded.status === "invalid") {
		ctx.ui.notify(`配置文件无效，拒绝写入: ${loaded.error}`, "error");
		return;
	}
	const config = loaded.status === "loaded" ? loaded.config : emptyConfig();
	const parsed = parseArgs(rest);
	const positionalModel = parsed.positional[0];
	const thinkingValue = flagValue(parsed, "thinking");
	const bareThinking = parsed.flags.get("thinking") === true;
	const bareModel = rest.trim() === "";

	if (bareModel) {
		if (!ctx.hasUI) {
			ctx.ui.notify(modelListing(ctx, config), "info");
			return;
		}
		const picked = await pickModel(ctx, config);
		if (picked === undefined) {
			ctx.ui.notify("已取消，学习模型未修改。", "info");
			return;
		}
		const applied = applyModelChoice(ctx, config, picked);
		if (!applied.ok) {
			ctx.ui.notify(applied.error, "error");
			return;
		}
		// Selecting a model and then its reasoning effort is one decision; ask
		// for the effort right away instead of requiring a second command.
		const pickedThinking = await pickThinkingLevel(ctx, config.defaults.learningThinkingLevel);
		if (pickedThinking === undefined) {
			applied.notes.push(
				`学习思考强度保持 ${config.defaults.learningThinkingLevel}（已取消选择）`,
			);
		} else {
			config.defaults.learningThinkingLevel = pickedThinking;
			applied.notes.push(
				`学习思考强度: ${pickedThinking}${describeThinkingSupport(ctx, config.defaults.learningModel)}`,
			);
		}
		persistModelConfig(runtime, config);
		ctx.ui.notify(applied.notes.join("\n"), "info");
		return;
	}

	if (bareThinking) {
		if (!ctx.hasUI) {
			ctx.ui.notify(thinkingListing(ctx, config), "info");
			return;
		}
		const picked = await pickThinkingLevel(ctx, config.defaults.learningThinkingLevel);
		if (picked === undefined) {
			ctx.ui.notify("已取消，思考强度未修改。", "info");
			return;
		}
		config.defaults.learningThinkingLevel = picked;
		persistModelConfig(runtime, config);
		ctx.ui.notify(
			`学习思考强度: ${picked}${describeThinkingSupport(ctx, config.defaults.learningModel)}`,
			"info",
		);
		return;
	}

	const notes: string[] = [];
	if (positionalModel !== undefined) {
		const applied = applyModelChoice(ctx, config, positionalModel);
		if (!applied.ok) {
			ctx.ui.notify(applied.error, "error");
			return;
		}
		notes.push(...applied.notes);
	}

	if (thinkingValue !== undefined) {
		if (!LEARNING_THINKING_LEVELS.includes(thinkingValue as LearningThinkingLevel)) {
			ctx.ui.notify(
				`未知思考强度: ${thinkingValue}\n可用: ${LEARNING_THINKING_LEVELS.join(" | ")}`,
				"error",
			);
			return;
		}
		config.defaults.learningThinkingLevel = thinkingValue as LearningThinkingLevel;
		notes.push(`学习思考强度: ${thinkingValue}${describeThinkingSupport(ctx, config.defaults.learningModel)}`);
	}

	persistModelConfig(runtime, config);
	ctx.ui.notify(notes.join("\n"), "info");
}

/** Apply the new defaults to the running session instead of waiting for /reload. */
function persistModelConfig(runtime: MemoryRuntime, config: MemoryConfig): void {
	writeConfig(config);
	runtime.defaults = config.defaults;
}

type ApplyResult = { ok: true; notes: string[] } | { ok: false; error: string };

function applyModelChoice(
	ctx: ExtensionCommandContext,
	config: MemoryConfig,
	reference: string,
): ApplyResult {
	if (reference === "current") {
		config.defaults.learningModel = "current";
		return { ok: true, notes: ["学习模型: current（跟随当前会话模型）"] };
	}
	let parsed: { provider: string; modelId: string } | undefined;
	try {
		parsed = parseModelReference(reference);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
	if (!parsed) return { ok: false, error: `模型引用非法: ${reference}` };
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		return {
			ok: false,
			error: `未找到模型 ${reference}。运行 /sm model 打开选择器，或先用 /login 配置 Provider。`,
		};
	}
	config.defaults.learningModel = `${parsed.provider}/${parsed.modelId}`;
	const notes = [`学习模型: ${config.defaults.learningModel}`];
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		notes.push("该模型当前未配置凭据，学习会在凭据可用前跳过并保留事件。");
	}
	return { ok: true, notes };
}

interface SelectorEntry {
	label: string;
	value: string;
}

async function pickModel(ctx: ExtensionCommandContext, config: MemoryConfig): Promise<string | undefined> {
	const entries = modelEntries(ctx, config);
	const choice = await ctx.ui.select(
		`选择学习模型（当前: ${config.defaults.learningModel}）`,
		entries.map((entry) => entry.label),
	);
	if (choice === undefined) return undefined;
	return entries.find((entry) => entry.label === choice)?.value;
}

function modelEntries(ctx: ExtensionCommandContext, config: MemoryConfig): SelectorEntry[] {
	const current = config.defaults.learningModel;
	const entries: SelectorEntry[] = [
		{
			label: `current — 跟随当前会话模型${current === "current" ? "  [当前]" : ""}`,
			value: "current",
		},
	];
	const seen = new Set<string>();
	let models: Model<Api>[] = [];
	try {
		models = ctx.modelRegistry.getAvailable();
	} catch {
		models = [];
	}
	for (const model of models) {
		const reference = `${model.provider}/${model.id}`;
		if (seen.has(reference)) continue;
		seen.add(reference);
		const tags = [model.reasoning ? "reasoning" : "", reference === current ? "当前" : ""]
			.filter((tag) => tag !== "")
			.join(", ");
		entries.push({
			label: tags === "" ? reference : `${reference} — ${tags}`,
			value: reference,
		});
	}
	if (current !== "current" && !seen.has(current)) {
		entries.push({ label: `${current} — 当前设置, 未配置凭据`, value: current });
	}
	return entries;
}

async function pickThinkingLevel(
	ctx: ExtensionCommandContext,
	current: LearningThinkingLevel,
): Promise<LearningThinkingLevel | undefined> {
	const entries = thinkingEntries(ctx, current);
	const choice = await ctx.ui.select("选择学习思考强度", entries.map((entry) => entry.label));
	if (choice === undefined) return undefined;
	return entries.find((entry) => entry.label === choice)?.value as LearningThinkingLevel | undefined;
}

function thinkingEntries(ctx: ExtensionCommandContext, current: LearningThinkingLevel): SelectorEntry[] {
	const sessionLevel = ctx.thinkingLevel;
	const descriptions: Record<LearningThinkingLevel, string> = {
		inherit: `跟随当前会话${sessionLevel ? ` (${sessionLevel})` : ""}`,
		off: "不发送 reasoning",
		minimal: "最低强度",
		low: "低强度",
		medium: "中等强度",
		high: "高强度",
		xhigh: "很高强度",
		max: "最高强度",
	};
	return LEARNING_THINKING_LEVELS.map((level) => ({
		label: `${level} — ${descriptions[level]}${level === current ? "  [当前]" : ""}`,
		value: level,
	}));
}

function modelListing(ctx: ExtensionCommandContext, config: MemoryConfig): string {
	const available = availableModels(ctx, 30);
	return [
		`学习模型: ${config.defaults.learningModel}`,
		`学习思考强度: ${config.defaults.learningThinkingLevel}${describeThinkingSupport(ctx, config.defaults.learningModel)}`,
		"",
		"交互模式下直接运行 /sm model 选择模型，随后选择思考强度；/sm model --thinking 只调整强度。",
		"也支持显式输入: /sm model current | <provider/model-id> [--thinking <level>]。",
		`可用强度: ${LEARNING_THINKING_LEVELS.join(" | ")}`,
		"",
		"可用模型:",
		...available.map((entry) => `${entry === config.defaults.learningModel ? "*" : " "} ${entry}`),
	].join("\n");
}

function thinkingListing(ctx: ExtensionCommandContext, config: MemoryConfig): string {
	return [
		`学习思考强度: ${config.defaults.learningThinkingLevel}`,
		"",
		"交互模式下直接运行 /sm model --thinking 打开选择器；",
		`也支持: /sm model --thinking <level>，可用 ${LEARNING_THINKING_LEVELS.join(" | ")}。`,
		"inherit 跟随当前会话；off 不发送 reasoning；其余为固定强度。",
	].join("\n");
}

function describeThinkingSupport(ctx: ExtensionCommandContext, reference: string): string {
	if (reference === "current") {
		return ctx.model?.reasoning === false ? "（当前模型未声明 reasoning）" : "";
	}
	const slash = reference.indexOf("/");
	if (slash <= 0) return "";
	const model = ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
	if (!model) return "";
	return model.reasoning ? "（模型支持 reasoning）" : "（模型未声明 reasoning）";
}

function availableModels(ctx: ExtensionCommandContext, limit: number): string[] {
	let models: Model<Api>[] = [];
	try {
		models = ctx.modelRegistry.getAvailable();
	} catch {
		models = [];
	}
	if (models.length === 0) return ["(没有已配置凭据的模型)"];
	return models
		.map((model) => `${model.provider}/${model.id}`)
		.sort((a, b) => a.localeCompare(b))
		.slice(0, limit);
}

function resolveClearTarget(scope: ResolvedScope, parsed: ParsedArgs): ClearTarget | undefined {
	const repo = flagValue(parsed, "repo");
	const shared = parsed.flags.has("shared");
	const all = parsed.flags.has("all");
	const selected = [repo !== undefined, shared, all].filter(Boolean).length;
	if (selected !== 1) return undefined;
	if (repo !== undefined) {
		if (!repoRef(scope, repo)) {
			throw new Error(`未知仓库: ${repo}。可用: ${scope.repos.map((item) => item.id).join(", ")}`);
		}
		return { kind: "repo", repoId: repo };
	}
	if (shared) return { kind: "shared" };
	return { kind: "all" };
}

function describeTarget(target: ClearTarget): string {
	if (target.kind === "repo") return `--repo ${target.repoId}`;
	return target.kind === "shared" ? "--shared" : "--all";
}

function formatLayerCounts(byLayer: Record<string, number>): string {
	const parts = Object.entries(byLayer)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([layer, count]) => `${layer}: ${count}`);
	return parts.length === 0 ? "空" : parts.join(" · ");
}

function formatRepos(scope: ScopeConfig): string {
	const entries = Object.entries(scope.repos);
	if (entries.length === 0) return "(无子仓库，使用 Shared 层)";
	return entries.map(([id, path]) => (path === "." ? `${id} (根目录)` : `${id} → ${path}`)).join(", ");
}

/** Detect sub-repositories, or the scope root itself when it is a single repository. */
function detectRepos(root: string): { id: string; rel: string }[] {
	const subRepos = detectGitRepos(root);
	if (subRepos.length > 0) return subRepos;
	if (isGitRepository(root)) {
		const id = sanitizeId(basename(root));
		return [{ id, rel: "." }];
	}
	return [];
}

function parseRepoList(parsed: ParsedArgs): string[] | undefined {
	const raw = flagValue(parsed, "repos");
	if (raw === undefined) return undefined;
	const items = raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return items.length > 0 ? items : undefined;
}

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string | true>;
}

function parseArgs(input: string): ParsedArgs {
	const tokens = tokenize(input);
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const body = token.slice(2);
		const equals = body.indexOf("=");
		if (equals >= 0) {
			flags.set(body.slice(0, equals), body.slice(equals + 1));
			continue;
		}
		const next = tokens[index + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(body, next);
			index += 1;
		} else {
			flags.set(body, true);
		}
	}
	return { positional, flags };
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

function flagValue(parsed: ParsedArgs, name: string): string | undefined {
	const value = parsed.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function sortRecord(input: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(input).sort()) out[key] = input[key] as string;
	return out;
}
