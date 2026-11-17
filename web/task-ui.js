export function createTaskUI({
  el,
  current,
  save,
  render,
  error,
  isBusy,
  startPreset,
}) {
  const $ = (id) => document.getElementById(id);
  const taskNames = {};
  let presetDefinitions = [];
  const taskStatus = {
    collecting: "收集信息",
    awaiting_confirmation: "待确认",
    approved: "已授权",
    executing: "执行中",
    succeeded: "模拟发布成功",
    failed: "执行失败",
    cancelled: "已取消",
  };
  function renderTask() {
    const panel = $("task-panel");
    panel.replaceChildren();
    const task = current()?.task;
    if (!task) return;
    const card = el("div", undefined, "task-card");
    card.append(
      el(
        "strong",
        `${taskNames[task.preset] ?? task.preset} · ${taskStatus[task.status]} · V${task.version}`,
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
    button.disabled = isBusy();
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
          `${taskNames[task.preset] ?? task.preset} · V${task.version} · 发布主体：${task.subject.name}`,
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
      await presetsReady;
      const definition = presetDefinitions.find((p) => p.id === task.preset);
      if (!definition) throw new Error("任务预设不存在");
      const fields = definition.fields.map((f) => [f.name, f.label]);
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
          ["textarea", "url-list"].includes(
            definition.fields.find((f) => f.name === key).kind,
          )
            ? "textarea"
            : "input",
        );
        input.name = key;
        input.value = Array.isArray(task.draft[key])
          ? task.draft[key].join("\n")
          : (task.draft[key] ?? "");
        input.disabled = immutable;
        if (definition.fields.find((f) => f.name === key).kind === "number") {
          input.type = "number";
          const field = definition.fields.find((f) => f.name === key);
          if (field.min !== undefined) input.min = String(field.min);
          if (field.max !== undefined) input.max = String(field.max);
          input.step = "any";
        }
        if (definition.fields.find((f) => f.name === key).kind === "textarea")
          input.rows = 7;
        wrapper.append(input);
        form.append(wrapper);
        inputs[key] = input;
      }
      const actions = el("div", undefined, "draft-actions");
      const saveButton = el("button", "保存修改");
      saveButton.type = "submit";
      saveButton.disabled = immutable || isBusy();
      const confirm = el(
        "button",
        task.status === "failed" ? "确认重试模拟发布" : "确认模拟发布",
        "confirm-publish",
      );
      confirm.type = "button";
      confirm.disabled =
        !["awaiting_confirmation", "failed"].includes(task.status) || isBusy();
      const cancel = el("button", "取消任务");
      cancel.type = "button";
      cancel.disabled = immutable || isBusy();
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
            if (
              definition.fields.find((f) => f.name === key).kind === "number"
            ) {
              patch[key] = value ? Number(value) : null;
            } else
              patch[key] =
                definition.fields.find((f) => f.name === key).kind ===
                "url-list"
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
  const presetsReady = fetch("/presets")
    .then(async (response) => {
      if (!response.ok) throw new Error("预设加载失败");
      presetDefinitions = await response.json();
      const container = $("preset-entries");
      for (const preset of presetDefinitions) {
        taskNames[preset.id] = preset.title;
        const button = el("button", preset.title);
        button.onclick = () => {
          if (isBusy()) return;
          startPreset(
            `我要${preset.title}，请引导我提供需要的内容。`,
            preset.id,
          );
        };
        container.append(button);
      }
      render();
    })
    .catch((e) => {
      error(e.message);
      throw e;
    });

  return { render: renderTask };
}
