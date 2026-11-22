import formats from "../android/app/src/main/assets/attachment-types.json" with { type: "json" };

const byExtension = new Map(Object.entries(formats).flatMap(([mime, extensions]) =>
  extensions.split(" ").map(ext => [ext, mime] as const)));

export function attachmentMime(name: string, reported: string): string | undefined {
  const mime = reported.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return;
  const lower = name.trim().toLowerCase();
  const result = byExtension.get(lower.split(".").at(-1)!) ??
    (!lower.includes(".") && Object.hasOwn(formats, mime) ? mime : undefined);
  if (mime.startsWith("image/")) {
    const hint = mime === "image/jpg" ? "image/jpeg" : mime;
    return Object.hasOwn(formats,hint) ? hint : undefined;
  }
  return result;
}

// The Android picker can supply a JPEG under a PNG name and MIME type.
export function imageFormat(header: Buffer) {
  if (header.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return {mime:"image/jpeg",extension:"jpg"};
  if (header.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))) return {mime:"image/png",extension:"png"};
  const tag = header.toString("latin1",0,6);
  if (tag === "GIF89a" || tag === "GIF87a") return {mime:"image/gif",extension:"gif"};
  if (header.toString("latin1",0,4) === "RIFF" && header.toString("latin1",8,12) === "WEBP")
    return {mime:"image/webp",extension:"webp"};
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
