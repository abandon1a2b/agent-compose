import { renderForm } from "/form-ui.js";
/** A small allowlisted renderer. It never runs model HTML, JS, URLs or arbitrary actions. */
export function renderInteraction(
  card,
  { el, sessionId, send, save, isBusy, submitForm },
) {
  const box = el("section", undefined, "interaction-card");
  box.append(el("strong", card.title));
  if (card.kind === "form") {
    box.append(renderForm(card, { el, submitForm, save, isBusy }));
    return box;
  }
  if (card.kind === "question") {
    const actions = el("div");
    for (const option of card.options ?? []) {
      const button = el("button", option);
      button.onclick = () => {
        if (!isBusy()) void send(option);
      };
      actions.append(button);
    }
    box.append(actions);
    return box;
  }
  if (card.kind !== "confirmation") return box;
  box.append(
    el(
      "p",
      "以下内容由服务端绑定到当前草稿版本，请完整核对。执行目标由下面的服务端快照标明。",
      "muted",
    ),
  );
  const snapshot = card.snapshot ?? {};
  box.append(
    el(
      "p",
      snapshot.mode === "local"
        ? "将提交到本机内容服务并保存数据，不会发布到线上。"
        : "当前为Mock模拟执行，不保存到业务服务。",
      "muted",
    ),
  );
  for (const [key, value] of Object.entries(snapshot.draft ?? {})) {
    box.append(
      el("div", key, "field-label"),
      el(
        "div",
        Array.isArray(value) ? value.join("\n") : String(value ?? ""),
        "preview-value",
      ),
    );
    if (Array.isArray(value))
      for (const url of value) {
        try {
          const parsed = new URL(url, location.origin);
          if (
            parsed.origin === location.origin &&
            parsed.pathname.startsWith("/images/")
          ) {
            const img = el("img");
            img.src = parsed.href;
            img.alt = "待发布图片";
            img.className = "message-image";
            box.append(img);
          }
        } catch {}
      }
  }
  box.append(
    el(
      "small",
      `主体：${snapshot.subject?.name ?? "未知"} · 草稿版本 ${card.version}`,
    ),
  );
  const button = el(
    "button",
    card.status === "completed" ? "已完成" : "确认执行",
    "confirm-action",
  );
  button.disabled = card.status === "completed";
  const feedback = el(
    "p",
    card.status === "completed"
      ? snapshot.mode === "local"
        ? "已提交到本地验证服务。"
        : "模拟执行已完成。"
      : "如需修改，请直接在对话中说明，旧确认卡片将失效。",
    "muted",
  );
  button.onclick = async () => {
    if (isBusy()) return;
    button.disabled = true;
    try {
      const response = await fetch(
        `/interactions/${encodeURIComponent(card.id)}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      card.status = data.card.status;
      card.result = data.result;
      feedback.textContent = data.result?.message ?? data.status;
      if (data.result?.url) {
        const url = new URL(data.result.url);
        if (["http:", "https:"].includes(url.protocol)) {
          const link = el("a", "查看已提交内容 ↗");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noreferrer";
          box.append(link);
        }
      }
      button.textContent = card.status === "completed" ? "已完成" : "确认重试";
      button.disabled = card.status === "completed";
      save();
    } catch (e) {
      feedback.textContent = e.message;
      button.disabled = false;
    }
  };
  if (card.result?.url) {
    try {
      const url = new URL(card.result.url);
      if (["http:", "https:"].includes(url.protocol)) {
        const link = el("a", "查看已提交内容 ↗");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noreferrer";
        box.append(link);
      }
    } catch {}
  }
  box.append(feedback, button);
  return box;
}
