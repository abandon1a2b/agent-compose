import { randomUUID } from "node:crypto";
import { HttpError } from "./types.ts";
export type ImageAttachment = {
  id: string;
  name: string;
  url: string;
  reference: string;
};
const records = new Map<
  string,
  { bytes: Buffer; mime: string; name: string }
>();
let total = 0;
export function uploadImage(bytes: Buffer, mime: string, name: string) {
  if (!bytes.length || bytes.length > 2 * 1024 * 1024)
    throw new HttpError(413, "单张图片上限2MB");
  const valid =
    mime === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mime === "image/webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : mime === "image/gif"
            ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
            : mime === "image/avif"
              ? bytes.toString("ascii", 4, 8) === "ftyp" &&
                ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
              : false;
  if (!valid)
    throw new HttpError(415, "只支持PNG、JPEG、WebP、GIF、AVIF，文件内容必须匹配类型");
  if (total + bytes.length > 64 * 1024 * 1024)
    throw new HttpError(429, "本地图片缓存已满，请重启服务后重试");
  const id = randomUUID();
  records.set(id, { bytes, mime, name: name.slice(0, 120) });
  total += bytes.length;
  return { id, name: name.slice(0, 120), path: `/images/${id}` };
}
export function getImage(id: string) {
  const image = records.get(id);
  if (!image) throw new HttpError(404, "图片不存在或服务已重启");
  return image;
}
export function resolveImages(ids: string[]): ImageAttachment[] {
  return ids.map((id) => {
    const i = getImage(id);
    return {
      id,
      name: i.name,
      url: `data:${i.mime};base64,${i.bytes.toString("base64")}`,
      reference: `http://127.0.0.1:${process.env.PORT ?? 4318}/images/${id}`,
    };
  });
}
