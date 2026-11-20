import formats from "../android/app/src/main/assets/attachment-types.json" with { type: "json" };

const byExtension = new Map(Object.entries(formats).flatMap(([mime, extensions]) =>
  extensions.split(" ").map(ext => [ext, mime] as const)));

export function attachmentMime(name: string, reported: string): string | undefined {
  const mime = reported.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return;
  const lower = name.trim().toLowerCase();
  const result = byExtension.get(lower.split(".").at(-1)!) ??
    (!lower.includes(".") && Object.hasOwn(formats, mime) ? mime : undefined);
  if (mime.startsWith("image/") && mime !== result && !(mime === "image/jpg" && result === "image/jpeg")) return;
  return result;
}

// Walk GIF blocks, skipping colour tables, metadata and compressed image data.
export function isStaticGif(data: Buffer) {
  if (data.length < 13 || !/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) return false;
  const tableBytes = (flags: number) => flags & 128 ? 3 * (2 << (flags & 7)) : 0;
  let i = 13 + tableBytes(data[10]);
  let frames = 0;
  while (i < data.length) {
    const block = data[i++];
    if (block === 0x3b) return frames === 1;
    if (block === 0x2c) {
      if (++frames > 1 || i + 9 >= data.length) return false;
      i += 10 + tableBytes(data[i + 8]);
    } else if (block === 0x21) {
      i++; // extension label
    } else return false;
    while (i < data.length && data[i]) i += 1 + data[i];
    i++; // zero-length terminator
  }
  return false;
}
