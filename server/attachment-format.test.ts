import assert from "node:assert/strict";
import test from "node:test";
import { attachmentMime, isStaticGif } from "./attachment-format.ts";

test("attachment policy handles generic MIME, mixed case, and unsupported formats", () => {
  assert.equal(attachmentMime("Plan.PDF","application/octet-stream"),"application/pdf");
  assert.equal(attachmentMime("photo.JPG","image/jpg"),"image/jpeg");
  assert.equal(attachmentMime("notes","text/plain"),"text/plain");
  for (const [name,mime] of [["clip.mp4","application/octet-stream"],["movie.txt","video/mp4"],
    ["audio.mp3","audio/mpeg"],["archive.zip","application/zip"],["clip.mp4","text/plain"],
    ["image.heic","image/heic"],["text.txt","image/jpg"]])
    assert.equal(attachmentMime(name,mime), undefined);
});

test("only a complete single-frame GIF passes", () => {
  const header = Buffer.from("47494638396101000100800000000000ffffff","hex");
  const frame = Buffer.from("2c0000000001000100000202440100","hex");
  const comment = Buffer.from("21fe032c3b2c00","hex");
  const trailer = Buffer.from([0x3b]);
  assert.equal(isStaticGif(Buffer.concat([header,comment,frame,trailer])),true);
  assert.equal(isStaticGif(Buffer.concat([header,frame,frame,trailer])),false);
  assert.equal(isStaticGif(Buffer.concat([header,frame])),false);
  assert.equal(isStaticGif(Buffer.from("GIF89a")),false);
});
