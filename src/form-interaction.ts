import { HttpError } from "./types.ts";
export type FormField = {
  id: string;
  type: "text" | "textarea" | "number" | "select" | "multiselect";
  label: string;
  required?: boolean;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: string[];
};
export const formFieldSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: {
      type: "string",
      enum: ["text", "textarea", "number", "select", "multiselect"],
    },
    label: { type: "string" },
    required: { type: "boolean" },
    placeholder: { type: "string" },
    unit: { type: "string" },
    min: { type: "number" },
    max: { type: "number" },
    maxLength: { type: "integer" },
    options: { type: "array", items: { type: "string" } },
  },
  required: ["id", "type", "label"],
  additionalProperties: false,
};
export function parseFields(value: unknown): FormField[] {
  if (!Array.isArray(value) || !value.length || value.length > 6)
    throw new Error("表单需要1–6个字段");
  const ids = new Set<string>();
  for (const f of value) {
    if (
      !f ||
      typeof f !== "object" ||
      Object.keys(f).some(
        (k) => !Object.keys(formFieldSchema.properties).includes(k),
      )
    )
      throw new Error("字段定义不合法");
    if (
      typeof f.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f.id) ||
      ["constructor", "prototype", "__proto__"].includes(f.id) ||
      ids.has(f.id)
    )
      throw new Error("字段ID无效或重复");
    ids.add(f.id);
    if (
      !["text", "textarea", "number", "select", "multiselect"].includes(
        f.type,
      ) ||
      typeof f.label !== "string" ||
      !f.label.trim() ||
      f.label.length > 80
    )
      throw new Error("字段类型或标签错误");
    for (const k of ["placeholder", "unit"])
      if (f[k] !== undefined && (typeof f[k] !== "string" || f[k].length > 120))
        throw new Error("字段说明过长");
    if (f.required !== undefined && typeof f.required !== "boolean")
      throw new Error("required 必须是布尔值");
    for (const k of ["min", "max"])
      if (
        f[k] !== undefined &&
        (f.type !== "number" ||
          typeof f[k] !== "number" ||
          !Number.isFinite(f[k]))
      )
        throw new Error("数字范围不合法");
    if (f.min !== undefined && f.max !== undefined && f.min > f.max)
      throw new Error("数字范围不合法");
    if (
      f.maxLength !== undefined &&
      (!["text", "textarea"].includes(f.type) ||
        !Number.isInteger(f.maxLength) ||
        f.maxLength < 1 ||
        f.maxLength > 4000)
    )
      throw new Error("文本上限不合法");
    if (["select", "multiselect"].includes(f.type)) {
      if (
        !Array.isArray(f.options) ||
        !f.options.length ||
        f.options.length > 8 ||
        new Set(f.options).size !== f.options.length ||
        f.options.some(
          (s: unknown) => typeof s !== "string" || !s.trim() || s.length > 120,
        )
      )
        throw new Error("选项定义不合法");
    } else if (f.options !== undefined) throw new Error("该字段不支持选项");
  }
  return structuredClone(value);
}
export class FormValidationError extends HttpError {
  fieldErrors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super(400, "请检查表单字段");
    this.fieldErrors = errors;
  }
}
export function validateValues(fields: FormField[], input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new FormValidationError({ _form: "values 必须是对象" });
  const source = input as Record<string, unknown>,
    values: Record<string, unknown> = {},
    errors: Record<string, string> = {};
  if (Object.keys(source).some((k) => !fields.some((f) => f.id === k)))
    errors._form = "提交包含未知字段";
  for (const f of fields) {
    const value = source[f.id];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (f.required) errors[f.id] = `请填写${f.label}`;
      continue;
    }
    if (f.type === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < (f.min ?? -Infinity) ||
        value > (f.max ?? Infinity)
      )
        errors[f.id] = "请输入范围内的有效数字";
      else values[f.id] = value;
    } else if (f.type === "multiselect") {
      if (
        !Array.isArray(value) ||
        value.length > 8 ||
        new Set(value).size !== value.length ||
        value.some((v) => !f.options!.includes(v))
      )
        errors[f.id] = "请选择有效选项";
      else values[f.id] = value;
    } else if (
      typeof value !== "string" ||
      value.length > (f.maxLength ?? 2000) ||
      (f.type === "select" && !f.options!.includes(value))
    )
      errors[f.id] = "内容长度或选项不合法";
    else values[f.id] = value.trim();
  }
  if (Object.keys(errors).length) throw new FormValidationError(errors);
  return values;
}
