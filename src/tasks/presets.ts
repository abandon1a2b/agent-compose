import { HttpError } from "../types.ts";
export type Field = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "number" | "url-list";
  required?: boolean;
  draftBy?: "assistant" | "user";
  maxLength?: number;
  min?: number;
  max?: number;
  maxItems?: number;
};
export type Preset = string;
export type TaskDefinition = {
  id: string;
  title: string;
  instructions?: string;
  executor?: string;
  confirmationRequired?: boolean;
  fields: readonly Field[];
};
export type Draft = Record<string, string | number | string[] | undefined>;
export function createPresetRegistry(presets: readonly TaskDefinition[]) {
  function isPreset(id: unknown): id is Preset {
    return presets.some((p) => p.id === id);
  }
  function getPreset(id: Preset) {
    const p = presets.find((p) => p.id === id);
    if (!p) throw new HttpError(400, "未知任务预设");
    return p;
  }
  function missingFields(draft: Draft, id: Preset) {
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
  function parsePatch(value: unknown, id: Preset): Draft {
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
  function fieldSchemas(id: Preset) {
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

  return {
    definitions: presets,
    isPreset,
    getPreset,
    missingFields,
    parsePatch,
    fieldSchemas,
  };
}
