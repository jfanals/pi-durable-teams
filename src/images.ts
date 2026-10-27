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
