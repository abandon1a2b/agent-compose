const taskNames = { publish_case: "发布案例", publish_article: "发布文章" };
const taskStatus = {
  collecting: "收集信息",
  awaiting_confirmation: "待确认",
  approved: "已授权",
  executing: "执行中",
  succeeded: "模拟发布成功",
  failed: "执行失败",
  cancelled: "已取消",
};
const $ = (id) => document.getElementById(id);
const storageKey = "agent-harness-chats-v1";
let chats = [],
  selected,
  pending = null,
  registeredTools = [];
try {
  chats = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
  if (!Array.isArray(chats)) chats = [];
} catch {}
selected = chats[0]?.id;
function save() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(chats));
  } catch {}
}
function current() {
  return chats.find((c) => c.id === selected);
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function error(text = "") {
  $("error").textContent = text;
  $("error").hidden = !text;
}
function render() {
  renderTask();
  const chat = current();
  document.body.classList.toggle("empty", !chat?.messages.length);
  $("welcome").hidden = !!chat?.messages.length;
  $("history").replaceChildren();
  if (!chats.length)
    $("history").append(
      el("p", "从一个问题开始。\n对话会出现在这里。", "empty"),
    );
  for (const item of chats) {
    const button = el(
      "button",
      item.title,
      item.id === selected ? "active" : "",
    );
    button.disabled = !!pending;
    button.onclick = () => {
      selected = item.id;
      error();
      render();
      $("sidebar").classList.remove("open");
    };
    $("history").append(button);
  }
  $("messages").replaceChildren();
  for (const message of chat?.messages ?? []) {
    const box = el("article", undefined, `message ${message.role}`);
    if (message.role === "assistant")
      box.append(el("div", "◈  Harness", "author"));
    box.append(el("div", message.text, "content"));
    if (message.result) {
      const r = message.result;
      const details = el("details", undefined, "trace");
      details.append(
        el(
          "summary",
          `${r.modelCalls} 次模型调用 · ${r.toolCalls.length} 次工具调用 · 压缩${r.compression.status === "compressed" ? "已完成" : r.compression.status === "failed" ? "失败，已回退" : "未执行"}`,
        ),
      );
      details.append(
        el(
          "pre",
          JSON.stringify(
            { toolCalls: r.toolCalls, compression: r.compression },
            null,
            2,
          ),
        ),
      );
      box.append(details);
    }
    $("messages").append(box);
  }
  if (pending) {
    const waiting = el("div", undefined, "waiting");
    waiting.append(
      el("i", undefined, "spinner"),
      el("span", "正在调用模型与工具，请稍候…"),
    );
    $("messages").append(waiting);
  }
  $("send").hidden = !!pending;
  $("stop").hidden = !pending;
  $("send").disabled = !$("input").value.trim();
  $("new-chat").disabled = !!pending;
  $("compress").disabled = !!pending;
  $("session-info").textContent = chat?.sessionId ?? "尚未创建服务端会话";
  $("context-info").replaceChildren();
  const info = chat?.messages.filter((m) => m.result).at(-1)
    ?.result.compression;
  if (info) {
    const metrics = el("div", undefined, "metrics");
    metrics.append(
      el(
        "div",
        `最近请求的上下文估算占用：${(info.afterRatio * 100).toFixed(2)}%`,
      ),
      el(
        "div",
        `${info.afterInputTokens.toLocaleString()} / ${info.inputBudgetTokens.toLocaleString()} tokens`,
      ),
      el(
        "div",
        `压缩触发 ${((info.triggerTokens / info.inputBudgetTokens) * 100).toFixed(0)}% · 目标 ${((info.targetTokens / info.inputBudgetTokens) * 100).toFixed(0)}%`,
      ),
    );
    const bar = el("div", undefined, "progress"),
      fill = el("i");
    fill.style.width = `${Math.min(100, info.afterRatio * 100)}%`;
    bar.append(fill);
    metrics.append(
      bar,
      el("small", "当前为估算值，非模型精确 usage；不包含本次新生成的回答。"),
    );
    $("context-info").append(metrics);
  }
}
async function send(text, preset) {
  if (pending || !text.trim()) return;
  let chat = current();
  if (!chat) {
    chat = {
      id: crypto.randomUUID(),
      title: text.slice(0, 25),
      messages: [],
      preset,
    };
    chats.unshift(chat);
    selected = chat.id;
  }
  const force = $("compress").checked;
  chat.messages.push({ role: "user", text });
  $("input").value = "";
  error();
  pending = new AbortController();
  save();
  render();
  $("conversation").scrollTop = $("conversation").scrollHeight;
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: chat.sessionId,
        message: text,
        compress: force,
        preset: chat.preset,
      }),
      signal: pending.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const e = new Error(result.error ?? "请求失败");
      e.status = response.status;
      throw e;
    }
    chat.sessionId = result.sessionId;
    if (result.task) chat.task = result.task;
    chat.messages.push({ role: "assistant", text: result.reply, result });
    $("compress").checked = false;
    $("status").textContent = "回答已完成 · 会话仅存于服务端内存";
  } catch (e) {
    const message =
      e.name === "AbortError"
        ? "已停止等待，服务端收到断开信号；可继续发送消息。"
        : e.status === 404
          ? "服务端会话已失效（可能已重启）。请点击「新对话」重新开始。"
          : e.message;
    chat.messages.push({ role: "failed", text: message });
    error(message);
    $("input").value = text;
  } finally {
    pending = null;
    save();
    render();
    $("conversation").scrollTop = $("conversation").scrollHeight;
    $("input").focus();
  }
}
$("composer").onsubmit = (e) => {
  e.preventDefault();
  void send($("input").value.trim());
};
$("input").oninput = () => {
  $("send").disabled = !$("input").value.trim();
};
$("input").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send($("input").value.trim());
  }
};
$("stop").onclick = () => pending?.abort();
$("new-chat").onclick = () => {
  selected = undefined;
  error();
  $("input").value = "";
  $("compress").checked = false;
  $("sidebar").classList.remove("open");
  render();
  $("input").focus();
};
$("menu").onclick = () => $("sidebar").classList.toggle("open");
$("conversation").onclick = () => $("sidebar").classList.remove("open");
for (const button of document.querySelectorAll("[data-prompt]"))
  button.onclick = () => void send(button.dataset.prompt);
$("close-tools").onclick = () => $("tools-dialog").close();
$("tools-dialog").onclick = (e) => {
  if (e.target === $("tools-dialog")) $("tools-dialog").close();
};
$("open-tools").onclick = async () => {
  $("tools-dialog").showModal();
  $("tools-list").replaceChildren(el("p", "正在读取工具列表…", "muted"));
  try {
    const response = await fetch(
      "/tools" +
        (current()?.sessionId
          ? "?sessionId=" + encodeURIComponent(current().sessionId)
          : ""),
    );
    if (!response.ok) throw new Error("读取工具失败");
    registeredTools = await response.json();
    $("tool-count").textContent = registeredTools.length;
    $("tools-list").replaceChildren();
    for (const tool of registeredTools) {
      const details = el("details");
      details.append(
        el("summary", tool.name),
        el("p", tool.description, "muted"),
        el("pre", JSON.stringify(tool.parameters, null, 2)),
      );
      $("tools-list").append(details);
    }
  } catch (e) {
    $("tools-list").replaceChildren(el("p", e.message));
  }
};
render();
fetch("/health")
  .then(async (response) => {
    if (!response.ok) throw new Error();
    const health = await response.json();
    $("mode").textContent =
      health.modelMode === "deepseek" ? "DeepSeek" : "Mock 演示";
    $("connection").textContent = "服务已连接";
  })
  .catch(() => {
    $("mode").textContent = "离线";
    $("connection").textContent = "连接失败";
    error("无法连接本地服务，请检查 npm start 是否正在运行。");
  });

function renderTask() {
  const panel = $("task-panel");
  panel.replaceChildren();
  const task = current()?.task;
  if (!task) return;
  const card = el("div", undefined, "task-card");
  card.append(
    el(
      "strong",
      `${taskNames[task.preset]} · ${taskStatus[task.status]} · V${task.version}`,
    ),
  );
  card.append(
    el(
      "small",
      task.missing.length
        ? `待补充：${task.missing.join("、")}`
        : `${task.subject.name} · 临时接口契约`,
    ),
  );
  const button = el(
    "button",
    task.status === "succeeded" ? "查看模拟发布结果" : "查看 / 修改草稿",
  );
  button.disabled = !!pending;
  button.onclick = () => void openDraft();
  card.append(button);
  panel.append(card);
}
async function taskRequest(action, body = {}) {
  const chat = current(),
    task = chat.task;
  const response = await fetch(
    `/tasks/${task.id}${action ? "/" + action : "?sessionId=" + encodeURIComponent(chat.sessionId)}`,
    action
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: chat.sessionId, ...body }),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  chat.task = data;
  save();
  render();
  return data;
}
async function openDraft() {
  try {
    const task = await taskRequest("");
    const body = $("draft-body");
    body.replaceChildren();
    body.append(
      el(
        "p",
        `${taskNames[task.preset]} · V${task.version} · 发布主体：${task.subject.name}`,
        "muted",
      ),
    );
    body.append(
      el(
        "p",
        "当前为模拟接口。请核对所有内容；点击确认后仅生成 Mock 发布结果，不会对外发布。",
        "notice",
      ),
    );
    const form = el("form");
    form.className = "draft-form";
    const fields =
      task.preset === "publish_case"
        ? [
            ["title", "标题"],
            ["content", "正文"],
            ["city", "城市名称"],
            ["area", "面积（㎡）"],
            ["style", "风格（选填）"],
            ["images", "图片 URL（每行一个，不会上传或抓取）"],
          ]
        : [
            ["title", "标题"],
            ["content", "正文"],
          ];
    const inputs = {};
    const immutable = [
      "succeeded",
      "cancelled",
      "approved",
      "executing",
    ].includes(task.status);
    for (const [key, label] of fields) {
      const wrapper = el("label", label);
      const input = el(
        key === "content" || key === "images" ? "textarea" : "input",
      );
      input.name = key;
      input.value = Array.isArray(task.draft[key])
        ? task.draft[key].join("\n")
        : (task.draft[key] ?? "");
      input.disabled = immutable;
      if (key === "area") {
        input.type = "number";
        input.min = "0.01";
        input.step = "any";
      }
      if (key === "content") input.rows = 7;
      wrapper.append(input);
      form.append(wrapper);
      inputs[key] = input;
    }
    const actions = el("div", undefined, "draft-actions");
    const saveButton = el("button", "保存修改");
    saveButton.type = "submit";
    saveButton.disabled = immutable || !!pending;
    const confirm = el(
      "button",
      task.status === "failed" ? "确认重试模拟发布" : "确认模拟发布",
      "confirm-publish",
    );
    confirm.type = "button";
    confirm.disabled =
      !["awaiting_confirmation", "failed"].includes(task.status) || !!pending;
    const cancel = el("button", "取消任务");
    cancel.type = "button";
    cancel.disabled = immutable || !!pending;
    const feedback = el(
      "p",
      task.missing.length
        ? `缺少：${task.missing.join("、")}`
        : task.status === "succeeded"
          ? "该版本已完成模拟发布。"
          : task.status === "cancelled"
            ? "任务已取消。"
            : "请核对当前版本后确认。",
      "muted",
    );
    form.oninput = () => {
      confirm.disabled = true;
      feedback.textContent = "内容已修改，请先保存，再核对新版本。";
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      saveButton.disabled = true;
      try {
        const patch = {};
        for (const [key] of fields) {
          const value = inputs[key].value.trim();
          if (key === "area") {
            patch[key] = value ? Number(value) : null;
          } else
            patch[key] =
              key === "images"
                ? value
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean)
                : value;
        }
        await taskRequest("draft", { version: task.version, patch });
        await openDraft();
      } catch (e) {
        feedback.textContent = e.message;
        saveButton.disabled = false;
      }
    };
    confirm.onclick = async () => {
      confirm.disabled = true;
      saveButton.disabled = true;
      cancel.disabled = true;
      try {
        await taskRequest("confirm", { version: task.version });
        await openDraft();
      } catch (e) {
        feedback.textContent = e.message;
        saveButton.disabled = immutable;
      }
    };
    cancel.onclick = async () => {
      try {
        await taskRequest("cancel");
        await openDraft();
      } catch (e) {
        feedback.textContent = e.message;
      }
    };
    actions.append(saveButton, confirm, cancel);
    form.append(feedback, actions);
    body.append(form);
    if (task.result)
      body.append(
        el("pre", JSON.stringify(task.result, null, 2), "publish-result"),
      );
    if (task.error) body.append(el("p", task.error));
    if (!$("draft-dialog").open) $("draft-dialog").showModal();
  } catch (e) {
    error(e.message);
  }
}
$("close-draft").onclick = () => $("draft-dialog").close();
for (const button of document.querySelectorAll("[data-preset]"))
  button.onclick = () => {
    if (pending) return;
    selected = undefined;
    void send(
      `我要${taskNames[button.dataset.preset]}，请引导我提供需要的内容。`,
      button.dataset.preset,
    );
  };
