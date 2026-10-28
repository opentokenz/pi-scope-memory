import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { RetrievalConfig } from "./config.ts";
import { incrementMeta, nowIso, withTransaction, type MemoryDb } from "./db.ts";
import { repoAbsolutePath, repoRef, type ResolvedScope } from "./scope.ts";

export const MEMORY_KINDS = ["fact", "decision", "constraint", "pitfall", "preference", "checkpoint"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["active", "candidate", "review", "superseded", "expired"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export type MemorySource = "agent" | "learning" | "user";

export interface MemoryEvidence {
	repo?: string;
	path?: string;
	commit?: string;
	/** Branch the evidence was observed on, for worktree-specific facts. */
	branch?: string;
	reason?: string;
	/** Whether the referenced path existed when the memory was verified. */
	verified?: boolean;
	verifiedAt?: string;
	/** Content hash (or size/mtime fingerprint) captured at verification time. */
	hash?: string;
	/** Set when the file changed after verification. */
	stale?: boolean;
}

export interface MemoryRecord {
	id: string;
	repoId: string | null;
	kind: MemoryKind;
	title: string;
	content: string;
	status: MemoryStatus;
	source: MemorySource;
	evidence: MemoryEvidence[];
	relatedPaths: string[];
	tags: string[];
	supersededBy: string | null;
	supersedes: string | null;
	confidence: number;
	expiresAt: string | null;
	verifiedAt: string | null;
	rev: number;
	createdAt: string;
	updatedAt: string;
}

export interface MemorySearchOptions {
	query?: string;
	target?: "current" | "shared" | "all";
	repo?: string;
	includeHistorical?: boolean;
	limit?: number;
	/** Internal lookups (dedupe, conflict detection) do not count as user searches. */
	trackCall?: boolean;
}

export interface MemorySearchHit {
	memory: MemoryRecord;
	score: number;
	snippet: string;
	matchedBy: "fts" | "substring" | "recent";
}

export interface MemorySearchResult {
	hits: MemorySearchHit[];
	candidates: number;
}

export interface MemorySaveInput {
	action: "upsert" | "supersede" | "invalidate";
	kind: MemoryKind;
	content: string;
	title?: string;
	layer?: "auto" | "shared" | "repo";
	repo?: string;
	memoryId?: string;
	evidence?: MemoryEvidence[];
	tags?: string[];
	source?: MemorySource;
}

export type RelatedRelation = "duplicate" | "conflict" | "related";

export interface RelatedMemory {
	id: string;
	title: string;
	kind: MemoryKind;
	layer: "shared" | "repo";
	repoId: string | null;
	status: MemoryStatus;
	similarity: number;
	relation: RelatedRelation;
}

export interface SaveMemoryResult {
	action: "created" | "updated" | "superseded" | "invalidated" | "skipped";
	id?: string;
	memory?: MemoryRecord;
	status?: MemoryStatus;
	related: RelatedMemory[];
	notes: string[];
}

export interface ClearTarget {
	kind: "repo" | "shared" | "all";
	repoId?: string;
}

export interface ClearPreview {
	memories: number;
	revisions: number;
	observations: number;
	byLayer: Record<string, number>;
}

export class MemoryError extends Error {}

const MAX_CONTENT_CHARS = 8000;
const MAX_TITLE_CHARS = 100;
const CHECKPOINT_TTL_DAYS = 14;
const MAX_EVIDENCE_ITEMS = 12;
const CANDIDATE_LIMIT = 500;

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"was",
	"were",
	"are",
	"not",
	"but",
	"you",
	"use",
	"using",
	"into",
	"when",
	"how",
	"why",
	"what",
	"all",
	"any",
	"can",
	"has",
	"have",
]);

const SUPERSEDE_SIGNAL =
	/(不再|改为|改用|迁移|替换|替代|废弃|弃用|已从|已经不再|之前是|现在是|no longer|replaced|migrated|switch(?:ed)? to|deprecated|instead of)/i;

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

const KIND_WEIGHT: Record<MemoryKind, number> = {
	fact: 1,
	decision: 1.1,
	constraint: 1.12,
	pitfall: 1.06,
	preference: 1,
	checkpoint: 0.8,
};

const STATUS_WEIGHT: Record<MemoryStatus, number> = {
	active: 1,
	candidate: 0.86,
	review: 0.72,
	superseded: 0.45,
	expired: 0.4,
};

interface Filter {
	sql: string;
	params: string[];
}

/**
 * Search memories inside one scope.
 *
 * The query is a control signal, never an instruction: results are data with a
 * status label, so the agent has to check them against the current code.
 */
export function searchMemories(
	db: MemoryDb,
	scope: ResolvedScope,
	options: MemorySearchOptions,
	retrieval: RetrievalConfig,
): MemorySearchResult {
	const query = (options.query ?? "").trim();
	const includeHistorical = options.includeHistorical === true;
	const limit = clamp(options.limit ?? retrieval.topK, 1, 50);
	const filter = buildFilter(scope, options);

	const statuses: MemoryStatus[] = includeHistorical
		? [...MEMORY_STATUSES]
		: retrieval.includeStale
			? ["active", "candidate", "review", "expired"]
			: ["active", "candidate", "review"];

	const rows = new Map<string, { row: Record<string, unknown>; matchedBy: MemorySearchHit["matchedBy"] }>();
	const queryTokens = tokenize(query);

	if (query !== "") {
		for (const row of runFts(db, filter, statuses, query, limit, CANDIDATE_LIMIT)) {
			rows.set(String(row.id), { row, matchedBy: "fts" });
		}
		const substringRows = runSubstring(db, filter, statuses, query, CANDIDATE_LIMIT);
		for (const row of substringRows) {
			const id = String(row.id);
			if (!rows.has(id)) rows.set(id, { row, matchedBy: "substring" });
		}
	}

	if (rows.size < Math.min(CANDIDATE_LIMIT, limit * 4)) {
		for (const row of runRecent(db, filter, statuses, CANDIDATE_LIMIT)) {
			const id = String(row.id);
			if (!rows.has(id)) rows.set(id, { row, matchedBy: "recent" });
		}
	}

	const normalizedQuery = normalizeText(query);
	const hits: MemorySearchHit[] = [];
	for (const { row, matchedBy } of rows.values()) {
		const memory = rowToMemory(row);
		const scored = scoreMemory(memory, queryTokens, normalizedQuery, matchedBy);
		if (query !== "" && !scored.relevant) continue;
		hits.push({ memory, score: scored.score, snippet: buildSnippet(memory.content), matchedBy });
	}

	hits.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));

	const budgeted: MemorySearchHit[] = [];
	let usedTokens = 0;
	for (const hit of hits.slice(0, limit)) {
		const cost = estimateTokens(hit.memory.title) + estimateTokens(hit.snippet);
		if (budgeted.length > 0 && usedTokens + cost > retrieval.maxTokens) break;
		budgeted.push(hit);
		usedTokens += cost;
	}

	if (query !== "" && options.trackCall !== false) incrementMeta(db, "search_calls");

	return { hits: budgeted, candidates: hits.length };
}

export function getMemory(db: MemoryDb, id: string): MemoryRecord | undefined {
	const row = db.sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(id);
	return row ? rowToMemory(row) : undefined;
}

/** Memories that could be duplicates or outdated versions of a new memory. */
export function findRelatedMemories(
	db: MemoryDb,
	scope: ResolvedScope,
	input: { title: string; content: string; repoId: string | null; kind: MemoryKind },
	retrieval: RetrievalConfig,
	excludeId?: string,
): RelatedMemory[] {
	const query = `${input.title}\n${input.content}`.slice(0, 800);
	const result = searchMemories(
		db,
		scope,
		{
			query,
			target: input.repoId === null ? "shared" : "current",
			repo: input.repoId ?? undefined,
			includeHistorical: true,
			limit: 10,
			trackCall: false,
		},
		{ ...retrieval, maxTokens: 8000, topK: 10 },
	);

	const inputTokens = tokenize(query);
	const normalizedTitle = normalizeText(input.title);
	const supersedeSignal = SUPERSEDE_SIGNAL.test(input.content);
	const rows = result.hits.filter((hit) => hit.memory.id !== excludeId);
	const related: RelatedMemory[] = [];
	for (const hit of rows) {
		const candidateTokens = tokenize(`${hit.memory.title}\n${hit.memory.content}`);
		const similarity = round(jaccard(inputTokens, candidateTokens), 3);
		const sameKind = hit.memory.kind === input.kind;
		const sameTitle = normalizedTitle !== "" && normalizedTitle === normalizeText(hit.memory.title);
		// A repeated title with a plain refinement is an update. The same title
		// with an explicit "changed to / no longer" statement is a replacement.
		const relation: RelatedRelation = !sameKind
			? "related"
			: sameTitle
				? supersedeSignal
					? "conflict"
					: "duplicate"
				: similarity >= 0.82
					? "duplicate"
					: similarity >= 0.35 && supersedeSignal
						? "conflict"
						: "related";
		related.push({
			id: hit.memory.id,
			title: hit.memory.title,
			kind: hit.memory.kind,
			layer: hit.memory.repoId === null ? "shared" : "repo",
			repoId: hit.memory.repoId,
			status: hit.memory.status,
			similarity,
			relation,
		});
	}
	related.sort((a, b) => b.similarity - a.similarity);
	return related.slice(0, 8);
}

/**
 * Save, update or retire a memory.
 *
 * Every write first searches existing memories in the same layer, then decides
 * between updating, superseding or adding. The history stays in
 * `memory_revisions`; active retrieval never serves a superseded memory.
 */
export function saveMemory(
	db: MemoryDb,
	scope: ResolvedScope,
	input: MemorySaveInput,
	retrieval: RetrievalConfig,
): SaveMemoryResult {
	const source = input.source ?? "agent";
	if (!MEMORY_KINDS.includes(input.kind)) throw new MemoryError(`未知记忆类型: ${String(input.kind)}`);
	if (input.action === "invalidate") {
		return invalidateMemory(db, scope, input, retrieval);
	}
	const content = (input.content ?? "").trim();
	if (content === "") throw new MemoryError("content 不能为空");
	if (content.length > MAX_CONTENT_CHARS) {
		throw new MemoryError(`content 超过 ${MAX_CONTENT_CHARS} 字符上限，请压缩后重试`);
	}
	assertNoSecrets(content);

	const { repoId, notes } = resolveLayer(scope, input, content);
	const title = deriveTitle(input.title, content);
	assertNoSecrets(title);
	const evidenceResult = validateEvidence(scope, repoId, input.evidence ?? []);
	notes.push(...evidenceResult.notes);

	if (input.action === "supersede" && !input.memoryId) {
		const candidates = findRelatedMemories(
			db,
			scope,
			{ title, content, repoId, kind: input.kind },
			retrieval,
		);
		const conflict =
			candidates.find((candidate) => candidate.relation === "conflict") ??
			candidates.find((candidate) => candidate.relation === "duplicate");
		if (conflict) input.memoryId = conflict.id;
	}

	const dedupeKey = buildDedupeKey(repoId, input.kind, title);
	const related = findRelatedMemories(db, scope, { title, content, repoId, kind: input.kind }, retrieval);
	// The dedupe key catches an exact same-title/same-layer entry even when the
	// wording changed too much for similarity scoring to flag it.
	const exactDuplicate = findActiveByDedupeKey(db, dedupeKey, repoId);
	const layerMatches = related.filter(
		(candidate) => candidate.layer === (repoId === null ? "shared" : "repo") && candidate.repoId === repoId,
	);
	// "Same title + a change statement" is a replacement, not an update, even
	// though the dedupe key matches.
	const conflict =
		layerMatches.find((candidate) => candidate.relation === "conflict") ??
		(exactDuplicate && SUPERSEDE_SIGNAL.test(content)
			? ({ ...(toRelated(exactDuplicate) as RelatedMemory), relation: "conflict" as const })
			: undefined);
	const duplicate = conflict
		? undefined
		: (layerMatches.find(
				(candidate) => candidate.relation === "duplicate" || candidate.similarity >= 0.82,
			) ?? toRelated(exactDuplicate));
	const sharedDuplicate =
		repoId === null
			? undefined
			: (related.find(
					(candidate) =>
						candidate.layer === "shared" &&
						(candidate.relation === "duplicate" || candidate.similarity >= 0.82),
				) ?? toRelated(findActiveByDedupeKey(db, buildDedupeKey(null, input.kind, title), null)));

	const status = decideStatus(input.kind, evidenceResult.verifiedCount, source);
	const now = nowIso();

	if (input.action === "supersede") {
		const oldId = input.memoryId;
		if (!oldId) throw new MemoryError("supersede 需要 memoryId，或存在可被替代的历史记忆");
		const old = requireVisibleMemory(db, scope, oldId);
		if (old.status === "superseded") {
			notes.push(`记忆 ${oldId} 已处于 superseded 状态`);
		}
		return withTransaction(db, () => {
			recordRevision(db, old.id, "supersede", old);
			const created = insertMemory(db, {
				repoId,
				kind: input.kind,
				title,
				content,
				status,
				source,
				dedupeKey,
				evidence: evidenceResult.items,
				tags: input.tags ?? [],
				supersedes: old.id,
				expiresAt: checkpointExpiry(input.kind, now),
				verifiedAt: evidenceResult.verifiedCount > 0 ? now : null,
			});
			const updated = bumpRev(db, old.id, {
				status: "superseded",
				supersededBy: created.id,
				updatedAt: now,
			});
			recordRevision(db, created.id, "create", created);
			recordRevision(db, old.id, "superseded", updated);
			return {
				action: "superseded",
				id: created.id,
				memory: created,
				status: created.status,
				related,
				notes: [...notes, `旧记忆 ${old.id} 已标记 superseded`],
			};
		});
	}

	if (duplicate) {
		const existing = getMemory(db, duplicate.id);
		if (!existing) throw new MemoryError(`记忆 ${duplicate.id} 在保存过程中消失`);
		if (existing.status === "superseded" || existing.status === "expired") {
			notes.push(`匹配到已失效记忆 ${existing.id}，按新记忆保存`);
		} else {
			return withTransaction(db, () => {
				recordRevision(db, existing.id, "update", existing);
				const mergedEvidence = mergeEvidence(existing.evidence, evidenceResult.items);
				const updated = bumpRev(db, existing.id, {
					title,
					content,
					status: status === "candidate" && existing.status === "active" ? "active" : status,
					source,
					evidenceJson: JSON.stringify(mergedEvidence),
					relatedPathsJson: JSON.stringify(pathsFromEvidence(mergedEvidence)),
					tagsJson: JSON.stringify(union(existing.tags, input.tags ?? [])),
					dedupeKey,
					expiresAt: checkpointExpiry(input.kind, now),
					verifiedAt:
						evidenceResult.verifiedCount > 0 ? now : existing.verifiedAt,
					updatedAt: now,
				});
				recordRevision(db, existing.id, "update", updated);
				return {
					action: "updated",
					id: updated.id,
					memory: updated,
					status: updated.status,
					related,
					notes: [...notes, `更新已有记忆（相似度 ${duplicate.similarity}），未新建重复条目`],
				};
			});
		}
	}

	if (sharedDuplicate) {
		return {
			action: "skipped",
			id: sharedDuplicate.id,
			related,
			notes: [
				...notes,
				`Shared 层已有等价记忆 ${sharedDuplicate.id}，仓库层不再重复保存`,
			],
		};
	}

	return withTransaction(db, () => {
		if (conflict) notes.push(`检测到冲突记忆 ${conflict.id}，已替代`);
		const created = insertMemory(db, {
			repoId,
			kind: input.kind,
			title,
			content,
			status,
			source,
			dedupeKey,
			evidence: evidenceResult.items,
			tags: input.tags ?? [],
			supersedes: conflict?.id ?? null,
			expiresAt: checkpointExpiry(input.kind, now),
			verifiedAt: evidenceResult.verifiedCount > 0 ? now : null,
		});
		recordRevision(db, created.id, "create", created);
		if (conflict) {
			const old = getMemory(db, conflict.id);
			if (old && old.status !== "superseded") {
				recordRevision(db, old.id, "supersede", old);
				bumpRev(db, old.id, { status: "superseded", supersededBy: created.id, updatedAt: now });
			}
		}
		if (status === "candidate") {
			notes.push("缺少可验证的代码证据，已保存为 candidate（检索时会标注未验证）");
		}
		return {
			// A conflict means the new memory replaces an outdated one, so the
			// caller sees the same action it would get from an explicit supersede.
			action: conflict ? "superseded" : "created",
			id: created.id,
			memory: created,
			status: created.status,
			related,
			notes,
		};
	});
}

/** Mark one memory as superseded/expired without creating a replacement. */
function invalidateMemory(
	db: MemoryDb,
	scope: ResolvedScope,
	input: MemorySaveInput,
	retrieval: RetrievalConfig,
): SaveMemoryResult {
	const memoryId = input.memoryId?.trim();
	if (!memoryId) throw new MemoryError("invalidate 需要 memoryId");
	const existing = requireVisibleMemory(db, scope, memoryId);
	if (existing.status === "superseded" || existing.status === "expired") {
		return { action: "invalidated", id: existing.id, memory: existing, status: existing.status, related: [], notes: ["记忆已失效，无需重复操作"] };
	}
	const now = nowIso();
	return withTransaction(db, () => {
		recordRevision(db, existing.id, "invalidate", existing);
		const nextStatus: MemoryStatus = existing.kind === "checkpoint" ? "expired" : "superseded";
		const updated = bumpRev(db, existing.id, { status: nextStatus, updatedAt: now });
		recordRevision(db, existing.id, "invalidate", updated);
		const related = findRelatedMemories(db, scope, {
			title: existing.title,
			content: existing.content,
			repoId: existing.repoId,
			kind: existing.kind,
		}, retrieval);
		return {
			action: "invalidated",
			id: updated.id,
			memory: updated,
			status: updated.status,
			related: related.map((item) => ({ ...item, relation: item.relation === "duplicate" ? "related" : item.relation })),
			notes: [`记忆 ${updated.id} 已标记 ${nextStatus}`],
		};
	});
}

/** Expire stale checkpoints and flag memories whose evidence files changed. */
export function checkFreshness(db: MemoryDb, scope: ResolvedScope, limit = 40): {
	expired: number;
	checked: number;
	flagged: number;
} {
	const now = nowIso();
	const expired = db.sqlite
		.prepare(
			"UPDATE memories SET status = 'expired', updated_at = ? WHERE kind = 'checkpoint' AND status IN ('active','candidate') AND expires_at IS NOT NULL AND expires_at < ?",
		)
		.run(now, now);

	const rows = db.sqlite
		.prepare(
			"SELECT * FROM memories WHERE status = 'active' AND evidence_json != '[]' AND verified_at IS NOT NULL ORDER BY verified_at ASC LIMIT ?",
		)
		.all(limit);

	let flagged = 0;
	for (const row of rows) {
		const memory = rowToMemory(row);
		if (memory.evidence.length === 0) continue;
		const refreshed: MemoryEvidence[] = [];
		let changed = false;
		for (const item of memory.evidence) {
			if (!item.repo || !item.path) {
				refreshed.push(item);
				continue;
			}
			const abs = repoAbsolutePath(scope, item.repo, item.path);
			if (!abs) {
				refreshed.push({ ...item, stale: true });
				changed = true;
				continue;
			}
			const current = hashPath(abs);
			if (item.hash && current && item.hash !== current) {
				refreshed.push({ ...item, stale: true });
				changed = true;
			} else {
				refreshed.push({ ...item, hash: current ?? item.hash });
			}
		}
		if (!changed) continue;
		flagged += 1;
		incrementMeta(db, "verification_failures");
		const updatedEvidence = JSON.stringify(refreshed);
		const updated = bumpRev(db, memory.id, {
			status: "review",
			evidenceJson: updatedEvidence,
			updatedAt: nowIso(),
		});
		recordRevision(db, memory.id, "stale", updated);
	}

	return { expired: Number(expired.changes), checked: rows.length, flagged };
}

export function previewClear(db: MemoryDb, scope: ResolvedScope, target: ClearTarget): ClearPreview {
	const filter = clearFilter(scope, target);
	const memories = db.sqlite
		.prepare(`SELECT count(*) AS n FROM memories WHERE ${filter.sql}`)
		.get(...filter.params);
	const revisions = db.sqlite
		.prepare(
			`SELECT count(*) AS n FROM memory_revisions WHERE memory_id IN (SELECT id FROM memories WHERE ${filter.sql})`,
		)
		.get(...filter.params);
	const observations = target.kind === "all" ? countObservations(db) : 0;
	const byLayerRows = db.sqlite
		.prepare(`SELECT coalesce(repo_id, 'shared') AS layer, count(*) AS n FROM memories WHERE ${filter.sql} GROUP BY 1`)
		.all(...filter.params);
	const byLayer: Record<string, number> = {};
	for (const row of byLayerRows) byLayer[String(row.layer)] = Number(row.n);
	return {
		memories: memories ? Number(memories.n) : 0,
		revisions: revisions ? Number(revisions.n) : 0,
		observations,
		byLayer,
	};
}

/** Delete memories and their revisions. Shared data is untouched unless the target says otherwise. */
export function clearMemories(db: MemoryDb, scope: ResolvedScope, target: ClearTarget): ClearPreview {
	const filter = clearFilter(scope, target);
	const preview = previewClear(db, scope, target);
	withTransaction(db, () => {
		db.sqlite
			.prepare(
				`DELETE FROM memory_revisions WHERE memory_id IN (SELECT id FROM memories WHERE ${filter.sql})`,
			)
			.run(...filter.params);
		db.sqlite.prepare(`DELETE FROM memories WHERE ${filter.sql}`).run(...filter.params);
		if (target.kind === "all") {
			db.sqlite.prepare("DELETE FROM observations").run();
		}
	});
	return preview;
}

export function countMemories(db: MemoryDb, scope: ResolvedScope): {
	total: number;
	byLayer: Record<string, number>;
	byStatus: Record<string, number>;
} {
	const registered = scope.repos.map((repo) => repo.id);
	const scopeSql =
		registered.length === 0
			? "repo_id IS NULL"
			: `(repo_id IS NULL OR repo_id IN (${registered.map(() => "?").join(",")}))`;

	const layerRows = db.sqlite
		.prepare(
			`SELECT coalesce(repo_id, 'shared') AS layer, count(*) AS n FROM memories WHERE ${scopeSql} AND status IN ('active','candidate','review') GROUP BY 1`,
		)
		.all(...registered);
	const statusRows = db.sqlite
		.prepare(`SELECT status, count(*) AS n FROM memories WHERE ${scopeSql} GROUP BY 1`)
		.all(...registered);

	const byLayer: Record<string, number> = {};
	for (const row of layerRows) byLayer[String(row.layer)] = Number(row.n);
	const byStatus: Record<string, number> = {};
	for (const row of statusRows) byStatus[String(row.status)] = Number(row.n);
	let total = 0;
	for (const value of Object.values(byLayer)) total += value;
	return { total, byLayer, byStatus };
}

export function listRecentTitles(db: MemoryDb, scope: ResolvedScope, limit = 30): { id: string; title: string; repoId: string | null }[] {
	const registered = scope.repos.map((repo) => repo.id);
	const scopeSql =
		registered.length === 0
			? "repo_id IS NULL"
			: `(repo_id IS NULL OR repo_id IN (${registered.map(() => "?").join(",")}))`;
	const rows = db.sqlite
		.prepare(
			`SELECT id, title, repo_id FROM memories WHERE ${scopeSql} AND status IN ('active','candidate') ORDER BY updated_at DESC LIMIT ?`,
		)
		.all(...registered, limit);
	return rows.map((row) => ({
		id: String(row.id),
		title: String(row.title),
		repoId: row.repo_id === null ? null : String(row.repo_id),
	}));
}

export function pendingObservations(db: MemoryDb): number {
	const row = db.sqlite.prepare("SELECT count(*) AS n FROM observations WHERE processed = 0").get();
	return row ? Number(row.n) : 0;
}

export function countObservations(db: MemoryDb): number {
	const row = db.sqlite.prepare("SELECT count(*) AS n FROM observations").get();
	return row ? Number(row.n) : 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildFilter(scope: ResolvedScope, options: MemorySearchOptions): Filter {
	const repoIds = scope.repos.map((repo) => repo.id);
	const requestedRepo = options.repo?.trim();
	if (requestedRepo !== undefined && requestedRepo !== "") {
		if (!repoRef(scope, requestedRepo)) {
			throw new MemoryError(
				`未知仓库: ${requestedRepo}。可用仓库: ${repoIds.join(", ") || "(无)"}`,
			);
		}
		return { sql: "(m.repo_id IS NULL OR m.repo_id = ?)", params: [requestedRepo] };
	}

	const target = options.target ?? "current";
	if (target === "shared") return { sql: "m.repo_id IS NULL", params: [] };
	if (target === "all" || scope.repoId === undefined) {
		if (repoIds.length === 0) return { sql: "m.repo_id IS NULL", params: [] };
		return {
			sql: `(m.repo_id IS NULL OR m.repo_id IN (${repoIds.map(() => "?").join(",")}))`,
			params: repoIds,
		};
	}
	return { sql: "(m.repo_id IS NULL OR m.repo_id = ?)", params: [scope.repoId] };
}

function runFts(
	db: MemoryDb,
	filter: Filter,
	statuses: MemoryStatus[],
	query: string,
	limit: number,
	candidateLimit: number,
): Record<string, unknown>[] {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return [];
	const statusSql = `m.status IN (${statuses.map(() => "?").join(",")})`;
	const sql = `
		SELECT m.*, bm25(memory_fts) AS rank
		FROM memory_fts JOIN memories m ON m.rowid = memory_fts.rowid
		WHERE memory_fts MATCH ? AND ${filter.sql} AND ${statusSql}
		ORDER BY rank
		LIMIT ?`;
	try {
		return db.sqlite
			.prepare(sql)
			.all(ftsQuery, ...filter.params, ...statuses, Math.max(limit * 4, candidateLimit)) as Record<
			string,
			unknown
		>[];
	} catch {
		return [];
	}
}

function runSubstring(
	db: MemoryDb,
	filter: Filter,
	statuses: MemoryStatus[],
	query: string,
	candidateLimit: number,
): Record<string, unknown>[] {
	const statusSql = `m.status IN (${statuses.map(() => "?").join(",")})`;
	const like = `%${escapeLike(query)}%`;
	const sql = `
		SELECT m.*, NULL AS rank FROM memories m
		WHERE ${filter.sql} AND ${statusSql} AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
		ORDER BY m.updated_at DESC
		LIMIT ?`;
	try {
		return db.sqlite
			.prepare(sql)
			.all(...filter.params, ...statuses, like, like, candidateLimit) as Record<string, unknown>[];
	} catch {
		return [];
	}
}

function runRecent(
	db: MemoryDb,
	filter: Filter,
	statuses: MemoryStatus[],
	candidateLimit: number,
): Record<string, unknown>[] {
	const statusSql = `m.status IN (${statuses.map(() => "?").join(",")})`;
	const sql = `SELECT m.*, NULL AS rank FROM memories m WHERE ${filter.sql} AND ${statusSql} ORDER BY m.updated_at DESC LIMIT ?`;
	try {
		return db.sqlite
			.prepare(sql)
			.all(...filter.params, ...statuses, candidateLimit) as Record<string, unknown>[];
	} catch {
		return [];
	}
}

function scoreMemory(
	memory: MemoryRecord,
	queryTokens: Set<string>,
	normalizedQuery: string,
	matchedBy: MemorySearchHit["matchedBy"],
): { score: number; relevant: boolean } {
	const base = matchedBy === "fts" ? 1 : matchedBy === "substring" ? 0.55 : 0.1;
	const tokens = new Set(tokenize(`${memory.title}\n${memory.content}\n${memory.tags.join(" ")}`));
	const overlap = jaccard(queryTokens, tokens);
	const coverage = coverageOf(queryTokens, tokens);
	const haystack = normalizeText(`${memory.title}\n${memory.content}\n${memory.relatedPaths.join(" ")}`);
	const substringBonus = normalizedQuery.length >= 2 && haystack.includes(normalizedQuery) ? 0.9 : 0;
	const queryTokenList = [...queryTokens];
	const pathBonus = memory.relatedPaths.some((path) =>
		queryTokenList.some((token) => path.toLowerCase().includes(token)),
	)
		? 0.25
		: 0;
	const ageDays = Math.max(0, (Date.now() - Date.parse(memory.updatedAt)) / 86_400_000);
	const recency = Math.max(0, 1 - ageDays / 365) * 0.05;
	const relevant = matchedBy === "fts" || overlap > 0 || substringBonus > 0 || pathBonus > 0;
	const score =
		(base + overlap * 1.4 + coverage * 0.8 + substringBonus + pathBonus) *
			STATUS_WEIGHT[memory.status] *
			KIND_WEIGHT[memory.kind] +
		recency;
	return { score, relevant };
}

function buildFtsQuery(query: string): string {
	const terms = new Set<string>();
	const lower = query.toLowerCase();
	for (const match of lower.matchAll(/[a-z0-9][a-z0-9_.\-/]*[a-z0-9]|[a-z0-9]/g)) {
		const word = match[0];
		for (const part of word.split(/[._\-/]+/)) {
			if (part.length >= 2 && !STOP_WORDS.has(part)) terms.add(`"${part}"`);
		}
	}
	for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
		if (run.length >= 2) terms.add(`${run}*`);
	}
	return [...terms].slice(0, 12).join(" OR ");
}

function decideStatus(kind: MemoryKind, verifiedCount: number, source: MemorySource): MemoryStatus {
	if (kind === "fact") {
		return verifiedCount > 0 || source === "user" ? "active" : "candidate";
	}
	return "active";
}

function resolveLayer(
	scope: ResolvedScope,
	input: MemorySaveInput,
	content: string,
): { repoId: string | null; notes: string[] } {
	const notes: string[] = [];
	const known = scope.repos.map((repo) => repo.id);
	const explicitRepo = input.repo?.trim();
	if (explicitRepo !== undefined && explicitRepo !== "" && !repoRef(scope, explicitRepo)) {
		throw new MemoryError(`未知仓库: ${explicitRepo}。可用仓库: ${known.join(", ") || "(无)"}`);
	}

	if (input.layer === "shared") {
		return { repoId: null, notes };
	}
	if (input.layer === "repo") {
		const repoId = explicitRepo || scope.repoId;
		if (!repoId) throw new MemoryError("layer=repo 需要当前目录属于一个已注册仓库，或显式提供 repo");
		if (!repoRef(scope, repoId)) throw new MemoryError(`未知仓库: ${repoId}`);
		return { repoId, notes };
	}

	const text = `${input.title ?? ""} ${content}`;
	const mentioned = new Set(mentionedRepos(text, scope));
	if (explicitRepo) mentioned.add(explicitRepo);
	if (mentioned.size >= 2) {
		notes.push(`内容涉及多个仓库 (${[...mentioned].join(", ")})，存入 Shared 层`);
		return { repoId: null, notes };
	}
	if (explicitRepo) return { repoId: explicitRepo, notes };
	return { repoId: scope.repoId ?? null, notes };
}

function mentionedRepos(text: string, scope: ResolvedScope): string[] {
	const lower = text.toLowerCase();
	const found: string[] = [];
	for (const repo of scope.repos) {
		const candidates = new Set([repo.id.toLowerCase(), repo.rel.toLowerCase(), repo.abs.toLowerCase()]);
		for (const candidate of candidates) {
			if (candidate === "") continue;
			const boundary = new RegExp(`(^|[^a-z0-9._-])${escapeRegExp(candidate)}([^a-z0-9._-]|$)`, "i");
			if (boundary.test(lower)) {
				found.push(repo.id);
				break;
			}
		}
	}
	return found;
}

function validateEvidence(
	scope: ResolvedScope,
	layerRepoId: string | null,
	evidence: MemoryEvidence[],
): { items: MemoryEvidence[]; verifiedCount: number; notes: string[] } {
	const notes: string[] = [];
	const items: MemoryEvidence[] = [];
	let verifiedCount = 0;
	const now = nowIso();

	for (const raw of evidence.slice(0, MAX_EVIDENCE_ITEMS)) {
		const repo = raw.repo?.trim() || layerRepoId || undefined;
		const path = raw.path?.trim().replaceAll("\\", "/").replace(/^\.\//, "");
		if (!path) {
			if (raw.commit || raw.branch || raw.reason) {
				items.push({
					repo,
					commit: raw.commit,
					branch: raw.branch,
					reason: raw.reason,
					verified: false,
				});
			}
			continue;
		}
		if (isSensitivePath(path)) {
			notes.push(`已忽略敏感文件证据: ${path}`);
			continue;
		}
		if (!repo) {
			notes.push(`证据缺少仓库归属，已忽略: ${path}`);
			continue;
		}
		if (!repoRef(scope, repo)) {
			notes.push(`证据引用了未注册仓库 ${repo}，已忽略: ${path}`);
			continue;
		}
		const resolved = resolveEvidencePath(scope, repo, path);
		if (!resolved) {
			notes.push(`证据路径逃逸出仓库，已忽略: ${path}`);
			continue;
		}
		const verified = resolved.hash !== undefined;
		if (!verified) notes.push(`证据文件不存在: ${repo}/${path}`);
		if (verified) verifiedCount += 1;
		items.push({
			repo,
			path: resolved.rel,
			commit: raw.commit,
			branch: raw.branch,
			reason: raw.reason,
			verified,
			verifiedAt: now,
			hash: resolved.hash,
		});
	}

	return { items, verifiedCount, notes };
}

function insertMemory(
	db: MemoryDb,
	input: {
		repoId: string | null;
		kind: MemoryKind;
		title: string;
		content: string;
		status: MemoryStatus;
		source: MemorySource;
		dedupeKey: string;
		evidence: MemoryEvidence[];
		tags: string[];
		supersedes: string | null;
		expiresAt: string | null;
		verifiedAt: string | null;
	},
): MemoryRecord {
	const now = nowIso();
	const id = `mem_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
	const relatedPaths = pathsFromEvidence(input.evidence);
	db.sqlite
		.prepare(
			`INSERT INTO memories
			(id, repo_id, kind, title, content, status, source, dedupe_key, evidence_json, related_paths_json,
			 tags_json, supersedes, confidence, expires_at, verified_at, rev, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
		)
		.run(
			id,
			input.repoId,
			input.kind,
			input.title,
			input.content,
			input.status,
			input.source,
			input.dedupeKey,
			JSON.stringify(input.evidence),
			JSON.stringify(relatedPaths),
			JSON.stringify(input.tags),
			input.supersedes,
			input.expiresAt,
			input.verifiedAt,
			now,
			now,
		);
	const created = getMemory(db, id);
	if (!created) throw new MemoryError("写入记忆失败");
	return created;
}

function bumpRev(
	db: MemoryDb,
	id: string,
	changes: {
		status?: MemoryStatus;
		title?: string;
		content?: string;
		source?: MemorySource;
		evidenceJson?: string;
		relatedPathsJson?: string;
		tagsJson?: string;
		dedupeKey?: string;
		supersededBy?: string | null;
		supersedes?: string | null;
		expiresAt?: string | null;
		verifiedAt?: string | null;
		updatedAt?: string;
	},
): MemoryRecord {
	const current = getMemory(db, id);
	if (!current) throw new MemoryError(`记忆不存在: ${id}`);
	const assignments: string[] = [];
	const values: (string | number | null)[] = [];
	const push = (column: string, value: string | number | null) => {
		assignments.push(`${column} = ?`);
		values.push(value);
	};
	if (changes.status !== undefined) push("status", changes.status);
	if (changes.title !== undefined) push("title", changes.title);
	if (changes.content !== undefined) push("content", changes.content);
	if (changes.source !== undefined) push("source", changes.source);
	if (changes.evidenceJson !== undefined) push("evidence_json", changes.evidenceJson);
	if (changes.relatedPathsJson !== undefined) push("related_paths_json", changes.relatedPathsJson);
	if (changes.tagsJson !== undefined) push("tags_json", changes.tagsJson);
	if (changes.dedupeKey !== undefined) push("dedupe_key", changes.dedupeKey);
	if (changes.supersededBy !== undefined) push("superseded_by", changes.supersededBy);
	if (changes.supersedes !== undefined) push("supersedes", changes.supersedes);
	if (changes.expiresAt !== undefined) push("expires_at", changes.expiresAt);
	if (changes.verifiedAt !== undefined) push("verified_at", changes.verifiedAt);
	push("updated_at", changes.updatedAt ?? nowIso());
	assignments.push("rev = rev + 1");

	const result = db.sqlite
		.prepare(`UPDATE memories SET ${assignments.join(", ")} WHERE id = ? AND rev = ?`)
		.run(...values, id, current.rev);
	if (Number(result.changes) !== 1) {
		throw new MemoryError(`记忆 ${id} 已被其他进程修改，请重新检索后再保存`);
	}
	const updated = getMemory(db, id);
	if (!updated) throw new MemoryError(`记忆不存在: ${id}`);
	return updated;
}

function findActiveByDedupeKey(db: MemoryDb, dedupeKey: string, repoId: string | null): MemoryRecord | undefined {
	const row = db.sqlite
		.prepare(
			"SELECT * FROM memories WHERE dedupe_key = ? AND repo_id IS ? AND status IN ('active','candidate','review') LIMIT 1",
		)
		.get(dedupeKey, repoId);
	return row ? rowToMemory(row) : undefined;
}

function toRelated(memory: MemoryRecord | undefined): RelatedMemory | undefined {
	if (!memory) return undefined;
	return {
		id: memory.id,
		title: memory.title,
		kind: memory.kind,
		layer: layerOf(memory),
		repoId: memory.repoId,
		status: memory.status,
		similarity: 1,
		relation: "duplicate",
	};
}

function recordRevision(db: MemoryDb, memoryId: string, operation: string, memory: MemoryRecord): void {
	db.sqlite
		.prepare("INSERT INTO memory_revisions (memory_id, operation, snapshot_json, created_at) VALUES (?, ?, ?, ?)")
		.run(memoryId, operation, JSON.stringify(memory), nowIso());
}

function requireVisibleMemory(db: MemoryDb, scope: ResolvedScope, id: string): MemoryRecord {
	const memory = getMemory(db, id);
	if (!memory) throw new MemoryError(`记忆不存在: ${id}`);
	if (memory.repoId !== null && !repoRef(scope, memory.repoId)) {
		throw new MemoryError(`记忆 ${id} 属于其他 Scope 的仓库 ${memory.repoId}，拒绝访问`);
	}
	return memory;
}

function clearFilter(scope: ResolvedScope, target: ClearTarget): Filter {
	if (target.kind === "shared") return { sql: "repo_id IS NULL", params: [] };
	if (target.kind === "repo") {
		const repoId = target.repoId?.trim();
		if (!repoId) throw new MemoryError("clear --repo 需要仓库名");
		if (!repoRef(scope, repoId)) throw new MemoryError(`未知仓库: ${repoId}`);
		return { sql: "repo_id = ?", params: [repoId] };
	}
	const repoIds = scope.repos.map((repo) => repo.id);
	if (repoIds.length === 0) return { sql: "repo_id IS NULL", params: [] };
	return {
		sql: `(repo_id IS NULL OR repo_id IN (${repoIds.map(() => "?").join(",")}))`,
		params: repoIds,
	};
}

function rowToMemory(row: Record<string, unknown>): MemoryRecord {
	return {
		id: String(row.id),
		repoId: row.repo_id === null || row.repo_id === undefined ? null : String(row.repo_id),
		kind: String(row.kind) as MemoryKind,
		title: String(row.title),
		content: String(row.content),
		status: String(row.status) as MemoryStatus,
		source: String(row.source) as MemorySource,
		evidence: parseJsonArray<MemoryEvidence>(row.evidence_json),
		relatedPaths: parseJsonArray<string>(row.related_paths_json),
		tags: parseJsonArray<string>(row.tags_json),
		supersededBy: row.superseded_by === null || row.superseded_by === undefined ? null : String(row.superseded_by),
		supersedes: row.supersedes === null || row.supersedes === undefined ? null : String(row.supersedes),
		confidence: row.confidence === undefined ? 1 : Number(row.confidence),
		expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
		verifiedAt: row.verified_at === null || row.verified_at === undefined ? null : String(row.verified_at),
		rev: Number(row.rev ?? 1),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function pathsFromEvidence(evidence: MemoryEvidence[]): string[] {
	const paths: string[] = [];
	for (const item of evidence) {
		if (!item.path) continue;
		paths.push(item.repo ? `${item.repo}/${item.path}` : item.path);
	}
	return union([], paths);
}

function mergeEvidence(existing: MemoryEvidence[], incoming: MemoryEvidence[]): MemoryEvidence[] {
	const byKey = new Map<string, MemoryEvidence>();
	const keyOf = (item: MemoryEvidence) =>
		`${item.repo ?? ""}|${item.path ?? ""}|${item.commit ?? ""}|${item.branch ?? ""}`;
	for (const item of existing) byKey.set(keyOf(item), item);
	for (const item of incoming) byKey.set(keyOf(item), item);
	return [...byKey.values()].slice(-MAX_EVIDENCE_ITEMS);
}

function checkpointExpiry(kind: MemoryKind, now: string): string | null {
	if (kind !== "checkpoint") return null;
	return new Date(Date.parse(now) + CHECKPOINT_TTL_DAYS * 86_400_000).toISOString();
}

function buildDedupeKey(repoId: string | null, kind: MemoryKind, title: string): string {
	return createHash("sha256")
		.update([repoId ?? "shared", kind, normalizeText(title)].join("|"))
		.digest("hex")
		.slice(0, 32);
}

function deriveTitle(title: string | undefined, content: string): string {
	const source = (title ?? "").trim() || firstLine(content);
	const cleaned = source.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
	if (cleaned === "") return "未命名记忆";
	return cleaned.length > MAX_TITLE_CHARS ? `${cleaned.slice(0, MAX_TITLE_CHARS - 1)}…` : cleaned;
}

function firstLine(content: string): string {
	const line = content
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part !== "");
	if (!line) return "";
	const sentence = line.split(/(?<=[。！？.!?])\s*/)[0];
	return (sentence ?? line).slice(0, MAX_TITLE_CHARS);
}

function buildSnippet(content: string): string {
	const collapsed = content.replace(/\s+/g, " ").trim();
	return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}

function assertNoSecrets(text: string): void {
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			throw new MemoryError("内容疑似包含凭据或密钥，拒绝写入记忆。请移除敏感信息后重试。");
		}
	}
}

function isSensitivePath(path: string): boolean {
	const lower = path.toLowerCase();
	const base = lower.split("/").pop() ?? lower;
	return (
		base === ".env" ||
		base.startsWith(".env.") ||
		base.endsWith(".pem") ||
		base.endsWith(".key") ||
		base.endsWith(".p12") ||
		base.includes("id_rsa") ||
		base.includes("credentials") ||
		base.includes("secret")
	);
}

/**
 * Resolve evidence to a file inside its repository. Models sometimes prefix the
 * path with the repository id or the repository's scope-relative directory, which
 * repeats a segment that is not part of the repo path; taken literally it fails
 * verification and downgrades an otherwise correct memory to a candidate. A path
 * that exists as written always wins over the shortened variants.
 */
function resolveEvidencePath(
	scope: ResolvedScope,
	repoId: string,
	path: string,
): { rel: string; abs: string; hash?: string } | undefined {
	const repo = repoRef(scope, repoId);
	if (!repo) return undefined;
	const prefixes = new Set([repoId, repo.rel.replaceAll("\\", "/")]);
	const variants = [path];
	for (const prefix of prefixes) {
		if (prefix === "" || prefix === ".") continue;
		if (path.startsWith(`${prefix}/`)) variants.push(path.slice(prefix.length + 1));
	}
	let missing: { rel: string; abs: string } | undefined;
	for (const variant of new Set(variants)) {
		const abs = repoAbsolutePath(scope, repoId, variant);
		if (!abs) continue;
		const hash = hashPath(abs);
		if (hash !== undefined) return { rel: variant, abs, hash };
		missing ??= { rel: variant, abs };
	}
	return missing;
}

function hashPath(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const stat = statSync(path);
		if (!stat.isFile()) return undefined;
		if (stat.size > 2 * 1024 * 1024) return `size:${stat.size}:mtime:${Math.floor(stat.mtimeMs)}`;
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Tokens for scoring: ASCII words plus CJK bigrams, so Chinese queries and content overlap. */
export function tokenize(text: string): Set<string> {
	const tokens = new Set<string>();
	const lower = text.toLowerCase();
	for (const match of lower.matchAll(/[a-z0-9][a-z0-9_.\-/]*[a-z0-9]|[a-z0-9]/g)) {
		const word = match[0];
		if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.add(word);
		for (const part of word.split(/[._\-/]+/)) {
			if (part.length >= 2 && !STOP_WORDS.has(part)) tokens.add(part);
		}
	}
	for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
		if (run.length === 1) tokens.add(run);
		for (let index = 0; index < run.length - 1; index += 1) {
			tokens.add(run.slice(index, index + 2));
		}
		if (run.length <= 4) tokens.add(run);
	}
	return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection += 1;
	return intersection / (a.size + b.size - intersection);
}

function coverageOf(query: Set<string>, haystack: Set<string>): number {
	if (query.size === 0) return 0;
	let hits = 0;
	for (const token of query) if (haystack.has(token)) hits += 1;
	return hits / query.size;
}

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s]+/g, " ")
		.replace(/[，。；：、！？（）【】《》"'`~!@#$%^&*()+=\[\]{}|\\:;<>?,./-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeLike(input: string): string {
	return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function estimateTokens(text: string): number {
	const chars = [...text].length;
	return Math.max(1, Math.ceil(chars / 2.5));
}

function union(a: string[], b: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of [...a, ...b]) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function parseJsonArray<T>(value: unknown): T[] {
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function layerOf(memory: Pick<MemoryRecord, "repoId">): "shared" | "repo" {
	return memory.repoId === null ? "shared" : "repo";
}
