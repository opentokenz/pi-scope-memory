import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type MemoryConfig, type ScopeConfig } from "../src/config.ts";

const created: string[] = [];

export function tempRoot(prefix = "psm-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const real = realpathSync.native(dir);
	created.push(real);
	return real;
}

export function cleanupTempDirs(): void {
	while (created.length > 0) {
		const dir = created.pop();
		if (!dir) continue;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	}
}

export function useIsolatedHome(root: string): { configPath: string; dataDir: string } {
	const configPath = join(root, "config", "config.json");
	const dataDir = join(root, "data");
	process.env.PI_SCOPE_MEMORY_CONFIG = configPath;
	process.env.PI_SCOPE_MEMORY_DATA_DIR = dataDir;
	return { configPath, dataDir };
}

export function makeRepos(root: string, names: string[]): void {
	for (const name of names) {
		mkdirSync(join(root, name, ".git"), { recursive: true });
	}
}

export function writeFile(dir: string, rel: string, content: string): string {
	const path = join(dir, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

export function scopeConfig(root: string, overrides: Partial<ScopeConfig> = {}): ScopeConfig {
	return {
		id: "enterprise",
		root,
		enabled: true,
		repos: {
			backend: "backend",
			frontend: "frontend",
			sdk: "shared-sdk",
		},
		exclude: ["**/.env*", "**/node_modules/**"],
		...overrides,
	};
}

export function makeConfig(scopes: ScopeConfig[]): MemoryConfig {
	return parseConfig({
		version: 1,
		scopes: scopes.map((scope) => ({ ...scope })),
		defaults: {
			learningMinEvents: 3,
			learningIntervalTurns: 2,
			learningTokenBudgetPerDay: 100_000,
			retrieval: { topK: 5, maxTokens: 1200, includeStale: false },
		},
	});
}

export function assistantMessage(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}
