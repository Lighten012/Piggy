import assert from "node:assert/strict";
import test from "node:test";
import { attachmentMime, imageFormat, isStaticGif } from "./attachment-format.ts";

test("attachment policy handles generic MIME, mixed case, and unsupported formats", () => {
  assert.equal(attachmentMime("Plan.PDF","application/octet-stream"),"application/pdf");
  assert.equal(attachmentMime("photo.JPG","image/jpg"),"image/jpeg");
  assert.equal(attachmentMime("notes","text/plain"),"text/plain");
  for (const [name,mime] of [["clip.mp4","application/octet-stream"],["movie.txt","video/mp4"],
    ["audio.mp3","audio/mpeg"],["archive.zip","application/zip"],["clip.mp4","text/plain"],
    ["image.heic","image/heic"]])
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


test("detects the four supported image formats from their binary signatures", () => {
  for (const [prefix,expected] of [
    ["ffd8ffe1","jpg"],["89504e470d0a1a0a","png"],["474946383761","gif"],["474946383961","gif"],
    ["524946461400000057454250","webp"],["524946461400000057415645",undefined],["25504446",undefined],
  ] as const) assert.equal(imageFormat(Buffer.from(prefix,"hex"))?.extension,expected);
  assert.equal(attachmentMime("camera.PNG","image/jpeg"),"image/jpeg");
  assert.equal(attachmentMime("camera.download","image/jpeg"),"image/jpeg");
});
