# tools — 可复跑的验证脚本 / Reproducible verifications

这些脚本把「稿本」依赖的三层契约各自钉住：宿主半的 Remote 发现与行为、宿主会话引擎的折叠语义、Browser 半的注册与事务。升级 dsh 之后重跑一遍，就能知道上面的机制是否还成立。

These scripts pin the three contracts 稿本 relies on — Host Remote discovery and behaviour, the session engine's fold semantics, and the Browser half's registrations and transaction — so a dsh upgrade can be re-verified in one command.

```bash
bash tools/verify-all.sh          # 三个离线验证（不需要模型、不联网）
bash tools/verify-all.sh --e2e    # 再启一个一次性 profile，走真实 Typert Gateway
```

## 脚本一览

| 脚本 | 验证什么 | 需要什么 |
|---|---|---|
| `verify-host.mjs` | Typert Gateway 的 SRC 发现规则能否从活着的服务上 claim `revise-chan/plan` / `revise-chan/revise`（binding 形状、Remote marker、参数名反射），以及 `plan` / `revise` 在事件形状真实的会话上的行为与全部业务错误码 | 能解析 dsh 包（见下） |
| `verify-engine.mjs` | 用真实的 `@deepseek-ai/dsh-session`：`buildForkSeed` 切在提问处 → 分支折叠为 `[提问1, 回答1, 提问2]`；追加修订轮后折叠为 `[提问1, 回答1, 提问2, 修订稿]`；继承前缀逐事件与来源一致 | 能解析 dsh 包 |
| `verify-client.mjs` | Browser 半：`apply` 只注册五个槽位项；署名/铅笔/对话框/悬浮大纲在带状态与副作用的最小 React 运行时（`lib/mini-react.mjs`）里真实交互——按钮出现、面板展开列轮次、高亮当前轮、点未载入轮次先 `loadThrough` 再滚动、关闭、会话卸载后撤回；`saveRevision` 发出的 RPC 载荷、fork 参数、新标题规则、归档顺序、标题字节预算、业务失败的本地化文案 | 只需 Node（`lib/mini-react.mjs` 提供 React 运行时） |
| `verify-e2e.sh` | 端到端：在 `.tmp/` 里造一个只含 `dsh-base` 的一次性 `DSH_HOME`，把**工作副本**按绝对路径插进去启动，用 `ctx.typertGateway.invoke({ namespace: 'revise-chan', … , args: { request } })` 真调 `plan` / `revise`，并断言分支折叠与 `turnBoundary.lastTurn` | `dsh` 在 PATH 上；不需要模型与凭据 |

## 模块解析

`verify-host.mjs`、`verify-engine.mjs` 和 `verify-e2e.sh` 需要 dsh 自带的包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`）。脚本按以下顺序找它们：

1. `$DSH_MODULES_DIR`（显式指定，指向任意一个其 `node_modules` 里有这些包的目录）；
2. `dsh` 二进制（`command -v dsh` → 解析软链 → 从它所在目录向上走）；
3. `$DSH_PROFILE_DIR`。

三个都失败时会给出明确报错。因为解析放在 `tools/lib/dsh-modules.mjs` 里，脚本本身不含任何绝对路径；`verify-e2e.sh` 里出现的绝对路径是运行时算出来的，写进的是它自己的一次性 profile 配置（`.tmp/`，已 gitignore）。

## 这些脚本不验证什么

- 真实渲染与视觉：`verify-client.mjs` 的小型 React 运行时能跑状态与副作用、验证交互逻辑，但没有布局引擎——位置、配色、悬停观感只能在浏览器里人工确认。
- Web UI 的实时链路：`verify-e2e.sh` 启的是无 UI 的 profile，走的是真实的网关与账号无关的路径；浏览器 cookies/鉴权属于 dsh 自身行为，不在覆盖范围内。
- 真实模型：全部脚本都不发模型请求，也不读凭据。
