/** Renders only the allowlisted form protocol, with no business field branches. */
export function renderForm(card, { el, submitForm, save, isBusy }) {
  const form = el("form");
  form.className = "reply-form";
  const controls = {};
  card.localValues ??= {};
  const locked = card.status === "completed" || card.status === "expired";
  for (const f of card.fields ?? []) {
    const wrapper = el(
      "label",
      `${f.label}${f.unit ? "（" + f.unit + "）" : ""}${f.required ? " *" : ""}`,
    );
    let control;
    if (f.type === "select" || f.type === "multiselect") {
      control = el("select");
      control.multiple = f.type === "multiselect";
      if (!control.multiple) {
        const empty = el("option", "请选择");
        empty.value = "";
        control.append(empty);
      }
      for (const option of f.options ?? []) {
        const node = el("option", option);
        node.value = option;
        control.append(node);
      }
    } else {
      control = el(f.type === "textarea" ? "textarea" : "input");
      if (f.type === "number") {
        control.type = "number";
        control.step = "any";
        if (f.min !== undefined) control.min = f.min;
        if (f.max !== undefined) control.max = f.max;
      } else control.maxLength = f.maxLength ?? 2000;
      if (f.type === "textarea") control.rows = 3;
      control.placeholder = f.placeholder ?? "";
    }
    const value = card.values?.[f.id] ?? card.localValues[f.id];
    if (control.multiple) {
      for (const option of control.options)
        option.selected = Array.isArray(value) && value.includes(option.value);
    } else control.value = value ?? "";
    control.required = !!f.required;
    control.disabled = locked || isBusy();
    control.name = f.id;
    const err = el("small", card.fieldErrors?.[f.id] ?? "", "field-error");
    err.id = `${card.id}-${f.id}-error`;
    control.setAttribute("aria-describedby", err.id);
    control.oninput = () => {
      card.localValues[f.id] = control.multiple
        ? [...control.selectedOptions].map((o) => o.value)
        : control.value;
      err.textContent = "";
      save();
    };
    controls[f.id] = control;
    wrapper.append(control, err);
    form.append(wrapper);
  }
  const feedback = el(
    "p",
    card.status === "completed"
      ? "已回复"
      : card.status === "expired"
        ? "表单已失效，请在对话中请求新表单"
        : (card.fieldErrors?._form ??
          card.formError ??
          "填写后继续对话；提交信息不代表确认发布。"),
    "muted",
  );
  const submit = el(
    "button",
    card.status === "completed" ? "已回复" : (card.submitLabel ?? "提交信息"),
  );
  submit.type = "submit";
  submit.disabled = locked || isBusy();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (isBusy() || locked) return;
    const values = {};
    for (const f of card.fields ?? []) {
      const control = controls[f.id];
      values[f.id] =
        f.type === "multiselect"
          ? [...control.selectedOptions].map((o) => o.value)
          : f.type === "number"
            ? control.value === ""
              ? null
              : Number(control.value)
            : control.value;
    }
    submit.disabled = true;
    await submitForm(card, values);
  };
  form.append(feedback, submit);
  return form;
}
