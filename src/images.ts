import type { ImageContent } from "@earendil-works/pi-ai";
import { piProcessImage } from "./presentation.ts";

/** Bound input before decoding; Pi then resizes to its inline image limits. */
export async function normalizeImages(value: unknown): Promise<ImageContent[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("Attach at most four images");
  let size = 0;
  const images: ImageContent[] = [];
  for (const image of value) {
    if (image?.type !== "image" || typeof image.data !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error("Invalid image content");
    size += image.data.length;
    if (size > 24 * 1024 * 1024) throw new Error("Images exceed 24 MiB encoded");
    const result = await piProcessImage(Buffer.from(image.data, "base64"), image.mimeType);
    if (!result.ok) throw new Error(result.message);
    images.push({ type: "image", data: result.data, mimeType: result.mimeType });
  }
  return images;
}

/** Local paths remain visible in the editor, just as in Pi. Attach image files on submit. */
export async function imagesFromPaths(text: string): Promise<ImageContent[]> {
  const { readFile, stat } = await import("node:fs/promises");
  const images: ImageContent[] = [];
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("/") && /\.(png|jpe?g|webp|gif)$/i.test(line.trim())) paths.add(line.trim());
  }
  for (const match of text.matchAll(/(?:^|\s)(?:"([^"\n]+)"|'([^'\n]+)'|(\/[^\s]+))/g)) {
    paths.add(match[1] ?? match[2] ?? match[3]!);
  }
  for (const path of paths) {
    const extension = path.split(".").at(-1)?.toLowerCase();
    const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>)[extension ?? ""];
    if (!mimeType) continue;
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (images.length >= 4) throw new Error("Attach at most four images");
    if (info.size > 18 * 1024 * 1024) throw new Error("Image exceeds 18 MiB");
    images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
  }
  return images;
}
