import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { MemoryConfig, ScopeConfig } from "./config.ts";

export interface RepoRef {
	id: string;
	rel: string;
	abs: string;
}

export interface ResolvedScope {
	scope: ScopeConfig;
	scopeId: string;
	/** Real path of the scope root. */
	root: string;
	/** Real path of the directory Pi was started in. */
	cwd: string;
	/** Startup directory as given by Pi (may differ from cwd through symlinks). */
	startupDir: string;
	/** Repository the session is working in. Undefined when started at the scope root. */
	repoId?: string;
	repos: RepoRef[];
}

export type ScopeResolution = { active: true; resolved: ResolvedScope } | { active: false; reason: string };

/**
 * Resolve which configured scope, if any, owns the given directory.
 *
 * Only the scope root and registered repository directories activate a scope.
 * A directory inside the root but outside every repository (for example
 * `docs/`) stays inactive unless it is listed in `allowedDirectories`.
 */
export function resolveScope(config: MemoryConfig, cwd: string): ScopeResolution {
	const startupDir = cwd;
	const realCwd = safeRealpath(cwd);
	if (!realCwd) return { active: false, reason: `目录不可用: ${cwd}` };

	const matches: { scope: ScopeConfig; root: string }[] = [];
	for (const scope of config.scopes) {
		const root = safeRealpath(scope.root);
		if (!root) continue;
		if (isInsideOrEqual(root, realCwd)) matches.push({ scope, root });
	}
	if (matches.length === 0) {
		return { active: false, reason: "当前目录不属于任何已配置的 Scope" };
	}

	// The most specific scope wins. An explicitly disabled nested scope never
	// falls back to an enclosing scope.
	matches.sort((a, b) => pathDepth(b.root) - pathDepth(a.root) || b.root.length - a.root.length);
	const winner = matches[0] as { scope: ScopeConfig; root: string };
	const root = winner.root;
	const scope = winner.scope;

	if (!scope.enabled) {
		return { active: false, reason: `Scope ${scope.id} 已禁用 (enabled: false)` };
	}

	const repos: RepoRef[] = [];
	for (const [id, rel] of Object.entries(scope.repos)) {
		const candidate = join(root, rel);
		const abs = safeRealpath(candidate);
		if (!abs) continue; // repository does not exist yet; nothing inside it can match
		if (!isInsideOrEqual(root, abs)) continue; // symlink escaping the scope
		repos.push({ id, rel, abs });
	}
	repos.sort((a, b) => pathDepth(b.abs) - pathDepth(a.abs) || b.abs.length - a.abs.length);

	const currentRepo = repos.find((repo) => isInsideOrEqual(repo.abs, realCwd));
	const resolved: ResolvedScope = {
		scope,
		scopeId: scope.id,
		root,
		cwd: realCwd,
		startupDir,
		repos,
	};
	if (currentRepo) resolved.repoId = currentRepo.id;

	if (realCwd === root) return { active: true, resolved };
	if (currentRepo) return { active: true, resolved };

	const allowed = (scope.allowedDirectories ?? []).some((rel) => {
		const abs = safeRealpath(join(root, rel));
		return abs !== undefined && isInsideOrEqual(root, abs) && isInsideOrEqual(abs, realCwd);
	});
	if (allowed) return { active: true, resolved };

	return {
		active: false,
		reason: `路径不在 Scope ${scope.id} 的已注册仓库或 allowedDirectories 中: ${realCwd}`,
	};
}

export interface ConflictReport {
	kind: "same-root" | "overlap" | "duplicate-id";
	scopeId: string;
	root: string;
}

/** Reject overlapping scopes instead of guessing which one the user meant. */
export function findScopeConflicts(config: MemoryConfig, root: string, id?: string): ConflictReport[] {
	const target = safeRealpath(root) ?? root;
	const conflicts: ConflictReport[] = [];
	for (const scope of config.scopes) {
		const existing = safeRealpath(scope.root) ?? scope.root;
		if (id !== undefined && scope.id === id && existing !== target) {
			conflicts.push({ kind: "duplicate-id", scopeId: scope.id, root: scope.root });
			continue;
		}
		if (existing === target) {
			conflicts.push({ kind: "same-root", scopeId: scope.id, root: scope.root });
			continue;
		}
		if (isInsideOrEqual(existing, target) || isInsideOrEqual(target, existing)) {
			conflicts.push({ kind: "overlap", scopeId: scope.id, root: scope.root });
		}
	}
	return conflicts;
}

export interface DetectedRepo {
	id: string;
	rel: string;
}

/** First-level child directories that are Git repositories. */
export function detectGitRepos(root: string): DetectedRepo[] {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: DetectedRepo[] = [];
	const used = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const absolute = join(root, entry.name);
		if (!existsSync(join(absolute, ".git"))) continue;
		const id = uniqueId(sanitizeId(entry.name), used);
		found.push({ id, rel: entry.name });
	}
	found.sort((a, b) => a.rel.localeCompare(b.rel));
	return found;
}

export function sanitizeId(input: string): string {
	const cleaned = input
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/[-_.]+$/, "");
	return cleaned === "" ? "scope" : cleaned;
}

export function uniqueId(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let counter = 2;
	while (used.has(`${base}-${counter}`)) counter += 1;
	const next = `${base}-${counter}`;
	used.add(next);
	return next;
}

export function isGitRepository(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

export function repoRef(scope: ResolvedScope, repoId: string | undefined): RepoRef | undefined {
	if (repoId === undefined) return undefined;
	return scope.repos.find((repo) => repo.id === repoId);
}

/** Absolute path for a path relative to a repository, or undefined when it escapes. */
export function repoAbsolutePath(scope: ResolvedScope, repoId: string, relPath: string): string | undefined {
	const repo = repoRef(scope, repoId);
	if (!repo) return undefined;
	const cleaned = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (cleaned === "" || isAbsolute(cleaned)) return undefined;
	const abs = join(repo.abs, cleaned);
	if (!isInsideOrEqual(repo.abs, abs)) return undefined;
	return abs;
}

/** Absolute path for a path relative to the scope root, or undefined when it escapes. */
export function scopeAbsolutePath(scope: ResolvedScope, relPath: string): string | undefined {
	const cleaned = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (cleaned === "" || isAbsolute(cleaned)) return undefined;
	const abs = join(scope.root, cleaned);
	if (!isInsideOrEqual(scope.root, abs)) return undefined;
	return abs;
}

export function isInsideOrEqual(parent: string, child: string): boolean {
	if (parent === child) return true;
	const rel = relative(parent, child);
	if (rel === "") return true;
	return !rel.startsWith("..") && !isAbsolute(rel);
}

export function safeRealpath(input: string): string | undefined {
	try {
		return realpathSync.native(input);
	} catch {
		return undefined;
	}
}

export function isDirectory(input: string): boolean {
	try {
		return statSync(input).isDirectory();
	} catch {
		return false;
	}
}

export function displayName(scope: ResolvedScope): string {
	const repo = repoRef(scope, scope.repoId);
	return repo ? `${scope.scopeId}/${repo.id}` : scope.scopeId;
}

export function scopeLabel(scope: ResolvedScope): string {
	return repoRef(scope, scope.repoId)?.id ?? basename(scope.root);
}

function pathDepth(input: string): number {
	return input.split("/").filter(Boolean).length;
}
