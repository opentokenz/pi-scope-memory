# pi-scope-memory 开发约定

## 命令

- `npm test`：`node --test tests/*.test.ts`，TypeScript 由 Node 原生类型擦除执行，不需要编译。
- `npm run typecheck`：`tsc --noEmit`。
- 类型检查依赖 Pi 宿主包，本地通过 `node_modules/` 软链获得；不要把宿主包写进 `dependencies`。

## 不变量

- 未激活 Scope 的目录：不注册工具、不打开数据库、不调用学习模型、不产生告警。
- 记忆只在 `session_start` 固定工具集，运行中不增删工具、不改写 System Prompt、不做每轮注入。
- 写入路径必须先检索同层历史记忆，再决定更新、替代或跳过；所有变更写 `memory_revisions`。
- 任何 `repo`、路径、`memoryId` 参数都必须校验在当前 Scope 内，拒绝跨 Scope 访问。
- `fact` 只有验证到真实代码证据才是 `active`，否则是 `candidate`。
- 学习失败只记录错误并保留事件，绝不能中断主 Agent。
- 清理数据前必须用 `VACUUM INTO` 备份；测试不得触碰真实的 `~/.config` 与 `~/.local/share`。

## 测试

新增行为先写失败测试。测试通过 `PI_SCOPE_MEMORY_CONFIG` / `PI_SCOPE_MEMORY_DATA_DIR` 指向临时目录，并在结束时关闭数据库连接。
