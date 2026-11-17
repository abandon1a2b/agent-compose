# Agent Harness · 渐进实现

从最原始的服务端开始：**HTTP serve + 多轮对话 + 模型/工具循环**。第一家模型服务接 DeepSeek。

## 第一阶段：serve 与对话循环

| 小步              | 实现                                  | 验证                               |
| ----------------- | ------------------------------------- | ---------------------------------- |
| 1.1 HTTP 服务     | `GET /health`、`POST /chat`           | 服务启动、参数校验与 JSON 响应     |
| 1.2 DeepSeek 适配 | 非流式 Chat Completions，关闭思考模式 | 请求头、模型参数、消息协议         |
| 1.3 调用循环      | 模型 → 工具 → 回填结果 → 模型         | 当前时间工具，两次模型调用完成     |
| 1.4 多轮对话      | 内存保存历史，返回 `sessionId`        | 继续对话、会话串行、失败不污染历史 |

当前已有轻量聊天页面；尚无数据库、任务队列、集群、流式输出或长任务恢复。每一阶段独立增加能力，保持 HTTP、会话、循环和模型适配分离。

## 第二阶段：按窗口占比压缩上下文

| 小步           | 实现                                                            | 验证                               |
| -------------- | --------------------------------------------------------------- | ---------------------------------- |
| 2.1 输入预算   | 模型窗口扣除输出预留；计入系统消息、工具 Schema、历史和本次输入 | 相同消息在不同窗口下的触发比例     |
| 2.2 历史摘要   | 旧摘要与旧回合合并，完整保留最近回合                            | 姓名、编号、预算修正和工具链保留   |
| 2.3 回退与保护 | 失败/空摘要/变大则保留原文；取消继续传播                        | 失败回退、完整回合边界、超预算拒绝 |
| 2.4 对外入口   | 自动触发；`compress: true` 主动尝试；返回压缩指标               | 真实 DeepSeek 自动及重复压缩       |

预算公式：

```text
inputBudget = contextWindowTokens - reservedOutputTokens
occupancy = estimatedInputTokens / inputBudget
trigger = inputBudget × triggerRatio
target = inputBudget × targetRatio
```

默认设置：

```dotenv
MODEL_CONTEXT_WINDOW_TOKENS=1000000
MODEL_MAX_OUTPUT_TOKENS=2048
CONTEXT_COMPRESSION=true
CONTEXT_TRIGGER_RATIO=0.8
CONTEXT_TARGET_RATIO=0.5
CONTEXT_KEEP_RECENT_TURNS=4
CONTEXT_SUMMARY_MAX_TOKENS=1024
```

预留输出与主对话请求的 `max_tokens` 保持一致。默认输入预算为 997952，估算占用达到 80% 时尝试压缩，目标降到 50% 以下。固定保留最近 4 个完整用户回合；如果它们加当前输入已经超过目标，仍保留原文，并返回 `targetReached: false`。超过输入预算时拒绝继续调用模型，不通过截断工具结果或丢弃当前输入硬凑容量。

**计数目前是估算，不是精确 tokenizer 结果，也不是绝对安全上界。** `src/token-budget.ts` 按 DeepSeek 文档给出的英文字符约 0.3 token、汉字约 0.6 token 估算，加上消息结构和 25% 余量；输出明确标记 `tokenCountMethod: "estimated"`。精确值应以对应模型 tokenizer 或 API usage 为准，不能把本地估算当成实测用量。窗口默认值依据官方当前 1M，以保守的 1000000 解释；切换模型时需同步配置窗口。

参考：[DeepSeek 模型窗口](https://api-docs.deepseek.com/quick_start/pricing/)、[Token 估算说明](https://api-docs.deepseek.com/quick_start/token_usage/)。

压缩仅发生在新一轮用户请求开始前，摘要调用不提供工具。旧内容作为数据输入摘要模型，摘要以 assistant 背景消息回填，不提升为 system 指令。完整原始消息仍保存在当前进程的 transcript 中，不发送给模型；此能力减少模型输入，不等于缩减进程内存。摘要与新回合在本轮回答成功后一起提交，失败不覆盖原上下文。

当前不实现分块压缩或执行中工具结果摘要。待归纳历史本身超过摘要模型窗口时明确报错；工具循环中新增结果若超过输入预算，会在下一次模型调用前停止。Mock 摘要只提取片段，用于流程演示，不代表真实语义摘要质量。

## 启动 DeepSeek

需要 Node.js **22.18+**（本机为 24）。运行使用 Node 原生 TypeScript 支持，没有运行时第三方依赖；开发依赖仅用于类型检查。

```bash
cd /Users/cat/workspace/zhuangxiu/agent-harness
npm ci
[ -f .env ] || cp .env.example .env
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

主动尝试压缩（不带 `compress` 时按占比自动判断）：

```bash
curl http://127.0.0.1:4318/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"替换为已有会话ID","message":"继续之前的话题","compress":true}'
```

`compress: true` 仍遵守全局开关和最近回合保留数量，历史不足时会跳过。响应新增 `compression`，包含状态、原因、压缩前后估算 tokens/占比、触发/目标阈值、被摘要回合数与 `targetReached`。`modelCalls` 包括摘要调用；`compression.modelCalls` 单独记录摘要调用次数（0 或 1）。

## 代码边界

```text
src/index.ts       组装模型、工具和 HTTP 服务
src/server.ts      HTTP 参数与响应
src/chat.ts        会话历史；同一会话禁止并发修改
src/compression.ts 压缩策略、回合切分、摘要与回退
src/token-budget.ts 输入 token 估算与默认模型窗口
src/loop.ts        模型/工具循环；不包含 HTTP 或 DeepSeek 协议
src/model.ts       DeepSeek 请求与响应转换
src/tools/index.ts 工具注册列表：时间、计算
src/tools/calculate.ts 四则运算及参数校验
src/tool-executor.ts   工具分发、JSON 参数解析、执行与结果回填
src/mock-model.ts  显式离线演示，仅用于验证协议和流程
src/types.ts       消息、模型、工具的共享契约
```

工具返回的是结构化成功/失败结果；参数错误会回填给模型，让模型尝试修正。主对话循环最多调用模型 6 轮，触发压缩时额外调用 1 次摘要模型；单轮最多执行 4 个工具。请求信号在 60 秒后中断，模型 fetch 会响应取消；以后增加异步工具时，也需要遵守传入的 AbortSignal。

会话只存在当前进程内存中，重启丢失。这里只做 sessionId 维度的历史分离，**尚无用户认证和资源归属鉴权，不是多用户生产隔离**。当前示例工具只读；失败轮不提交历史，不代表未来写工具的副作用可以回滚。

## 无密钥验证

```bash
MODEL_MODE=mock npm start
npm run check
npm test
```

Mock 回复会明确带 `[Mock]`。问“现在几点”会实际执行时间工具；问“上一条说了什么”可验证历史传递。

自动化测试通过本地 HTTP 协议桩验证 DeepSeek 的认证头、消息与工具协议，不使用真实密钥、不产生外部模型费用。真实 API 联调与协议桩测试分开记录。

## 实际联调记录 · 2026-11-17

使用本地 `.env` 中的密钥，经本服务的 `POST /chat` 调用真实 DeepSeek API，模型为 `deepseek-flash`，非流式、非思考模式。

| 场景                   | 结果                                             | 模型调用次数 | 本次请求耗时 |
| ---------------------- | ------------------------------------------------ | ------------ | ------------ |
| 普通对话：记住测试昵称 | HTTP 200，正确确认昵称                           | 1            | 815 ms       |
| 同会话第二轮：询问昵称 | HTTP 200，正确引用上一轮内容                     | 1            | 631 ms       |
| 调用当前时间工具       | HTTP 200，执行 `get_current_time` 后生成最终回答 | 2            | 1921 ms      |

以上耗时来自单次冒烟验证，不是性能基准。密钥仅保存在 Git 忽略的 `.env` 中，文件权限为 `0600`，未写入源码、测试或本文档。

### 第二阶段真实压缩验证

为用少量请求触发边界，测试实例配置窗口 6000、输出预留 256、触发 70%、目标 40%、保留 1 轮、摘要上限 256。这些是测试预算，不是 DeepSeek 模型的真实窗口。

- 自动压缩：估算输入从 4783 降到 794，占可用输入预算从 83.27% 降到 13.82%。
- 摘要后仍正确回答客户姓名林舟、项目编号 H-7291、修正后的预算 120000 元，以及保留现有地板的要求。
- 压缩后的时间工具调用正常完成，两次主模型调用闭环。
- 再次主动压缩：估算输入从 1096 降到 511，旧摘要与新增历史合并，编号和修正预算仍正确。

以上结果来自真实 DeepSeek API；token 数字是本地估算，未作为服务端精确 usage 或无损压缩保证。摘要属于有损归纳，以上只证明本次样例通过。

## 第三阶段：工具注册与调用

循环只负责驱动模型；`tool-executor.ts` 负责调用已注册工具，`tools/` 放具体实现。注册定义包括名称、描述、JSON Schema 和 execute 函数。Schema 会传给模型，实际执行仍由各工具校验参数；尚未引入通用 JSON Schema 校验器。

- `get_current_time`：返回当前 UTC 时间。
- `calculate`：add / subtract / multiply / divide，参数为 operation、a、b；拒绝未知参数、非有限数字、除零及溢出。使用 JS 双精度浮点数，不用于精确货币结算，不执行任意表达式或代码。
- `GET /tools`：查看实际注册工具的名称、描述、参数定义，不暴露 execute 函数。
- 未知工具或非法参数回填为 `{ok:false,error}`，模型可在下一轮修正；取消信号继续传播。
- 同一轮多个工具依次执行；后续模型调用可继续使用上一轮结果。新增工具仍需在注册列表显式登记。

```bash
curl http://127.0.0.1:4318/tools
curl http://127.0.0.1:4318/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"请分两步调用calculate：先算137乘29，再把结果加41，最后回复数值"}'
```

本阶段只提供只读示例工具；写业务工具的权限、幂等和审计需单独实现，不以通用工具分发代替这些业务约束。

## 第四阶段：直接调用本服务的页面

运行 `npm start`，打开 <http://127.0.0.1:4318/>。页面位于 `web/`，由本服务按固定白名单提供静态资源，无需构建或单独启动前端。

- 普通聊天与继续会话调用 `POST /chat`，自动携带返回的 sessionId。
- “工具与上下文”读取 `GET /tools`，展示最近请求的估算上下文占比。
- 回复下方可展开查看 modelCalls、toolCalls 和 compression。
- 勾选“下次发送时压缩上下文”会传递 `compress: true`，仍遵守服务端保留回合及压缩开关规则。
- 当前是非流式请求，等待时展示状态，不伪造逐字输出。停止按钮断开当前请求，服务端传播取消信号。
- 页面记录保存在当前浏览器标签页的 sessionStorage；刷新可以恢复显示。服务端会话仍是内存数据，重启后旧 sessionId 失效，需要新对话。
- 模型内容用 textContent 渲染，不执行模型生成的 HTML。密钥始终只由服务端读取。

## 第五阶段：任务预设、草稿和确认发布

新增独立 `src/tasks/` 模块，共享 TaskManager 状态机，页面入口为「发布案例」「发布文章」。选择入口表示开始准备任务；聊天中说“同意”或模型调用发布工具都不能代替页面确认。

当前字段是 **Mock 临时契约，未核对真实业务发布接口**：

| 任务     | 必填                                                                             | 选填  |
| -------- | -------------------------------------------------------------------------------- | ----- |
| 发布案例 | title、content、city（城市名称，不是城市ID）、area、images（HTTP/HTTPS URL数组） | style |
| 发布文章 | title、content                                                                   | 无    |

图片只保存 URL，不上传、下载或抓取图片。发布主体固定为服务端设置的 `mock-merchant-001` / 演示商家，模型和请求参数不能替换主体。

### 执行链路

1. 首轮 `POST /chat` 带 `preset: "publish_case"` 或 `"publish_article"`，同会话自动关联任务。
2. 模型通过 `get_task`、`update_draft` 收集信息；草稿、版本和状态存于任务模块，独立于被压缩的聊天上下文。
3. 字段齐全后进入 `awaiting_confirmation`。页面预览会重新读取服务端草稿，完整展示当前字段、主体、版本。
4. 用户改动预览内容后必须先保存；保存增加版本，旧确认版本失效。
5. 用户点击「确认模拟发布」，专用接口授权当前版本，再调用与发布工具共用的受控执行函数。
6. MockPublisher 返回 `mock:true` 和 `mock-*` 编号；页面明确显示“模拟发布成功”，不会发送到真实业务系统。

状态：collecting → awaiting_confirmation → approved → executing → succeeded / failed；准备阶段可 cancelled。执行中不能改稿或取消；已成功的任务不可修改，需要新建任务。

### 任务接口

- `GET /tasks/:id?sessionId=...`：读取任务。
- `POST /tasks/:id/draft`：`{sessionId, version, patch}`，校验版本后更新。
- `POST /tasks/:id/confirm`：`{sessionId, version}`，确认并模拟发布；旧版本返回409。
- `POST /tasks/:id/cancel`：`{sessionId}`，取消未执行任务。
- `GET /tools?sessionId=...`：查看该任务实际可用工具；普通聊天仍使用计算/时间工具。

同一版本重复或并发确认只产生一个模拟结果，幂等键为 `taskId:version:subjectId`。失败重试复用相同键；这仅验证本地 Mock 的语义，真实发布接口也必须支持幂等或结果查询，不能直接假定外部副作用 exactly-once。

任务、草稿和幂等记录当前均为进程内存，重启丢失。sessionId 暂作为本地访问凭据，接口校验归属，但不是正式用户认证。任务草稿工具写入后立即保留，即使随后模型回答失败也不会回滚草稿；预览始终以重新读取的服务端版本为准。接真实业务前仍需核对字段、接入主体权限和持久化。

### 本阶段验证

- 单元/接口测试覆盖未授权发布拦截、缺字段、错误字段、跨会话读取、旧版本确认、取消、执行中修改、并发确认、失败重试与同版本去重。
- 真实 DeepSeek 验证：案例先收集标题/正文，再补充城市/面积/图片URL，进入待确认；确认后仅返回模拟发布结果。文章使用同一链路形成可确认草稿。
