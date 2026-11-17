import type { Field } from "../../src/tasks/presets.ts";
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
