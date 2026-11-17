# Agent Harness · 第一阶段

从最原始的服务端开始：**HTTP serve + 多轮对话 + 模型/工具循环**。第一家模型服务接 DeepSeek。

## 本阶段的拆分

| 小步              | 实现                                  | 验证                               |
| ----------------- | ------------------------------------- | ---------------------------------- |
| 1.1 HTTP 服务     | `GET /health`、`POST /chat`           | 服务启动、参数校验与 JSON 响应     |
| 1.2 DeepSeek 适配 | 非流式 Chat Completions，关闭思考模式 | 请求头、模型参数、消息协议         |
| 1.3 调用循环      | 模型 → 工具 → 回填结果 → 模型         | 当前时间工具，两次模型调用完成     |
| 1.4 多轮对话      | 内存保存历史，返回 `sessionId`        | 继续对话、会话串行、失败不污染历史 |

本阶段没有 UI、数据库、任务队列、集群、流式输出或长任务恢复。先验证最小链路，再独立增加后续能力。

## 启动 DeepSeek

需要 Node.js **22.18+**（本机为 24）。运行使用 Node 原生 TypeScript 支持，没有运行时第三方依赖；开发依赖仅用于类型检查。

```bash
cd /Users/cat/workspace/zhuangxiu/agent-harness
npm ci
cp .env.example .env
```

在本地 `.env` 填入密钥：

```dotenv
MODEL_MODE=deepseek
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
PORT=4318
```

```bash
npm start
```

默认只监听 `127.0.0.1:4318`。密钥缺失会直接提示，**不会自动降级到 Mock**。密钥不要提交进 Git，也不要发到聊天里。

2026-11-17 核对官方文档：默认模型采用 `deepseek-flash`，使用 `/chat/completions` 和 `thinking: {"type":"disabled"}`。模型名称可以通过环境变量调整；本阶段只实现非思考模式，不处理思考内容续传。

参考：[首次调用](https://api-docs.deepseek.com/)、[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)。

## 调用

健康检查：

```bash
curl http://127.0.0.1:4318/health
```

新建对话：

```bash
curl http://127.0.0.1:4318/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好，我叫小明"}'
```

继续对话，将返回的 `sessionId` 填入下一次请求：

```bash
curl http://127.0.0.1:4318/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"替换为返回的sessionId","message":"我叫什么？"}'
```

验证工具循环：

```bash
curl http://127.0.0.1:4318/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"请调用工具告诉我当前UTC时间"}'
```

响应结构：

```json
{
  "sessionId": "服务生成的UUID",
  "reply": "模型最终回答",
  "modelCalls": 2,
  "toolCalls": [{ "name": "get_current_time", "ok": true }]
}
```

模型是否选工具由实际响应决定；`modelCalls` 和 `toolCalls` 反映本轮真实执行次数。

## 代码边界

```text
src/index.ts       组装模型、工具和 HTTP 服务
src/server.ts      HTTP 参数与响应
src/chat.ts        会话历史；同一会话禁止并发修改
src/loop.ts        模型/工具循环；不包含 HTTP 或 DeepSeek 协议
src/model.ts       DeepSeek 请求与响应转换
src/tools.ts       当前只有一个示例工具 get_current_time
src/mock-model.ts  显式离线演示，仅用于验证协议和流程
src/types.ts       消息、模型、工具的共享契约
```

工具返回的是结构化成功/失败结果；参数错误会回填给模型，让模型尝试修正。一次用户请求最多调用模型 6 轮，单轮最多执行 4 个工具，避免无限循环。请求信号在 60 秒后中断，模型 fetch 会响应取消；以后增加异步工具时，也需要遵守传入的 AbortSignal。

会话只存在当前进程内存中，重启丢失。这里只做 sessionId 维度的历史分离，**尚无用户认证和资源归属鉴权，不是多用户生产隔离**。当前示例工具只读；失败轮不提交历史，不代表未来写工具的副作用可以回滚。

## 无密钥验证

```bash
MODEL_MODE=mock npm start
npm run check
npm test
```

Mock 回复会明确带 `[Mock]`。问“现在几点”会实际执行时间工具；问“上一条说了什么”可验证历史传递。

测试通过本地 HTTP 协议桩验证 DeepSeek 的认证头、消息与工具协议，不使用真实密钥、不产生外部模型费用。真实 DeepSeek 调用需配置密钥后验证，不能把协议桩通过表述为真实 API 已联通。
