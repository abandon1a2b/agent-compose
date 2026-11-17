/** A small allowlisted renderer. It never runs model HTML, JS, URLs or arbitrary actions. */
export function renderInteraction(card, { el, sessionId, send, save, isBusy }) {
  const box = el("section", undefined, "interaction-card");
  box.append(el("strong", card.title));
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
      "以下内容由服务端绑定到当前草稿版本，请完整核对。当前仅模拟执行。",
      "muted",
    ),
  );
  const snapshot = card.snapshot ?? {};
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
      ? "模拟执行已完成。"
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
      feedback.textContent = data.result?.message ?? data.status;
      button.textContent = card.status === "completed" ? "已完成" : "确认重试";
      button.disabled = card.status === "completed";
      save();
    } catch (e) {
      feedback.textContent = e.message;
      button.disabled = false;
    }
  };
  box.append(feedback, button);
  return box;
}
