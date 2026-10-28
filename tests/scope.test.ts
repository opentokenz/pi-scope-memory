import assert from "node:assert/strict";
import { after, test } from "node:test";
import { join } from "node:path";
import { mkdirSync, symlinkSync } from "node:fs";
import { isId, loadConfig, parseConfig, parseModelReference, writeConfig } from "../src/config.ts";
import { detectGitRepos, findScopeConflicts, resolveScope, sanitizeId } from "../src/scope.ts";
import { cleanupTempDirs, makeConfig, makeRepos, tempRoot, useIsolatedHome, writeFile, scopeConfig } from "./helpers.ts";

after(cleanupTempDirs);

test("目录不在任何 Scope 内时不激活", () => {
	const root = tempRoot();
	makeRepos(root, ["backend"]);
	const outside = tempRoot();
	const config = makeConfig([scopeConfig(root)]);
	const resolution = resolveScope(config, outside);
	assert.equal(resolution.active, false);
});

test("仓库目录激活 Shared + 当前仓库", () => {
	const root = tempRoot();
	makeRepos(root, ["backend", "frontend", "shared-sdk"]);
	const config = makeConfig([scopeConfig(root)]);
	const resolution = resolveScope(config, join(root, "backend"));
	assert.equal(resolution.active, true);
	if (!resolution.active) return;
	assert.equal(resolution.resolved.scopeId, "enterprise");
	assert.equal(resolution.resolved.repoId, "backend");
	assert.deepEqual(
		resolution.resolved.repos.map((repo) => repo.id).sort(),
		["backend", "frontend", "sdk"],
	);
});

test("Scope 根目录激活为 root 模式（无当前仓库）", () => {
	const root = tempRoot();
	makeRepos(root, ["backend", "frontend"]);
	const config = makeConfig([scopeConfig(root)]);
	const resolution = resolveScope(config, root);
	assert.equal(resolution.active, true);
	if (!resolution.active) return;
	assert.equal(resolution.resolved.repoId, undefined);
});

test("Scope 内未注册目录默认不激活，allowedDirectories 可以显式放行", () => {
	const root = tempRoot();
	makeRepos(root, ["backend"]);
	mkdirSync(join(root, "docs"), { recursive: true });
	const blocked = resolveScope(makeConfig([scopeConfig(root)]), join(root, "docs"));
	assert.equal(blocked.active, false);

	const allowed = resolveScope(
		makeConfig([scopeConfig(root, { allowedDirectories: ["docs"] })]),
		join(root, "docs"),
	);
	assert.equal(allowed.active, true);
});

test("enabled:false 的 Scope 不启用", () => {
	const root = tempRoot();
	makeRepos(root, ["backend"]);
	const config = makeConfig([scopeConfig(root, { enabled: false })]);
	const resolution = resolveScope(config, join(root, "backend"));
	assert.equal(resolution.active, false);
	if (!resolution.active) assert.match(resolution.reason, /已禁用/);
});

test("嵌套 Scope 取最具体目录，禁用子 Scope 不回退父 Scope", () => {
	const parent = tempRoot();
	makeRepos(parent, ["backend", "frontend"]);
	const nestedRoot = join(parent, "backend");
	makeRepos(nestedRoot, ["service-a"]);
	const config = parseConfig({
		version: 1,
		scopes: [
			{ id: "outer", root: parent, enabled: true, repos: { backend: "backend", frontend: "frontend" } },
			{ id: "inner", root: join(nestedRoot, "service-a"), enabled: false, repos: {} },
		],
	});
	const resolution = resolveScope(config, join(nestedRoot, "service-a"));
	assert.equal(resolution.active, false);
	if (!resolution.active) assert.match(resolution.reason, /inner/);
});

test("符号链接指向 Scope 外部时不激活", () => {
	const root = tempRoot();
	makeRepos(root, ["backend"]);
	const outside = tempRoot();
	writeFile(outside, "secret.txt", "outside");
	symlinkSync(outside, join(root, "escaped"));
	const resolution = resolveScope(makeConfig([scopeConfig(root)]), join(root, "escaped"));
	assert.equal(resolution.active, false);
});

test("一级子目录 Git 仓库检测与 ID 生成", () => {
	const root = tempRoot();
	makeRepos(root, ["backend", "frontend", "shared-sdk"]);
	mkdirSync(join(root, "docs"), { recursive: true });
	const repos = detectGitRepos(root);
	assert.deepEqual(
		repos.map((repo) => repo.rel),
		["backend", "frontend", "shared-sdk"],
	);
	assert.equal(repos[2]?.id, "shared-sdk");
	assert.equal(sanitizeId("  my service!! "), "my-service");
	assert.equal(isId("enterprise"), true);
	assert.equal(isId("../escape"), false);
});

test("重叠 Scope 被识别为冲突", () => {
	const root = tempRoot();
	makeRepos(root, ["backend"]);
	const config = makeConfig([scopeConfig(root)]);
	const same = findScopeConflicts(config, root, "enterprise");
	assert.equal(same.length, 1);
	assert.equal(same[0]?.kind, "same-root");

	const child = findScopeConflicts(config, join(root, "backend"), "inner");
	assert.equal(child.length, 1);
	assert.equal(child[0]?.kind, "overlap");

	const duplicateId = findScopeConflicts(config, tempRoot(), "enterprise");
	assert.ok(duplicateId.some((conflict) => conflict.kind === "duplicate-id"));
});

test("配置校验：非法仓库路径、重复 ID、错误版本都会失败", () => {
	assert.throws(
		() =>
			parseConfig({
				version: 1,
				scopes: [{ id: "a", root: "/tmp/x", enabled: true, repos: { r: "../escape" } }],
			}),
		/逃逸/,
	);
	assert.throws(
		() =>
			parseConfig({
				version: 1,
				scopes: [
					{ id: "a", root: "/tmp/a", enabled: true, repos: {} },
					{ id: "a", root: "/tmp/b", enabled: true, repos: {} },
				],
			}),
		/重复/,
	);
	assert.throws(() => parseConfig({ version: 2, scopes: [] }), /版本/);
	assert.throws(
		() => parseConfig({ version: 1, defaults: { learningThinkingLevel: "turbo" }, scopes: [] }),
		/learningThinkingLevel/,
	);
	const defaults = parseConfig({ version: 1, scopes: [] });
	assert.equal(defaults.defaults.learningThinkingLevel, "inherit");
	const explicit = parseConfig({ version: 1, defaults: { learningThinkingLevel: "low" }, scopes: [] });
	assert.equal(explicit.defaults.learningThinkingLevel, "low");
});

test("全局提示词配置：两条学习路径的提示词、补充要求与 recall 模板", () => {
	const config = parseConfig({
		version: 1,
		prompts: {
			learningSystem: "自定义提炼器规则",
			manualLearningSystem: "自定义会话提炼器规则",
			learningGuidance: "优先记录认证相关约束",
			recall: "请检索 {scope}/{repo}，主题: {topic}",
		},
		scopes: [],
	});
	assert.deepEqual(config.prompts, {
		learningSystem: "自定义提炼器规则",
		manualLearningSystem: "自定义会话提炼器规则",
		learningGuidance: "优先记录认证相关约束",
		recall: "请检索 {scope}/{repo}，主题: {topic}",
	});
	assert.deepEqual(parseConfig({ version: 1, scopes: [] }).prompts, {});
	assert.deepEqual(
		parseConfig({ version: 1, prompts: { recall: "   " }, scopes: [] }).prompts,
		{},
		"空字符串表示使用默认提示词",
	);
	assert.throws(() => parseConfig({ version: 1, prompts: "bad", scopes: [] }), /prompts 必须是对象/);
	assert.throws(
		() => parseConfig({ version: 1, prompts: { learningSystem: 42 }, scopes: [] }),
		/必须是字符串/,
	);
});

test("配置写入后可读，默认关闭且 dynamicInjection 永远为 false", () => {
	const root = tempRoot();
	const { configPath } = useIsolatedHome(root);
	const config = parseConfig({
		version: 1,
		defaults: { cache: { dynamicInjection: true, trackUsage: true } },
		scopes: [],
	});
	assert.equal(config.defaults.cache.dynamicInjection, false);
	assert.equal(config.defaults.enabled, false);
	writeConfig(config, configPath);
	const loaded = loadConfig(configPath);
	assert.equal(loaded.status, "loaded");
	if (loaded.status !== "loaded") return;
	assert.equal(loaded.config.version, 1);
	assert.deepEqual(loaded.config.scopes, []);
});

test("缺失配置返回 missing 而不是报错", () => {
	const root = tempRoot();
	const { configPath } = useIsolatedHome(root);
	const loaded = loadConfig(join(configPath, "does-not-exist.json"));
	assert.equal(loaded.status, "missing");
});

test("学习模型引用解析", () => {
	assert.equal(parseModelReference("current"), undefined);
	assert.deepEqual(parseModelReference("anthropic/claude-sonnet-4-5"), {
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	});
	assert.throws(() => parseModelReference("nonsense"), /provider\/model-id/);
});
