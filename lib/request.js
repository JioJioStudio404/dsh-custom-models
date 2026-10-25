/**
 * What a request's content needs before pi-ai takes it (gateway.js): text
 * cleanup and images.
 *
 * Images are sized the way DSH's own custom gateway sizes them: within a
 * 2048 × 2048 pixel budget and about 1 MiB before base64.
 *
 * @module dsh-custom-models/request
 */
import { cnError, CODES } from "./errors.js";

/** Strip lone surrogates (they break JSON on some vendors) and NULs. */
export const clean = (text) => String(text ?? "").replace(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�").replace(/\u0000/g, "");

/** The text of a content list (or a string). */
export function textOf(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}

/**
 * Clamp an image to the request budget without importing the attachment
 * package; the adapter reports the same target (`imageRequestTarget`).
 * DSH's custom gateway defaults: 2048 × 2048 pixels, 1 MiB.
 */
export function requestTarget(ref, maxPixels = 2048 * 2048, maxBytes = 1024 * 1024) {
  const width = Number(ref?.width) || 2048;
  const height = Number(ref?.height) || 2048;
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), maxBytes };
}

/**
 * Load one image block for a request.
 * @returns `{ mediaType, data }` (base64), or `{ placeholder }` when it cannot or must not be sent.
 */
export async function loadImage(block, { model, attachments, signal }) {
  const ref = block?.attachment;
  if (!model?.image) return { placeholder: "[an image was attached; this model does not take images]" };
  if (block.offloaded === true || !ref) return { placeholder: `[image ${ref?.attachmentId ?? ""} offloaded]` };
  if (typeof attachments?.readImageRequest !== "function") throw cnError(CODES.badRequest, "image input needs the DSH attachment service");
  const version = await attachments.readImageRequest(ref, requestTarget(ref), signal);
  return { mediaType: version.mediaType ?? ref.mediaType ?? "image/png", data: Buffer.from(version.data).toString("base64") };
}
