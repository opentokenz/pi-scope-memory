# pi-scope-memory

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-339933.svg)](https://nodejs.org)
[![Pi](https://img.shields.io/badge/pi-1.4.x-6f42c1.svg)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)

面向 [Pi Coding Agent](https://pi.dev) 的轻量级、多仓库、长期项目记忆扩展。Scope 内的多个 Git 仓库共享一层跨仓库知识，各仓库保留自己的内部记忆；Agent 通过两个按需调用的工具检索和写入，不替换 Pi 原生 Compaction，也不在每轮请求里注入记忆。

> **English overview**
>
> pi-scope-memory gives the Pi coding agent durable, scope-aware project memory. A scope groups one or more Git repositories under a root directory. Cross-repository knowledge goes to a shared layer; repository-specific knowledge stays isolated. Two on-demand tools search and save memories, so nothing is injected into every turn and the prompt prefix stays stable. Every write first searches existing memories and updates, supersedes or skips them; implementation facts require verified file evidence. A background learner distils tool events with a configurable model and reasoning effort. Storage is one SQLite + FTS5 database per scope.

**状态**：`0.1.0`，早期版本。配置格式与工具参数可能在小版本内调整。

## 目录

- [为什么需要它](#为什么需要它)
- [核心特性](#核心特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [命令](#命令)
- [目录 Scope 模型](#目录-scope-模型)
- [Agent 工具](#agent-工具)
- [配置](#配置)
- [学习模型与思考强度](#学习模型与思考强度)
- [自动学习](#自动学习)
  - [手动提炼](#手动提炼)
- [记忆质量与生命周期](#记忆质量与生命周期)
- [检索与召回](#检索与召回)
- [Prompt Cache](#prompt-cache)
- [并发、安全与恢复](#并发安全与恢复)
- [数据存储](#数据存储)
- [开发与测试](#开发与测试)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [Roadmap](#roadmap)
- [License](#license)

## 为什么需要它

长周期重构里，Agent 每次新会话都会丢失上一次的结论：为什么放弃某个方案、哪些仓库必须一起升级、某个失败曾经如何修复。把所有历史都塞进上下文会推高成本并破坏 Prompt Cache；只靠 Pi 原生 Compaction 又无法跨 Session、跨仓库召回。

pi-scope-memory 把“工程记忆”从对话历史里拆出来：

- 平时只采集少量有价值的事件，不保存完整聊天和源码。
- 在任务结束时批量提炼，写入按 Scope 隔离的本地数据库。
- 新会话里由 Agent 按需检索，检索结果必须回到当前代码核对。
- 代码变化后，受影响的事实型记忆会被标记复核或被替代，不会永久停留在过时结论上。

## 核心特性

- **Scope 感知**：一个 Scope 管理多个仓库，Shared 层跨仓库共享，仓库层默认隔离。
- **默认关闭**：没有配置、未初始化或不在允许目录时，完全像没装扩展一样运行。
- **按需检索**：两个固定工具，不在每轮请求中注入记忆，不动态改写工具声明。
- **路径提示**：Agent 首次读取或编辑被记忆引用的文件时，在工具结果末尾追加一次标题级提示；每路径一次，每会话最多 3 次。
- **证据驱动**：实现事实需要真实文件证据；无证据的知识保存为未验证候选。
- **写入前检索**：新增记忆前先查同层历史，自动更新重复项、替代冲突项或跳过已有 Shared 结论。
- **自动学习**：轻量事件采集加批量 LLM 提炼，支持独立模型、思考强度、每日预算和失败重试。
- **手动提炼**：`/sm learn` 立即从当前会话提炼记忆，可附带一段提示指定重点，不必等事件阈值。
- **可控清理**：预览后删除，删除前生成一致性备份，只作用于当前 Scope。
- **本地优先**：SQLite + FTS5，一个 Scope 一个数据库，无后台服务、无向量数据库。

## 环境要求

- Pi `1.4.x`
- Node.js `>= 22.18`（使用内置 `node:sqlite`，需要 FTS5）
- 学习模型复用 Pi 已配置的 Provider；不需要额外 API Key

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/opentokenz/pi-scope-memory
```

从本地目录安装：

```bash
pi install /absolute/path/to/pi-scope-memory
```

临时试用，不修改设置：

```bash
pi -e /absolute/path/to/pi-scope-memory
```

如果已经通过 `pi install` 安装了发布版，本地调试时加 `-ne` 只加载显式路径，避免同名工具重复注册：

```bash
pi -ne -e /absolute/path/to/pi-scope-memory
```

安装扩展不等于启用记忆。只有执行过 `/sm init` 且目录匹配某个启用的 Scope，记忆工具才会在当前会话生效。

## 快速开始

```text
cd ~/Projects/enterprise
/sm init
/reload
```

`/sm init` 会：

1. 把当前目录登记为 Scope Root。
2. 扫描一级子目录中的 Git 仓库（或把根目录本身注册为单仓库）。
3. 检查配置中是否有重叠 Scope。
4. 写入 `~/.config/pi-scope-memory/config.json`。
5. 创建 `~/.local/share/pi-scope-memory/scopes/<scope-id>/memory.sqlite`。
6. 提示执行 `/reload`，让工具在当前会话生效。

之后正常开发即可。需要回忆历史时：

```text
/sm recall 认证模块以前为什么放弃 Session 模式？
```

想了解当前状态：

```text
/sm stats
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/sm init [--name <scope>] [--repos a,b,c]` | 初始化并启用当前目录 Scope |
| `/sm learn [提炼重点]` | 立即从当前会话上下文提炼记忆，参数只用于指定提炼重点 |
| `/sm recall [主题]` | 让 Agent 调用 `scope_memory_search` 检索历史记忆 |
| `/sm clear --repo <repo> \| --shared \| --all [--yes]` | 预览或清理记忆 |
| `/sm stats` | 记忆、检索、零命中率、review 比例、路径提示、学习与成本统计 |
| `/sm verify` | 重新核对 review 记忆的证据锚点，能恢复的恢复为 active |
| `/sm model` | 打开模型选择器，选完后继续选择思考强度 |

`/sm init` 不做交互菜单，但会校验真实路径、Scope ID 和仓库路径；发现重叠或冲突时直接报错，不会猜测要覆盖哪个 Scope。以后新增仓库必须显式执行 `/sm init --repos <name>`。

`/sm clear` 不带 `--yes` 时只显示将删除的数量。带 `--yes` 时先用 `VACUUM INTO` 生成一致性备份，再删除目标范围内的记忆、历史版本和 FTS 索引；`--all` 只作用于当前 Scope，并额外清理待处理事件。Scope 配置和 `usage_stats` 不会被清理。

证据文件变化时不再一律降为 `review`：保存时会把记忆里的特征词（标识符和四字中文短语）与证据文件实际内容比对，只记录确实出现过的锚点。文件改动后锚点仍在就更新哈希并保持 `active`，锚点消失或文件被删除才进入 `review`；文件恢复后下一次复核会自动回到 `active`。`/sm verify` 可以立即执行一次全量复核。

`/sm model` 在 TUI 和 RPC 模式下打开选择器，不需要输入模型 ID；非交互模式退化为文本列表。`/sm model --thinking` 单独选择思考强度，也支持显式写法：

```text
/sm model current
/sm model anthropic/claude-sonnet-4-5
/sm model --thinking high
/sm model anthropic/claude-sonnet-4-5 --thinking low
/sm model anthropic/claude-sonnet-4-5 high
/sm model current off
```

非交互模式可以直接用位置参数：`/sm model <model> <level>`。位置参数与 `--thinking` 等价；两者同时出现且值不一致会报错。

## 目录 Scope 模型

这是整个系统最重要的边界。

```text
~/Projects/enterprise/          # Scope root
├── backend/                    # Git Repo A → 仓库层 backend
├── frontend/                   # Git Repo B → 仓库层 frontend
├── shared-sdk/                 # Git Repo C → 仓库层 sdk
└── docs/                       # 默认不激活
```

| Pi 启动位置 | 激活结果 | 默认可检索 |
| --- | --- | --- |
| `enterprise/backend/` | 激活 | Shared + backend |
| `enterprise/frontend/` | 激活 | Shared + frontend |
| `enterprise/` | 激活（root 模式） | Shared + 全部已注册仓库 |
| `enterprise/docs/` | 不激活，除非列入 `allowedDirectories` | — |
| 其他目录 | 不激活 | — |

### 支持的仓库布局

- **Scope 根目录本身是 Git 仓库**：`/sm init` 把根目录以 `.` 注册为唯一仓库。从根目录或它的任意子目录启动都归属这个仓库，记忆范围为 Shared + 该仓库。
- **一级子目录是 Git 仓库**：每个子目录注册为独立仓库。从子仓库启动时读取 Shared + 该仓库；从 Scope 根目录启动时读取 Shared + 全部子仓库。
- **两者同时存在**：一级子仓库优先，根目录本身不再注册为仓库。这种布局下，不属于任何子仓库的目录（例如 `root/src/`）默认不激活；需要时请把 Scope 根目录上移一层。

### 激活规则

- 最具体的 Scope 匹配优先；显式 `enabled: false` 的子 Scope 不会回退到父 Scope。
- 目录经符号链接指向 Scope 外部时不激活。
- `repos` 只接受 Scope 内的相对路径；`exclude` 只影响事件采集，不参与激活判断。
- 新出现的仓库不会自动加入，必须显式 `/sm init --repos <name>`，或手工编辑配置。
- 写入归属由内容决定：`layer: "auto"` 时，正文提到两个及以上仓库会存入 Shared 层，否则存入当前仓库。

## Agent 工具

Agent 调用这两个工具时，TUI 或 RPC 客户端会收到一条临时通知：检索显示命中数量与 Scope，保存显示创建、更新、替代、失效或跳过。通知不会写入页脚状态，也不会修改其他扩展的 UI。

### `scope_memory_search`

```ts
{
  query: string;
  target?: "current" | "shared" | "all";
  repo?: string;
  includeHistorical?: boolean;
  limit?: number;
}
```

- `current`（默认）：Shared + 当前仓库。root 模式下等价于整个 Scope。
- `shared`：仅 Shared；`all`：整个 Scope；`repo`：指定仓库 + Shared。
- 默认不返回 `superseded` / `expired`；`includeHistorical: true` 全部返回。
- 返回正文摘要（最多 600 字）、状态和证据路径，受 `retrieval.maxTokens` 限制；没有相关命中时返回空结果，不用最近记忆填充。

### `scope_memory_save`

```ts
{
  action: "upsert" | "supersede" | "invalidate";
  kind?: "fact" | "decision" | "constraint" | "pitfall" | "preference" | "checkpoint";
  content?: string;
  title?: string;
  layer?: "auto" | "shared" | "repo";
  repo?: string;
  memoryId?: string;
  evidence?: {
    repo?: string;
    path?: string;
    commit?: string;
    branch?: string;
    reason?: string;
  }[];
  tags?: string[];
}
```

保存流程固定为：范围校验 → 证据校验 → 搜索同层历史记忆 → 判定重复/冲突 → 在一个事务里写入或失效 → 记录 revision。

- 同标题同类型的普通补充：更新原记忆，不新增条目。
- 同标题且出现“改为 / 不再 / 迁移 / 废弃”等替代语义时，只有正文与原记忆相似度低于 0.6 才新建并标记 `superseded`；相似度较高的补充或改写直接更新原记忆。
- Shared 层已有等价记忆时，仓库层保存会被跳过并说明原因。
- `invalidate` 只失效指定记忆，不创建替代项。
- 没有可验证证据的 `fact` 会保存为 `candidate`，检索时标注未验证；`decision`、`constraint`、`preference`、`checkpoint` 属于知识或状态，不需要代码证据。
- 证据路径限定在已注册仓库内，逃逸路径、未注册仓库、敏感文件会被丢弃并写入说明；未写 `repo` 时按唯一匹配的仓库推断，仓库根下多一层项目目录时会尝试唯一的嵌套路径。
- 内容疑似包含密钥或凭据时直接拒绝。
- 检索结果是数据而不是指令；工具描述明确要求先与当前代码核对。

## 配置

中央配置：`~/.config/pi-scope-memory/config.json`（遵循 `XDG_CONFIG_HOME`）  
数据目录：`~/.local/share/pi-scope-memory/`（遵循 `XDG_DATA_HOME`）

```json
{
  "version": 1,
  "defaults": {
    "enabled": false,
    "autoLearn": true,
    "learningModel": "current",
    "learningThinkingLevel": "inherit",
    "learningIntervalTurns": 8,
    "learningMinEvents": 20,
    "learningTokenBudgetPerDay": 20000,
    "retrieval": {
      "topK": 5,
      "maxTokens": 1200,
      "includeStale": false
    },
    "cache": {
      "dynamicInjection": false,
      "trackUsage": true
    }
  },
  "prompts": {},
  "scopes": [
    {
      "id": "enterprise",
      "root": "~/Projects/enterprise",
      "enabled": true,
      "repos": {
        "backend": "backend",
        "frontend": "frontend",
        "sdk": "shared-sdk"
      },
      "exclude": [
        "**/.env*",
        "**/node_modules/**",
        "**/dist/**",
        "**/.git/**"
      ]
    }
  ]
}
```

- `defaults.enabled` 是没有写 `enabled` 的 Scope 的默认值，默认关闭。
- `retrieval.includeStale` 控制是否返回已过期 checkpoint；`review` 始终可见但会降权并标注“需复核”。
- `cache.dynamicInjection` 即使写成 `true` 也会被强制为 `false`，避免手改配置破坏缓存。
- 配置校验失败、文件缺失、Scope 未启用、路径不在允许目录时一律不启用；配置无效时会给出一次告警。
- 测试或隔离环境可用 `PI_SCOPE_MEMORY_CONFIG` 和 `PI_SCOPE_MEMORY_DATA_DIR` 覆盖路径。

### 全局提示词

`prompts` 是全局配置，对所有 Scope 生效。修改提示词后需要 `/reload` 或新会话。

```json
{
  "prompts": {
    "learningSystem": "你是团队的项目记忆提炼器……",
    "manualLearningSystem": "你是团队的会话记忆提炼器……",
    "learningGuidance": "优先记录认证、支付相关的跨仓库约束。",
    "recall": "请先调用 scope_memory_search 检索 {scope}/{repo} 的历史记忆。\n可用仓库: {repos}\n检索主题: {topic}"
  }
}
```

- `learningSystem`：完整替换自动学习的系统提示词（基于工具事件提炼）。插件仍会在末尾追加 JSON 输出格式要求，保证学习结果可解析。
- `manualLearningSystem`：完整替换 `/sm learn` 的系统提示词（基于当前会话记录提炼）。不设置时使用内置的会话提炼提示词，不会继承 `learningSystem`。插件同样会追加 JSON 输出格式要求。
- `learningGuidance`：追加到两条学习路径的额外要求，适合放两端共用的团队规则，不必复制整段系统提示词。
- `recall`：`/sm recall` 发送的用户消息模板。支持 `{scope}`、`{repo}`、`{repos}`、`{topic}` 四个占位符。模板中应保留对 `scope_memory_search` 的明确要求，否则 Agent 可能不会调用工具。模板缺少 `{topic}` 但用户输入了主题时，插件会在消息末尾追加「检索主题: …」；未提供主题时，`{topic}` 会替换为默认的推断语句。
- 空字符串表示使用内置默认值。提示词只影响学习与召回文本，不会改变工具声明或系统提示词的固定前缀。

## 学习模型与思考强度

- 默认 `learningModel: "current"`，跟随当前会话模型。
- `/sm model` 打开选择器，只列出已配置凭据的模型；选择结果写入 `defaults.learningModel`。
- 固定模型写成 `provider/model-id`，例如 `anthropic/claude-sonnet-4-5`。模型不存在会直接报错；未配置凭据会提示，但保留设置。
- 思考强度：`inherit`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。默认 `inherit` 跟随当前会话，`off` 不发送 `reasoning`。
- 学习调用走 `ctx.modelRegistry.streamSimple(..., { reasoning })`，复用 Pi 已配置的 Provider，不硬编码 Anthropic。
- 模型未声明 `reasoning` 时 `/sm model` 会提示强度可能被 Provider 忽略。

通过 `/sm model` 修改的模型和思考强度会立即作用于当前会话，下一次学习批次就使用新值。手工编辑 `config.json` 后需要 `/reload` 或新会话才会生效。

主 Agent 的思考强度仍由 Pi 内置的 `/thinking` 控制；这里设置的是后台学习调用的强度。

## 自动学习

Collector 只记录有价值的事件指针，不保存原始输出和源码：

| 事件 | 记录内容 |
| --- | --- |
| `edit` / `write` | 文件路径与成功/失败 |
| `bash` 测试、构建、类型检查 | 命令摘要与结果 |
| 工具失败 | 工具名、目标路径、截断后的错误摘要 |
| `read` / `grep` / `find` / `ls` | 不记录 |
| 普通聊天 | 不记录 |

待处理窗口内重复的同类事件会合并，避免同一个失败反复生成候选。

触发条件：`autoLearn` 开启，且待处理事件达到 `learningMinEvents`，或轮次达到 `learningIntervalTurns` 且至少有一个事件。批次上限 40 条事件、5 条候选，在 `agent_settled` 且 Agent 空闲时执行。

- 每日 Token 预算耗尽时暂停提炼，事件保留，检索不受影响。
- Provider 不可用、输出不是合法 JSON 时保留事件；JSON 失败最多重试 3 次。
- 学习产生的用量单独记入 `usage_stats(source='learning')`，不与主 Agent 用量混算。
- 候选记忆仍然经过同一套去重、冲突与证据验证，不因为来自学习就跳过校验。
- 已处理事件保留 14 天后清理；`/sm clear --all` 可立即清理。

### 手动提炼

`/sm learn` 不等待 `learningMinEvents` 或 `learningIntervalTurns`，立即读取当前会话上下文并调用学习模型：

```text
/sm learn
/sm learn 只记录认证刷新相关的约束
```

- 事实来源是当前会话中的用户消息与助手结论，忽略工具输出、思考内容和扩展消息；命令后的文字只作为提炼重点，本身不作为事实。
- 与自动学习共用学习模型、思考强度、每日 Token 预算和候选保存流程，因此同样经过去重、冲突检测与证据验证。
- 系统提示词由 `prompts.manualLearningSystem` 控制；`prompts.learningSystem` 只作用于自动学习，两者不会互相覆盖。`learningGuidance` 对两条路径都生效。
- 不消费 `observations` 中的待处理事件，也不重置自动学习的计数；两条路径可以独立运行。
- 单次最多带入约 12000 字上下文，优先保留最近对话和会话压缩摘要；更早的对话会被省略并在提示词中标注条数。
- 提炼失败只记录错误并通知，不会中断主 Agent；成功或失败都会在界面提示结果。

## 记忆质量与生命周期

六种类型：`fact`、`decision`、`constraint`、`pitfall`、`preference`、`checkpoint`。

状态：

| 状态 | 含义 |
| --- | --- |
| `active` | 已验证或无需代码证据，可正常检索 |
| `candidate` | 缺少可验证证据，检索时标注未验证 |
| `review` | 证据文件变化且锚点已消失，检索时降权并提示复核 |
| `superseded` | 已被新结论替代，仅历史检索可见 |
| `expired` | checkpoint 超过有效期，默认不返回 |

- 每次保存写入 `memory_revisions`，记录操作与完整快照。
- 每条证据保存路径哈希、特征词锚点与可选的 commit / branch；会话启动时（每小时最多一次）检查关联文件是否变化。文件改动但锚点仍在时保持 `active` 并更新哈希，锚点消失才进入 `review`。
- `checkpoint` 有 14 天有效期，过期自动变 `expired`。
- 文件恢复或重新保存并带有效证据后，记忆会恢复为 `active`；也可以用 `/sm verify` 立即复核。

## 检索与召回

检索管线是 SQLite FTS5 加路径与符号匹配，没有 Embedding 依赖：

1. 按 Scope 与仓库过滤。
2. FTS5 使用 trigram 分词，覆盖英文标识符和中文任意子串；两个字的短查询继续用 `LIKE` 兜底。
3. `LIKE` 子串与 JS 端 token 重合度补充排序信号，并过滤只有泛化二元词命中的结果。
4. 按状态、类型、路径命中和更新时间加权。
5. 按 `retrieval.maxTokens` 截断返回内容。

`/sm recall` 不会在命令内部强制检索，而是发送一条新的用户消息，要求 Agent 调用 `scope_memory_search`，并说明当前 Scope、可用仓库和核对要求。检索到的历史记忆始终被视为数据，不获得指令权限。

当 Agent 首次 `read` / `edit` / `write` 一个被记忆证据引用的文件时，工具结果末尾会追加一段标题级提示（记忆 id、层级、类型、状态和标题）。它每个路径每会话只出现一次，每会话最多 3 次，没有相关记忆时没有开销；提示不包含正文，也不改写 System Prompt，正文仍需用 `scope_memory_search` 获取。

## Prompt Cache

| 行为 | 设计 |
| --- | --- |
| 未激活目录 | 不注册工具、不读数据库、不调用模型 |
| 工具声明 | 随 Scope 在 `session_start` 固定，运行中不增删 |
| 记忆注入 | 工具按需返回；首次触及被引用文件时的一次性路径提示 |
| `/sm recall` | 发送新的用户消息，不改写 System Prompt |
| `/sm learn` | 独立模型调用，不改写会话上下文与 System Prompt |
| 原生 Compaction | 不修改 |
| `/sm stats` | 展示 cache read / write、未缓存输入与学习成本 |

`/sm stats` 的缓存读取率：

```text
Cache Read Ratio = cacheRead / (input + cacheRead + cacheWrite)
```

扩展保证的是“不主动制造高频前缀变化”，无法承诺缓存率不下降：缓存 TTL、模型切换、Session 恢复和 Provider 行为仍会影响结果。

## 并发、安全与恢复

- SQLite WAL、`busy_timeout=5000`、短事务，每个 Pi 进程独立连接。
- 更新带 `rev` 乐观锁，冲突时返回可重试错误，不覆盖其他进程的修改。
- 清理前用 `VACUUM INTO` 生成一致性备份，不在 WAL 活跃时复制单个数据库文件；schema 升级（例如 v1 到 v2 的 trigram 索引重建）前同样先备份。
- 工具和命令都校验当前 Scope；`repo` 参数不能访问其他 Scope 或未注册仓库。
- 默认不保存原始凭据、`.env`、私钥或完整终端输出；敏感内容直接拒绝写入。
- 数据库损坏或学习失败不会阻止主 Agent 继续工作；待处理事件持久化，下次启动可恢复。

更多细节见 [SECURITY.md](SECURITY.md)。

## 数据存储

```text
~/.config/pi-scope-memory/config.json          中央配置
~/.local/share/pi-scope-memory/
└── scopes/
    └── enterprise/
        ├── memory.sqlite                      记忆数据库
        └── backups/                           清理前备份
```

数据库表：

```text
memories            当前记忆（status / evidence / dedupe_key / rev / expires_at）
memory_revisions    变更历史与快照
observations        待提炼的事件队列（attempts 控制重试）
usage_stats         session / learning / retrieval 用量
meta                计数器与运行时状态
memory_fts          FTS5 trigram 索引，触发器与 memories 同步
```

Shared 与仓库层在同一个库里用 `repo_id` 区分，`NULL` 表示 Shared。

## 开发与测试

```bash
npm install
npm run typecheck
npm test
```

测试使用 Node 原生 TypeScript 类型擦除和 `node:test`，通过 `PI_SCOPE_MEMORY_CONFIG` / `PI_SCOPE_MEMORY_DATA_DIR` 指向临时目录，不会触碰真实用户数据。

覆盖范围：

- Scope 激活、嵌套、禁用回退、符号链接逃逸、配置校验。
- Shared/Repo 隔离、跨会话召回、中文与英文检索。
- 保存前检索、去重更新、冲突替代、显式失效。
- 证据验证、checkpoint 过期、文件变化复核。
- `/sm clear` 的隔离、备份与历史版本清理。
- 学习批次、预算、Provider 失败、非法 JSON 重试、思考强度传递。
- 手动提炼：会话记录与提示分离、空会话跳过、不消费待处理事件、用量计入学习成本。
- 多进程并发写入、Prompt Cache 结构约束（不注册每轮注入钩子）。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

```text
index.ts            Pi 事件接线、Scope 启动/关闭、用量采集
src/config.ts       配置读取、校验、原子写入、路径
src/scope.ts        目录匹配、仓库识别、Scope 冲突
src/db.ts           SQLite/FTS5、迁移、事务、备份
src/memory.ts       检索、去重、冲突替代、证据验证、过期
src/learning.ts     事件采集、批量提炼、模型调用、降级
src/tools.ts        两个 Agent 工具与工具激活
src/commands.ts     七个 /sm 子命令
src/stats.ts        记忆、Token、缓存与成本统计
tests/              单元与端到端集成测试
```

## 已知限制

- 检索是 FTS5 加启发式匹配，没有 Embedding；记忆量很大时 `LIKE` 兜底会变慢。
- 证据校验对 2MB 以内的文件计算 SHA-256；更大的文件使用大小与修改时间指纹。
- 只做文件/目录级证据，不解析符号级依赖图。
- Scope 激活时会把两个工具加入活动工具集，不识别 `--tools` 白名单的排除项；要关闭记忆应禁用 Scope。
- 根目录与一级子仓库同时存在时，子仓库优先，根仓库不会注册（见“支持的仓库布局”）。
- 记忆是本地单机数据，没有同步或团队共享机制。
- 尚未发布到 npm；`package.json` 保持 `private: true`，通过 Git 或本地路径安装。
- 学习质量取决于所选模型，错误候选需要人工或代码核对。

## Roadmap

- 同时注册根仓库与一级子仓库的混合布局。
- 更细的代码证据：符号级定位与测试范围记录。
- 可选的低成本 Embedding 后端，保持默认关闭。
- 更完整的 `/sm stats` 趋势与学习失败诊断。

## License

[MIT](LICENSE) © 2026 opentokenz
