import { createTaskUI } from "/task-ui.js";
const $ = (id) => document.getElementById(id);
const storageKey = "agent-harness-chats-v1";
let chats = [],
  selected,
  pending = null,
  registeredTools = [];
let streamText = "";
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
  taskUI.render();
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
    waiting.id = "stream-status";
    const partial = el("div", streamText, "message-text");
    partial.id = "stream-text";
    partial.style.whiteSpace = "pre-wrap";
    $("messages").append(waiting, partial);
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
  streamText = "";
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
        stream: true,
        compress: force,
        preset: chat.preset,
      }),
      signal: pending.signal,
    });
    if (!response.ok) {
      const body = await response.json();
      const e = new Error(body.error ?? "请求失败");
      e.status = response.status;
      throw e;
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      result;
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "step_start") {
            streamText = "";
            if ($("stream-status"))
              $("stream-status").textContent = `模型第 ${event.step} 轮生成中…`;
            if ($("stream-text")) $("stream-text").textContent = "";
          }
          if (event.type === "text_delta") {
            streamText += event.text;
            if ($("stream-text")) $("stream-text").textContent = streamText;
          }
          if (event.type === "tool_start" && $("stream-status"))
            $("stream-status").textContent = `正在执行工具：${event.name}`;
          if (event.type === "error") {
            const e = new Error(event.message);
            e.status = event.status;
            throw e;
          }
          if (event.type === "done") result = event.result;
          $("conversation").scrollTop = $("conversation").scrollHeight;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!result) throw new Error("响应流中断，本轮未确认完成");
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
    chat.messages.push({
      role: "failed",
      text: message + (streamText ? "\n未完成的输出：" + streamText : ""),
    });
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
const taskUI = createTaskUI({
  el,
  current,
  save,
  render,
  error,
  isBusy: () => !!pending,
  startPreset: (text, preset) => {
    selected = undefined;
    void send(text, preset);
  },
});
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
