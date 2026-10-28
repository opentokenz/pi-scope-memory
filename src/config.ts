import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CONFIG_VERSION = 1;

export interface RetrievalConfig {
	topK: number;
	maxTokens: number;
	includeStale: boolean;
}

export interface CacheConfig {
	dynamicInjection: boolean;
	trackUsage: boolean;
}

export const LEARNING_THINKING_LEVELS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type LearningThinkingLevel = (typeof LEARNING_THINKING_LEVELS)[number];

export interface DefaultsConfig {
	enabled: boolean;
	autoLearn: boolean;
	learningModel: string;
	/** Reasoning effort for the learning model. "inherit" follows the session level. */
	learningThinkingLevel: LearningThinkingLevel;
	learningIntervalTurns: number;
	learningMinEvents: number;
	learningTokenBudgetPerDay: number;
	retrieval: RetrievalConfig;
	cache: CacheConfig;
}

export interface ScopeConfig {
	id: string;
	root: string;
	enabled: boolean;
	repos: Record<string, string>;
	exclude: string[];
	allowedDirectories?: string[];
}

export interface PromptConfig {
	/** Full replacement for the built-in learner system prompt (automatic passes). */
	learningSystem?: string;
	/** Full replacement for the built-in context learner prompt used by /sm learn. */
	manualLearningSystem?: string;
	/** Extra rules appended to the learner prompt in both modes. */
	learningGuidance?: string;
	/** Template for the /sm recall user message. */
	recall?: string;
}

export interface MemoryConfig {
	version: number;
	defaults: DefaultsConfig;
	prompts: PromptConfig;
	scopes: ScopeConfig[];
}

export const DEFAULT_DEFAULTS: DefaultsConfig = {
	enabled: false,
	autoLearn: true,
	learningModel: "current",
	learningThinkingLevel: "inherit",
	learningIntervalTurns: 8,
	learningMinEvents: 20,
	learningTokenBudgetPerDay: 20000,
	retrieval: {
		topK: 5,
		maxTokens: 1200,
		includeStale: false,
	},
	cache: {
		dynamicInjection: false,
		trackUsage: true,
	},
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ConfigError extends Error {}

/**
 * Location of the central configuration file.
 * `PI_SCOPE_MEMORY_CONFIG` overrides it, which keeps tests and alternative
 * profiles from touching the user's real configuration.
 */
export function configPath(): string {
	const override = process.env.PI_SCOPE_MEMORY_CONFIG;
	if (override && override.trim() !== "") {
		return resolve(expandHome(override.trim()));
	}
	const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(configHome, "pi-scope-memory", "config.json");
}

/** Root directory for databases and backups. */
export function dataDir(): string {
	const override = process.env.PI_SCOPE_MEMORY_DATA_DIR;
	if (override && override.trim() !== "") {
		return resolve(expandHome(override.trim()));
	}
	const sharedHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(sharedHome, "pi-scope-memory");
}

export function scopeDataDir(scopeId: string): string {
	assertId(scopeId, "scope id");
	return join(dataDir(), "scopes", scopeId);
}

export function databasePath(scopeId: string): string {
	return join(scopeDataDir(scopeId), "memory.sqlite");
}

export function backupPath(scopeId: string, stamp = timestampSlug()): string {
	return join(scopeDataDir(scopeId), "backups", `memory-${stamp}.sqlite`);
}

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return join(homedir(), input.slice(2));
	}
	return input;
}

export function emptyConfig(): MemoryConfig {
	return {
		version: CONFIG_VERSION,
		defaults: structuredClone(DEFAULT_DEFAULTS),
		prompts: {},
		scopes: [],
	};
}

export type LoadedConfig =
	| { status: "loaded"; path: string; dataDir: string; config: MemoryConfig }
	| { status: "missing"; path: string; dataDir: string }
	| { status: "invalid"; path: string; dataDir: string; error: string };

export function loadConfig(path = configPath()): LoadedConfig {
	const shared = dataDir();
	if (!existsSync(path)) {
		return { status: "missing", path, dataDir: shared };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { status: "invalid", path, dataDir: shared, error: `无法读取配置文件: ${errorMessage(error)}` };
	}
	try {
		const config = parseConfig(JSON.parse(raw));
		return { status: "loaded", path, dataDir: shared, config };
	} catch (error) {
		return { status: "invalid", path, dataDir: shared, error: errorMessage(error) };
	}
}

/** Parse and validate a decoded configuration object. Throws {@link ConfigError} on any inconsistency. */
export function parseConfig(value: unknown): MemoryConfig {
	if (!isRecord(value)) throw new ConfigError("配置必须是 JSON 对象");
	const version = value.version;
	if (version !== CONFIG_VERSION) {
		throw new ConfigError(`不支持的配置版本: ${String(version)} (需要 ${CONFIG_VERSION})`);
	}

	const defaults = parseDefaults(value.defaults);
	const prompts = parsePrompts(value.prompts);
	const scopesRaw = value.scopes === undefined ? [] : value.scopes;
	if (!Array.isArray(scopesRaw)) throw new ConfigError("scopes 必须是数组");

	const scopes: ScopeConfig[] = [];
	const seenIds = new Set<string>();
	const seenRoots = new Map<string, string>();
	const seenRepos = new Map<string, string>();

	for (const [index, entry] of scopesRaw.entries()) {
		const scope = parseScope(entry, index, defaults.enabled);
		if (seenIds.has(scope.id)) {
			throw new ConfigError(`scopes[${index}].id 重复: ${scope.id}`);
		}
		seenIds.add(scope.id);
		const rootKey = normalizePathKey(scope.root);
		const previous = seenRoots.get(rootKey);
		if (previous !== undefined) {
			throw new ConfigError(`scopes[${index}].root 与 scope ${previous} 重复: ${scope.root}`);
		}
		seenRoots.set(rootKey, scope.id);
		for (const [repoId, repoPath] of Object.entries(scope.repos)) {
			const key = `${normalizePathKey(scope.root)}::${normalizePathKey(join(scope.root, repoPath))}`;
			const previousRepo = seenRepos.get(key);
			if (previousRepo !== undefined) {
				throw new ConfigError(`仓库路径与 ${previousRepo} 重复: ${repoPath}`);
			}
			seenRepos.set(key, `${scope.id}/${repoId}`);
		}
		scopes.push(scope);
	}

	return { version: CONFIG_VERSION, defaults, prompts, scopes };
}

function parseDefaults(value: unknown): DefaultsConfig {
	if (value === undefined) return structuredClone(DEFAULT_DEFAULTS);
	if (!isRecord(value)) throw new ConfigError("defaults 必须是对象");
	const defaults = structuredClone(DEFAULT_DEFAULTS);

	defaults.enabled = readBoolean(value.enabled, "defaults.enabled", defaults.enabled);
	defaults.autoLearn = readBoolean(value.autoLearn, "defaults.autoLearn", defaults.autoLearn);
	defaults.learningModel = readModel(value.learningModel, defaults.learningModel);
	defaults.learningThinkingLevel = readThinkingLevel(
		value.learningThinkingLevel,
		"defaults.learningThinkingLevel",
		defaults.learningThinkingLevel,
	);
	defaults.learningIntervalTurns = readInteger(
		value.learningIntervalTurns,
		"defaults.learningIntervalTurns",
		defaults.learningIntervalTurns,
		1,
		500,
	);
	defaults.learningMinEvents = readInteger(
		value.learningMinEvents,
		"defaults.learningMinEvents",
		defaults.learningMinEvents,
		1,
		500,
	);
	defaults.learningTokenBudgetPerDay = readInteger(
		value.learningTokenBudgetPerDay,
		"defaults.learningTokenBudgetPerDay",
		defaults.learningTokenBudgetPerDay,
		0,
		10_000_000,
	);

	const retrieval = value.retrieval;
	if (retrieval !== undefined) {
		if (!isRecord(retrieval)) throw new ConfigError("defaults.retrieval 必须是对象");
		defaults.retrieval.topK = readInteger(retrieval.topK, "defaults.retrieval.topK", defaults.retrieval.topK, 1, 50);
		defaults.retrieval.maxTokens = readInteger(
			retrieval.maxTokens,
			"defaults.retrieval.maxTokens",
			defaults.retrieval.maxTokens,
			200,
			32_000,
		);
		defaults.retrieval.includeStale = readBoolean(
			retrieval.includeStale,
			"defaults.retrieval.includeStale",
			defaults.retrieval.includeStale,
		);
	}

	const cache = value.cache;
	if (cache !== undefined) {
		if (!isRecord(cache)) throw new ConfigError("defaults.cache 必须是对象");
		// Dynamic injection is a cache-hostile design. It stays readable in the
		// file but is never honoured, so a hand edit cannot silently break caching.
		readBoolean(cache.dynamicInjection, "defaults.cache.dynamicInjection", defaults.cache.dynamicInjection);
		defaults.cache.dynamicInjection = false;
		defaults.cache.trackUsage = readBoolean(cache.trackUsage, "defaults.cache.trackUsage", defaults.cache.trackUsage);
	}

	return defaults;
}

const MAX_PROMPT_CHARS = 20_000;

function parsePrompts(value: unknown): PromptConfig {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new ConfigError("prompts 必须是对象");
	const prompts: PromptConfig = {};
	for (const key of ["learningSystem", "manualLearningSystem", "learningGuidance", "recall"] as const) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "string") throw new ConfigError(`prompts.${key} 必须是字符串`);
		if (raw.length > MAX_PROMPT_CHARS) {
			throw new ConfigError(`prompts.${key} 超过 ${MAX_PROMPT_CHARS} 字符上限`);
		}
		// Preserve the author's formatting; empty strings simply mean "use the default".
		if (raw.trim() !== "") prompts[key] = raw;
	}
	return prompts;
}

function parseScope(value: unknown, index: number, defaultEnabled: boolean): ScopeConfig {
	if (!isRecord(value)) throw new ConfigError(`scopes[${index}] 必须是对象`);
	const label = `scopes[${index}]`;

	const id = value.id;
	if (typeof id !== "string" || !ID_PATTERN.test(id)) {
		throw new ConfigError(`${label}.id 必须是字母或数字开头的标识符 (允许 . _ -)`);
	}

	const rootRaw = value.root;
	if (typeof rootRaw !== "string" || rootRaw.trim() === "") {
		throw new ConfigError(`${label}.root 必须是非空字符串`);
	}
	const expandedRoot = expandHome(rootRaw.trim());
	if (!isAbsolute(expandedRoot)) {
		throw new ConfigError(`${label}.root 必须是绝对路径或 ~/ 开头: ${rootRaw}`);
	}
	const root = resolve(expandedRoot);

	const enabled = readBoolean(value.enabled, `${label}.enabled`, defaultEnabled);

	const reposRaw = value.repos === undefined ? {} : value.repos;
	if (!isRecord(reposRaw)) throw new ConfigError(`${label}.repos 必须是对象`);
	const repos: Record<string, string> = {};
	const repoPaths = new Set<string>();
	for (const [repoId, repoValue] of Object.entries(reposRaw)) {
		if (!ID_PATTERN.test(repoId)) {
			throw new ConfigError(`${label}.repos 的仓库 ID 非法: ${repoId}`);
		}
		if (typeof repoValue !== "string" || repoValue.trim() === "") {
			throw new ConfigError(`${label}.repos.${repoId} 必须是非空相对路径`);
		}
		const rel = normalizeRelative(repoValue, `${label}.repos.${repoId}`);
		if (repoPaths.has(rel)) {
			throw new ConfigError(`${label}.repos.${repoId} 与其他仓库指向同一路径: ${rel}`);
		}
		repoPaths.add(rel);
		repos[repoId] = rel;
	}

	const exclude = readStringArray(value.exclude, `${label}.exclude`) ?? [
		"**/.env*",
		"**/node_modules/**",
		"**/dist/**",
		"**/.git/**",
	];
	const allowedDirectories = readStringArray(value.allowedDirectories, `${label}.allowedDirectories`);
	if (allowedDirectories) {
		for (const dir of allowedDirectories) normalizeRelative(dir, `${label}.allowedDirectories`);
	}

	const scope: ScopeConfig = { id, root, enabled, repos: orderRecord(repos), exclude };
	if (allowedDirectories && allowedDirectories.length > 0) {
		scope.allowedDirectories = allowedDirectories.map((dir) => normalizeRelative(dir, `${label}.allowedDirectories`));
	}
	return scope;
}

/** Relative path that must stay inside its parent directory. */
export function normalizeRelative(value: string, label: string): string {
	const cleaned = value.trim().replaceAll("\\", "/");
	if (cleaned === "" || isAbsolute(cleaned)) {
		throw new ConfigError(`${label} 必须是相对路径: ${value}`);
	}
	const normalized = cleaned.replace(/^\.\//, "").replace(/\/+$/, "");
	if (normalized === "") {
		throw new ConfigError(`${label} 不能为空: ${value}`);
	}
	// "." registers the scope root itself as a repository, which supports
	// single-repository scopes without a separate directory layout.
	if (normalized === ".") return ".";
	const rel = relative("/scope", resolve("/scope", normalized));
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new ConfigError(`${label} 不能逃逸出父目录: ${value}`);
	}
	return normalized;
}

export function writeConfig(config: MemoryConfig, path = configPath()): void {
	const validated = parseConfig(config);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
}

export function assertId(value: string, label: string): void {
	if (!ID_PATTERN.test(value)) {
		throw new ConfigError(`${label} 非法: ${value}`);
	}
}

export function isId(value: string): boolean {
	return ID_PATTERN.test(value);
}

/** Learning model is either the current session model or `provider/model-id`. */
export function parseModelReference(value: string): { provider: string; modelId: string } | undefined {
	const trimmed = value.trim();
	if (trimmed === "current") return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) {
		throw new ConfigError(`模型引用必须是 current 或 provider/model-id: ${value}`);
	}
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/** Normalize a path for equality comparisons (does not touch the filesystem). */
export function normalizePathKey(input: string): string {
	const resolved = resolve(expandHome(input));
	return process.platform === "darwin" ? resolved : resolved.toLowerCase();
}

export function timestampSlug(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function readBoolean(value: unknown, label: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new ConfigError(`${label} 必须是布尔值`);
	return value;
}

function readInteger(value: unknown, label: string, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value)) throw new ConfigError(`${label} 必须是整数`);
	if (value < min || value > max) throw new ConfigError(`${label} 必须在 ${min} 到 ${max} 之间`);
	return value;
}

function readModel(value: unknown, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.trim() === "") throw new ConfigError("defaults.learningModel 必须是非空字符串");
	const trimmed = value.trim();
	parseModelReference(trimmed);
	return trimmed;
}

function readThinkingLevel(
	value: unknown,
	label: string,
	fallback: LearningThinkingLevel,
): LearningThinkingLevel {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !LEARNING_THINKING_LEVELS.includes(value as LearningThinkingLevel)) {
		throw new ConfigError(`${label} 必须是 ${LEARNING_THINKING_LEVELS.join(" | ")} 之一`);
	}
	return value as LearningThinkingLevel;
}

function readStringArray(value: unknown, label: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new ConfigError(`${label} 必须是字符串数组`);
	}
	return value.map((item) => item.trim()).filter((item) => item !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orderRecord(input: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(input).sort()) out[key] = input[key] as string;
	return out;
}
