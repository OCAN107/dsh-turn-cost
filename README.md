# dsh-turn-cost 🐟

给 [DeepSeek Harness](https://github.com/deepseek-ai) 聊天界面加一个小小的价格徽章：**每一轮对话的时间戳旁边，显示这一轮到底花了多少钱**，格式是一个数字加一条鱼，比如 `0.13🐟`（鼠标悬停可见精确到 0.0001 元的人民币金额）。

## 它长什么样

```
完成了一轮回复           0.13🐟   11月14日 22:08
```

- 数字是**这一轮**（一个 turn，含该轮全部工具调用与多次模型请求）的合计费用，不是整个会话。
- 历史会话也会显示：插件启动时会回填 `session.v4.jsonl.zstd` 里已有的 usage 记录。
- 空数据时用字符区分状态：`…🐟` 加载中、`··🐟` 查不到该轮、`!!🐟` 请求失败、`?🐟` 拿不到会话。

## 安装

插件是标准的 DSH 插件，需要装进某个 profile（例如 `desktop`）。

1. 把整个仓库放到 `~/.dsh/plugins/dsh-turn-cost`（或任意位置）。

2. 在 profile 的 `package.json` 里加依赖，并把它排进 `bundles`：

```jsonc
{
  "dependencies": {
    "dsh-turn-cost": "link:C:/Users/you/.dsh/plugins/dsh-turn-cost"
  },
  "dsh": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-turn-cost"
    ]
  }
}
```

3. 在 profile 的 `node_modules` 下建一个指向插件目录的 junction（Windows）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-turn-cost" -Target "$env:USERPROFILE\.dsh\plugins\dsh-turn-cost"
```

4. **完全退出** DeepSeek Harness（任务管理器里结束所有 `DeepSeek Harness` 进程，只关窗口不算）后重新启动。

## 配置单价

价格表在 `lib/index.js` 顶部，单位是**元 / 百万 token**：

```js
const PRICES = {
  uncachedInput: 2.0, // 未命中缓存的输入
  cacheRead: 0.2,     // 命中缓存的输入
  cacheWrite: 2.0,    // 写入缓存
  output: 3.0,        // 输出
};
```

按你实际使用的模型改这四个数字即可，改完需要重启。

## 工作原理

**Host 侧**（`lib/index.js`）

- 订阅 `session/event`，只取 `type === 'assistant/message'`，从 `event.data.usage` 读四个 token 桶，按 `(sessionId, turn)` 累加到内存表。
- 启动时扫描 `~/.dsh/sessions` 下所有 `session.v4.jsonl.zstd`，用 zstd 魔数 `0x28b52ffd` 切多帧逐帧解压，把历史 usage 一并回填。
- 注册两个 POST 路由：`/api/dsh-turn-cost`（按 `{ messageIds }` 或 `{ sessionId }` 查价）与 `/api/dsh-turn-cost/report`（客户端自检上报）。

**Client 侧**（`lib/client.js`）

- 通过 `window.__ModuleLoader__.load` 注册浏览器模块，挂到 `conversation.chat.turnTail` 插槽，并用 `inject: (sessionId) => ({ sessionId })` 拿到会话键。
- 旧会话中 `closing === null` 的轮次不会渲染 `assistant-actions` 那一行图标，所以价格改挂在 `turnTail`（它在两种情况下都会渲染）；对于有图标行的轮次则让位给 `assistant-actions` 里的徽章，避免同一轮出现两个数字。

## 已知限制

- 同一个 turn 里如果有多条 assistant 消息（工具调用产生的中间消息），每条后面会显示同一个数字，因为它们是同一轮。
- 金额是按 token 数与固定单价算出的**估算值**，不含折扣、赠送额度、不同模型的实际差价。
- 只统计 `assistant/message` 的 usage，子代理（subagent）如果走独立 session，不会并入父轮。

## License

MIT
