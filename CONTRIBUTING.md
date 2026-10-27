# Contributing

欢迎提交 issue 和 pull request。这个项目面向 Pi Coding Agent，改动优先保持“轻量、按需、可验证”的设计。

## 开发环境

- Node.js >= 22.18（测试使用 Node 原生 TypeScript 类型擦除）
- Pi 1.4.x（用于手工验证扩展加载）
- 依赖由 Pi 宿主提供：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`typebox`

```bash
npm install
npm run typecheck
npm test
```

如果 `npm install` 没有安装宿主 peer 依赖，可以把本机 Pi 安装目录中的对应包软链到 `node_modules/`，参考 README 的“开发与测试”一节。

## 手工验证

```bash
pi -e /absolute/path/to/pi-scope-memory
```

如果本机已经通过 `pi install` 安装了发布版，本地调试请加 `-ne` 只加载显式路径，否则同名工具会重复注册：

```bash
pi -ne -e /absolute/path/to/pi-scope-memory
```

在临时项目里执行 `/sm init`，然后 `/reload`，确认 `/sm stats` 正常、未配置目录不会加载工具。

## 必须保持的设计约束

- 未激活 Scope 的目录不注册工具、不读数据库、不调用学习模型。
- 不在每轮请求中注入记忆，不动态改写 System Prompt，不改 Pi 原生 Compaction。
- 写入前必须检索同层历史记忆，再决定更新、替代或跳过。
- `fact` 只有验证到真实代码证据才是 `active`；其余情况保存为 `candidate`。
- 所有 `repo`、路径和 `memoryId` 参数都限制在当前 Scope。
- 学习失败不能中断主 Agent，事件必须保留以便下次重试。
- 清理数据前必须备份。

## 测试要求

- 新功能或修复先写失败测试，再实现。
- 测试必须使用 `PI_SCOPE_MEMORY_CONFIG` 和 `PI_SCOPE_MEMORY_DATA_DIR` 指向临时目录，不能触碰真实的 `~/.config` 和 `~/.local/share`。
- 提交前运行 `npm run typecheck` 和 `npm test`。

## 提交

提交信息使用 `<type>(scope): <summary>`，summary 用中文动词开头，例如：

```text
feat(scope): 支持单仓库布局
fix(memory): 修正冲突判定阈值
```

PR 请说明：改了什么、为什么、如何验证、有哪些已知限制。
