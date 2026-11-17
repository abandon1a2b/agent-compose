# Agent Harness · 渐进实现

从最原始的服务端开始：**HTTP serve + 多轮对话 + 模型/工具循环**。第一家模型服务接 DeepSeek。

## 第一阶段：serve 与对话循环

| 小步              | 实现                                  | 验证                               |
| ----------------- | ------------------------------------- | ---------------------------------- |
| 1.1 HTTP 服务     | `GET /health`、`POST /chat`           | 服务启动、参数校验与 JSON 响应     |
| 1.2 DeepSeek 适配 | 非流式 Chat Completions，关闭思考模式 | 请求头、模型参数、消息协议         |
| 1.3 调用循环      | 模型 → 工具 → 回填结果 → 模型         | 当前时间工具，两次模型调用完成     |
| 1.4 多轮对话      | 内存保存历史，返回 `sessionId`        | 继续对话、会话串行、失败不污染历史 |

当前已有轻量聊天页面；尚无数据库、任务队列、集群或长任务恢复。每一阶段独立增加能力，保持 HTTP、会话、循环和模型适配分离。

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
src/index.ts       核心库出口（无启动副作用）
examples/local-app.ts  验证应用组装与启动
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

运行 `npm start`，打开 <http://127.0.0.1:4318/>。页面位于 `examples/chat-ui/`，由本服务按固定白名单提供静态资源，无需构建或单独启动前端。

- 普通聊天与继续会话调用 `POST /chat`，自动携带返回的 sessionId。
- “工具与上下文”读取 `GET /tools`，展示最近请求的估算上下文占比。
- 回复下方可展开查看 modelCalls、toolCalls 和 compression。
- 勾选“下次发送时压缩上下文”会传递 `compress: true`，仍遵守服务端保留回合及压缩开关规则。
- 页面使用流式请求，逐步展示模型返回的文本；停止按钮断开当前请求，服务端传播取消信号。
- 页面记录保存在当前浏览器标签页的 sessionStorage；刷新可以恢复显示。服务端会话仍是内存数据，重启后旧 sessionId 失效，需要新对话。
- 模型内容用 textContent 渲染，不执行模型生成的 HTML。密钥始终只由服务端读取。

## 第五阶段：任务预设、草稿和确认发布

新增独立 `src/tasks/` 模块，共享 TaskManager 状态机，页面入口为「发布案例」「发布文章」。选择入口表示开始准备任务；聊天中说“同意”或模型调用发布工具都不能代替页面确认。

当前字段是 **Mock 临时契约，未核对真实业务发布接口**：

| 任务     | 必填                                                                             | 选填  |
| -------- | -------------------------------------------------------------------------------- | ----- |
| 发布案例 | title、content、city（城市名称，不是城市ID）、area、images（HTTP/HTTPS URL数组） | style |
| 发布文章 | title、content                                                                   | 无    |

第五阶段最初只保存图片 URL；第七阶段已增加真实图片上传和视觉输入（见下文）。发布主体固定为服务端设置的 `mock-merchant-001` / 演示商家，模型和请求参数不能替换主体。

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

## 第六阶段：流式事件和通用交互

`POST /chat` 增加 `stream: true`，返回 `application/x-ndjson`。不带该字段仍返回原 JSON。页面使用 fetch ReadableStream，服务端逐步转发 DeepSeek 的真实文本增量；不会先等整段回答完成后再打字。

事件协议：`step_start`（切换模型步骤，清空上一阶段临时文本）、`text_delta`、`tool_start`、`tool_end`、`done`（完整 ChatOutput）、`error`。摘要过程不输出为用户回答，工具参数分片在完整接收后才执行。只有完整成功的轮次提交会话；网络中断保留页面上明确标记的未完成输出，不当作成功回答。当前请求流不支持断点重放。

- `src/sse.ts`：供应商 SSE 增量解码，处理跨字节的 UTF-8 与事件边界。
- `src/model.ts`：DeepSeek 增量文本和工具调用参数拼接。
- `src/loop.ts` / `src/server.ts`：执行进度与 HTTP 事件输出。
- `examples/chat-ui/app.js`：通用聊天、流接收、调用记录。
- `examples/chat-ui/task-ui.js`：当时的通用字段表单，已在第七阶段删除。
- `src/tasks/presets.ts`：业务入口、字段标签/类型/必填项，以及按字段类型执行的公共校验。
- `src/tasks/index.ts`：通用任务状态和授权门槛，不为案例/文章分叉流程。

第六阶段曾使用字段配置渲染表单；该方案已在第七阶段撤销。页面仍从 `GET /presets` 获取入口，前端不再包含 publish_case/publish_article 或 title/area/images 等业务字段判断。同类任务新增字段可以复用 text、textarea、number、url-list 四种控件；新控件类型仍需扩展通用渲染器及对应校验。真实发布接口接入属于业务适配，不塞进页面。

保存/确认等表单操作直接调用服务端，不产生额外模型调用；自然语言提取字段、模型工具循环和摘要会消耗模型 tokens。流式传输本身不额外增加一轮模型请求。字段Schema是服务端定义，模型不能生成任意可执行页面代码。

## 第七阶段：图片输入 + 模型生成的交互协议

移除固定任务状态栏、专用草稿弹窗和字段表单。`examples/chat-ui/task-ui.js` 已删除。业务必填字段仍是服务端校验规则，但不再直接生成页面表单。

### 模型生成交互

`src/interactions.ts` 定义规则和 `render_interaction` 工具。模型决定何时展示交互、卡片类型、问题标题与候选选项。

```json
{ "kind": "question", "title": "你喜欢哪种风格？", "options": ["原木", "现代"] }
```

```json
{ "kind": "confirmation", "title": "是否确认发布这份内容？" }
```

`examples/chat-ui/interaction-ui.js` 仅渲染两种通用卡片。选项点击后作为用户消息发给模型；确认按钮调用 `POST /interactions/:id/confirm`，模型不能生成任意 URL、脚本、HTML 或动作。确认卡片正文绑定服务端实际草稿、主体和版本，避免模型描述与实际发布内容不一致。修改通过继续对话完成，之后由模型生成新卡片；旧卡片确认返回409。卡片出现本身不授予发布权限。

### 图片

- 通过「图片」按钮选择，或向输入框粘贴图片；支持 PNG、JPEG、WebP，每条消息最多4张，每张2MB。
- `POST /images` 上传原始图片二进制，返回随机附件ID；`GET /images/:id` 用于本地预览。
- `POST /chat` 的 `images` 是附件ID列表，允许图片加文字，也允许仅图片。
- 服务端解析为带 base64 `image_url` 的多模态内容，真实传给 DeepSeek Flash；不会把本机URL直接交给远端模型下载。
- 对话和确认卡片可以预览已上传图片。模型可将附件引用写入案例草稿，真实发布接口仍未接入。
- 图片暂存进程内存，累计64MB；重启丢失。附件随机ID是本地访问凭据，尚未接生产用户鉴权或对象存储。
- 图像token采用每张4096的保守预算占位，不是精确usage。压缩旧回合时只将图片引用及已有文字结论归纳进摘要，不将base64当文本；被压缩的旧图不会继续随每次模型请求重发，需要细节时请重新附图。

当前 DeepSeek Flash 支持图片输入，官方说明：https://api-docs.deepseek.com/guides/vision/

### 验证

真实 DeepSeek 已识别上传测试图片的红色，并通过工具生成补问卡片；文章内容经模型整理后生成确认卡片，只有确认接口才产生Mock结果。测试覆盖非法交互类型/任意动作拒绝、草稿快照绑定、跨会话及旧版本确认拒绝、图片类型/大小和多模态传递。

## 第八阶段：独立内容服务与集成边界

当前本地 `.env` 已配置 `CONTENT_SERVICE_URL=http://127.0.0.1:4320`。用户确认后会真实保存到本地内容服务，而非Mock；不会调用线上业务系统。

```text
agent-harness/src/                         核心：循环、模型、上下文、工具执行、任务/交互协议
agent-harness/integrations/content-service/ 可替换业务适配：案例/文章字段与HTTP发布
agent-harness/examples/chat-ui/            验证用聊天客户端，可移除
agent-harness/examples/local-app.ts        验证应用组合入口，npm start 使用此文件
content-service-demo/                      独立项目：业务API、提交/展示页面、磁盘数据
```

依赖方向：examples → integrations + src；integrations → 核心类型/接口；内容服务不导入 Harness，核心不导入内容服务或业务预设。两个服务仅通过HTTP交换业务数据，没有共享数据目录、数据库、前端资源或跨项目源码依赖。

启动独立内容服务：

```bash
cd /Users/cat/workspace/zhuangxiu/content-service-demo
npm start
```

打开 http://127.0.0.1:4320/，可直接提交案例/文章并查看列表、详情。

再启动验证应用：

```bash
cd /Users/cat/workspace/zhuangxiu/agent-harness
npm start
```

打开 http://127.0.0.1:4318/，选择发布入口、上传图片、对话补全参数、点击模型生成的确认卡片。成功后返回内容服务详情链接。设置 `SERVE_DEMO_UI=false` 可关闭验证聊天页，仅保留API；移除 `CONTENT_SERVICE_URL` 则保留Mock发布，单元测试不依赖外部服务。

适配器只接受本机HTTP地址。确认执行时，将 Harness 的内存图片复制到内容服务；内容服务按内容哈希持久保存图片，然后幂等提交案例/文章。因此已发布图片不依赖 Harness 继续运行。外部图片URL不自动抓取，验证时请直接上传图片。

发布请求使用 `taskId:version:subjectId` 作为 Idempotency-Key。内容服务将幂等键与规范化请求内容绑定：相同键相同内容返回原结果，不同内容返回409。内容服务服务端再次校验字段，不依赖模型或Harness校验。服务不可用时任务进入failed，可按原版本和原键重试。

这是本地验证系统：无认证、仅监听loopback；内容服务单进程JSON文件存储，不支持多实例并发写。Harness任务和会话仍在内存。后续接真实业务只替换 integration，内容服务及 examples 均不是核心资产。

## 第九阶段：模型生成的回复表单

交互协议增加 `form`，仍由模型调用 `render_interaction` 生成，不按业务类型硬编码页面。支持 text、textarea、number、select、multiselect，单卡1–6个字段；允许标签、占位提示、单位、必填、数值范围、文本长度和枚举选项。拒绝任意脚本、动作地址、未知字段属性及模型编造的默认值。

- `src/form-interaction.ts`：表单定义与回复值校验，字段错误码。
- `src/interactions.ts`：保存表单、绑定会话/任务版本、提交去重、继续对话。
- `examples/chat-ui/form-ui.js`：通用输入控件、错误提示、已回复状态。

`POST /interactions/:id/reply` 请求：

```json
{
  "sessionId": "当前会话",
  "requestId": "客户端生成的请求ID",
  "values": { "city": "杭州", "area": 110 },
  "stream": true
}
```

服务端仅使用此前保存的字段定义校验。校验后按 `form_reply` 类型把 fields/values 序列化为结构化用户消息，调用同一会话的聊天处理器，数字和数组类型不丢失。模型继续通过工具更新草稿，**提交信息不等于授权发布**。普通聊天框仍可直接回答。

表单以 interactionId 和按字段顺序规范化的答案去重：相同答案的并发/重复提交复用第一次结果，不重复调用模型；已经提交不同答案返回409。模型调用失败可重试；若期间业务草稿已变更，旧表单返回 stale_interaction，需要重新生成。普通的会话繁忙不会误判成表单过期。

错误返回 `fieldErrors`；流式请求通过 error 事件携带相同结构。页面保存已输入值，字段错误出现在控件旁，成功后标记“已回复”并锁定。未成功完成的模型调用不会自动将表单标记为已回复。

2026-11-17：真实 DeepSeek 生成了空城市/面积表单；负面积返回字段错误；有效回复被写入草稿为杭州、110，任务仍处于收集阶段；重复请求返回缓存结果，没有重复模型调用或发布。

## 第十阶段：JSON配置与任务切换

业务配置与运行参数迁到文件，核心不读取装修常量：

- `configs/runtime.json`：模型轮数、请求超时、交互结束策略、交互类型/表单字段数，以及完整上下文预算/压缩参数。
- `configs/applications/decoration.json`：角色、业务话题范围、超范围回复、演示主体、切换策略、预设字段和执行器注册名。
- `src/config/index.ts`：严格加载、未知键/不合法范围/未知执行器检查、深冻结配置和版本hash。
- `integrations/content-service/executors.ts`：真实代码注册执行器，配置只能引用注册名，不能指定脚本或任意函数路径。
- `examples/local-app.ts`：组合配置、适配器和核心，不把业务选择逻辑塞进循环。

默认启动读取上述两个JSON。可通过 `HARNESS_RUNTIME_CONFIG`、`HARNESS_APPLICATION_CONFIG` 指定其他文件。密钥、模型名称、服务地址和端口仍使用 `.env`。运行时轮数/超时/压缩等以JSON为准；示例应用不再读取旧的 CONTEXT_* 与 MODEL_MAX_OUTPUT_TOKENS 环境变量作为运行策略，输出上限由JSON统一传给模型。

配置只在启动时加载，不热更新；修改JSON后请重启当前 `npm run dev` 或 `npm start`。每个任务记录 configVersion，运行中的配置和预设定义采用启动快照，不会把新配置悄悄应用到旧草稿。当前会话仍是内存数据，重启会失效；跨版本持久任务迁移尚未实现。

### 通用策略

- `stopOnAwaitingUser: true`：成功生成交互后直接结束本轮，不再让模型追加“表单已生成”式说明。控制信号来自工具注册元数据，不根据模型文字猜测。JSON客户端应同时读取 interactions；此时 reply 允许为空。
- `taskSwitching.enabled: true`：提供 start_task / resume_task 工具。开始新任务会暂停当前未完成任务、增加版本，使旧确认和表单失效。新草稿为空，不自动复制历史事实。
- 切换后重建本轮模型上下文，只保留当前用户输入和新任务状态；旧完整对话仍在 transcript 中。当前请求最多切换一次，后续执行共用同一个模型轮数上限。用户可在后续轮次明确要求恢复旧任务。
- 旧任务正在执行时拒绝切换，不能把切换当成撤销已提交发布。
- `scope.mode: prompt`：业务范围注入主模型系统指令，不增加分类Agent；它是软约束，不保证自然语言绝不跑题。不支持的 strict 模式会在启动时报错。
- 当前仅支持 previousTask=pause、reuseDraft=ask。模糊切换和内容复用由模型补问；后端不自动复制旧字段。

所有任务仍必须经过独立确认。配置 `confirmationRequired: false` 会启动失败，不能绕过版本绑定、字段校验与授权。执行器的具体网络调用、图片转存及错误处理留在适配器。

本轮仅执行本地类型检查和自动化回归，没有启动额外后台服务或进行浏览器/外部模型测试。

## 核心业务解耦收敛

核心任务现在依赖 `src/tasks/executor.ts` 的 `TaskExecutor.execute`，返回通用 `ExecutionResult`。核心不定义 publicationId、内容服务地址或案例/文章分类，也不内置Mock发布实现。

- 内容发布协议、资源编号及Mock实现：`integrations/content-service/contracts.ts`、`publisher.ts`、`mock-publisher.ts`。
- 应用组装：`examples/local-app.ts` 把业务发布方法绑定为通用execute函数。
- 执行目标仅是可注入的通用描述 `ExecutionTarget`，不在核心枚举 local/mock 业务模式。
- 执行器在代码中声明 requiresConfirmation；定义不能把需要确认的执行器降级。只读执行器可显式声明不需确认，输入完整后进入ready并执行。
- 允许无预设的纯聊天配置、无输入字段的任务和无confirmation的只读应用。无需为了通过配置校验虚构发布任务。

模型供应商、内存附件与HTTP适配仍属于当前src中的基础设施实现，本次收敛针对业务依赖，不代表基础设施适配也已全部拆成独立包。

本次只进行类型检查和本地自动化测试，没有启动、停止或占用用户服务端口。ChatKit实验目录未接入启动链，保留未提交状态，未扩大其接入范围。
