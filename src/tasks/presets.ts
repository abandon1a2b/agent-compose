import { HttpError } from "../types.ts";
export type Field = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "url-list";
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
};
const title: Field = {
  name: "title",
  label: "标题",
  kind: "text",
  required: true,
  maxLength: 200,
};
const content: Field = {
  name: "content",
  label: "正文",
  kind: "textarea",
  required: true,
  maxLength: 12000,
};
export const presets = [
  {
    id: "publish_case",
    title: "发布案例",
    fields: [
      title,
      content,
      {
        name: "city",
        label: "城市名称",
        kind: "text",
        required: true,
        maxLength: 200,
      },
      {
        name: "area",
        label: "面积（㎡）",
        kind: "number",
        required: true,
        min: 0.01,
        max: 10000,
      },
      { name: "style", label: "风格", kind: "text", maxLength: 200 },
      {
        name: "images",
        label: "图片 URL（每行一个）",
        kind: "url-list",
        required: true,
        maxItems: 12,
        maxLength: 2048,
      },
    ] as Field[],
  },
  { id: "publish_article", title: "发布文章", fields: [title, content] },
] as const;
export type Preset = (typeof presets)[number]["id"];
export type Draft = Record<string, string | number | string[] | undefined>;
export function isPreset(id: unknown): id is Preset {
  return presets.some((p) => p.id === id);
}
export function getPreset(id: Preset) {
  const p = presets.find((p) => p.id === id);
  if (!p) throw new HttpError(400, "未知任务预设");
  return p;
}
export function missingFields(draft: Draft, id: Preset) {
  return getPreset(id)
    .fields.filter(
      (f) =>
        f.required &&
        (draft[f.name] === undefined ||
          draft[f.name] === "" ||
          (Array.isArray(draft[f.name]) &&
            !(draft[f.name] as string[]).length)),
    )
    .map((f) => f.label);
}
export function parsePatch(value: unknown, id: Preset): Draft {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "patch 必须是对象");
  const fields = getPreset(id).fields,
    result: Draft = {};
  for (const [key, val] of Object.entries(value)) {
    const f = fields.find((f) => f.name === key);
    if (!f) throw new HttpError(400, `不支持字段 ${key}`);
    if (val === null) {
      result[key] = undefined;
      continue;
    }
    if (f.kind === "number") {
      if (
        typeof val !== "number" ||
        !Number.isFinite(val) ||
        val < (f.min ?? -Infinity) ||
        val > (f.max ?? Infinity)
      )
        throw new HttpError(400, `${f.label} 数值超出范围`);
      result[key] = val;
    } else if (f.kind === "url-list") {
      if (!Array.isArray(val) || val.length > (f.maxItems ?? 12))
        throw new HttpError(400, `${f.label} 必须是URL列表`);
      for (const url of val) {
        try {
          if (
            typeof url !== "string" ||
            url.length > (f.maxLength ?? 2048) ||
            !["https:", "http:"].includes(new URL(url).protocol)
          )
            throw new Error();
        } catch {
          throw new HttpError(400, `${f.label} 必须是 http/https URL`);
        }
      }
      result[key] = val;
    } else {
      if (typeof val !== "string" || val.length > (f.maxLength ?? 200))
        throw new HttpError(400, `${f.label} 格式或长度错误`);
      result[key] = val.trim();
    }
  }
  return result;
}
export function fieldSchemas(id: Preset) {
  return Object.fromEntries(
    getPreset(id).fields.map((f) => [
      f.name,
      f.kind === "number"
        ? { anyOf: [{ type: "number" }, { type: "null" }] }
        : f.kind === "url-list"
          ? { type: "array", items: { type: "string" } }
          : { type: "string" },
    ]),
  );
}
