import type { DefaultsConfig } from "./config.ts";
import { getMeta, getMetaNumber, nowIso, type MemoryDb } from "./db.ts";
import { countMemories, pendingObservations } from "./memory.ts";
import type { ResolvedScope } from "./scope.ts";

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ScopeStats {
	scopeId: string;
	repoId?: string;
	total: number;
	byLayer: Record<string, number>;
	byStatus: Record<string, number>;
	searchCalls: number;
	session: TokenTotals;
	cacheReadRatio: number | null;
	learning: TokenTotals;
	learningToday: number;
	learningBudget: number;
	retrievalTokens: number;
	pendingEvents: number;
	verificationFailures: number;
	lastLearningAt?: string;
	lastLearningError?: string;
}

export function collectStats(db: MemoryDb, scope: ResolvedScope, defaults: DefaultsConfig): ScopeStats {
	const counts = countMemories(db, scope);
	const session = totals(db, "session");
	const learning = totals(db, "learning");
	const totalInput = session.input + session.cacheRead + session.cacheWrite;
	return {
		scopeId: scope.scopeId,
		repoId: scope.repoId,
		total: counts.total,
		byLayer: counts.byLayer,
		byStatus: counts.byStatus,
		searchCalls: getMetaNumber(db, "search_calls"),
		session,
		cacheReadRatio: totalInput === 0 ? null : session.cacheRead / totalInput,
		learning,
		learningToday: learningTokensToday(db),
		learningBudget: defaults.learningTokenBudgetPerDay,
		retrievalTokens: Math.round(getMetaNumber(db, "retrieval_tokens")),
		pendingEvents: pendingObservations(db),
		verificationFailures: getMetaNumber(db, "verification_failures"),
		lastLearningAt: getMeta(db, "last_learning_at"),
		lastLearningError: getMeta(db, "last_learning_error"),
	};
}

export function formatStats(stats: ScopeStats, scopeName: string, repoName?: string): string {
	const active =
		(stats.byStatus.active ?? 0) + (stats.byStatus.candidate ?? 0) + (stats.byStatus.review ?? 0);
	const layerLine = Object.entries(stats.byLayer)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([layer, count]) => `${layer === "shared" ? "Shared" : layer}: ${count}`)
		.join(" · ");
	const statusLine = Object.entries(stats.byStatus)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${status}: ${count}`)
		.join(" · ");
	const cacheRatio = stats.cacheReadRatio === null ? "无数据" : `${(stats.cacheReadRatio * 100).toFixed(1)}%`;
	const budget = stats.learningBudget > 0 ? `${formatTokens(stats.learningToday)} / ${formatTokens(stats.learningBudget)}` : "不限";
	const lines = [
		`Scope: ${scopeName}${repoName ? ` · Repo: ${repoName}` : " · Repo: (scope root)"}`,
		"",
		`Active Memories      ${active}`,
		`Search Calls         ${stats.searchCalls}`,
		`Cache Read Ratio     ${cacheRatio}`,
		`Learning Tokens      ${formatTokens(stats.learning.input + stats.learning.output)} (今日 ${budget})`,
		`Retrieval Tokens     ${stats.retrievalTokens}`,
		"",
		`Layers   ${layerLine || "空"}`,
		`Status   ${statusLine || "空"}`,
		"",
		`Session Tokens   in ${stats.session.input} · out ${stats.session.output} · cache read ${stats.session.cacheRead} · cache write ${stats.session.cacheWrite}`,
		`Cost             $${(stats.session.cost + stats.learning.cost).toFixed(4)} (session $${stats.session.cost.toFixed(4)} / learning $${stats.learning.cost.toFixed(4)})`,
		`Pending Events   ${stats.pendingEvents}`,
		`Verify Failures  ${stats.verificationFailures}`,
	];
	if (stats.lastLearningAt) lines.push(`Last Learning    ${stats.lastLearningAt}`);
	if (stats.lastLearningError) lines.push(`Learning Error   ${stats.lastLearningError.slice(0, 300)}`);
	if ((stats.byStatus.review ?? 0) > 0) {
		lines.push("", "提示: review 状态的记忆关联文件已变更，检索时会降权并标记，需要复核。");
	}
	return lines.join("\n");
}

export function recordSessionUsage(
	db: MemoryDb,
	sessionId: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
	provider?: string,
	model?: string,
): void {
	insertUsage(db, sessionId, "session", usage, provider, model);
}

export function recordLearningUsage(
	db: MemoryDb,
	sessionId: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
	provider?: string,
	model?: string,
): void {
	insertUsage(db, sessionId, "learning", usage, provider, model);
}

export function recordRetrievalUsage(db: MemoryDb, sessionId: string, tokens: number): void {
	insertUsage(db, sessionId, "retrieval", {
		input: Math.max(0, Math.round(tokens)),
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	});
}

function insertUsage(
	db: MemoryDb,
	sessionId: string,
	source: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
	provider?: string,
	model?: string,
): void {
	db.sqlite
		.prepare(
			`INSERT INTO usage_stats
			 (session_id, source, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			sessionId,
			source,
			provider ?? null,
			model ?? null,
			Math.max(0, Math.round(usage.input)),
			Math.max(0, Math.round(usage.output)),
			Math.max(0, Math.round(usage.cacheRead)),
			Math.max(0, Math.round(usage.cacheWrite)),
			usage.cost,
			nowIso(),
		);
	if (source === "retrieval") {
		const row = db.sqlite
			.prepare("SELECT coalesce(sum(input_tokens), 0) AS n FROM usage_stats WHERE source = 'retrieval'")
			.get();
		db.sqlite
			.prepare(
				"INSERT INTO meta (key, value) VALUES ('retrieval_tokens', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(String(row ? Number(row.n) : 0));
	}
}

function totals(db: MemoryDb, source: string): TokenTotals {
	const row = db.sqlite
		.prepare(
			`SELECT
				coalesce(sum(input_tokens), 0) AS input,
				coalesce(sum(output_tokens), 0) AS output,
				coalesce(sum(cache_read_tokens), 0) AS cacheRead,
				coalesce(sum(cache_write_tokens), 0) AS cacheWrite,
				coalesce(sum(cost_usd), 0) AS cost
			 FROM usage_stats WHERE source = ?`,
		)
		.get(source);
	return {
		input: row ? Number(row.input) : 0,
		output: row ? Number(row.output) : 0,
		cacheRead: row ? Number(row.cacheRead) : 0,
		cacheWrite: row ? Number(row.cacheWrite) : 0,
		cost: row ? Number(row.cost) : 0,
	};
}

export function learningTokensToday(db: MemoryDb): number {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const row = db.sqlite
		.prepare(
			`SELECT coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS n
			 FROM usage_stats WHERE source = 'learning' AND created_at >= ?`,
		)
		.get(start.toISOString());
	return row ? Number(row.n) : 0;
}

/** Rough token estimate used for retrieval budgeting. */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil([...text].length / 2.5));
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(Math.round(value));
}
