import type { IncomingMessage, ServerResponse } from "node:http";
import { openAsBlob } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Journal } from "./journal.ts";

import { attachmentMime, imageFormat, isStaticGif } from "./attachment-format.ts";

import { Retention, week } from "./retention.ts";

const maxBytes = 10 * 1024 * 1024;
const lifetime = week / 1000;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let uploading = false;

export class AttachmentError extends Error {
  status: number;
  constructor(status:number, message:string) { super(message); this.status=status; }
}

async function uploadInfo(path:string, original:string, hint:string) {
  const file = await open(path,"r");
  const header = Buffer.alloc(12);
  try { await file.read(header,0,header.length,0); } finally { await file.close(); }
  const format = imageFormat(header);
  if (!format) {
    if (hint.startsWith("image/")) throw new AttachmentError(415,"无法读取图片，请确认它是 JPEG、PNG、WebP 或静态 GIF。");
    return {mime:hint,name:original};
  }
  if (format.mime === "image/gif" && !isStaticGif(await readFile(path)))
    throw new AttachmentError(415,"仅支持有效的静态 GIF");
  const dot = original.lastIndexOf(".");
  const stem = (dot > 0 ? original.slice(0,dot) : original) || "image";
  const name = stem+"."+format.extension;
  return {mime:format.mime,name:Buffer.byteLength(name) <= 255 ? name : "image."+format.extension};
}

async function uploadFile(base:string, key:string, path:string, name:string, mime:string, seconds:number) {
  const form = new FormData();
  form.append("purpose","user_data");
  form.append("expires_after[anchor]","created_at");
  form.append("expires_after[seconds]",String(seconds));
  form.append("file",await openAsBlob(path,{type:mime}),name);
  const response = await fetch(base+"/files",{method:"POST",headers:{authorization:"Bearer "+key},
    body:form,signal:AbortSignal.timeout(85000)});
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 400) throw new AttachmentError(415,"OpenAI 无法读取此文件，请检查文件格式");
    throw new AttachmentError(502,"附件服务暂时不可用，请稍后重试");
  }
  const remote = await response.json();
  if (typeof remote.id !== "string") throw new Error("Missing OpenAI file id");
  return remote;
}

// An Android retry reuses the attachment ID and skips the upload endpoint.
export async function prepareStoredImage(journal:Journal, retention:Retention, conversation:string, file:Attachment, base:string, key:string) {
  if (!file.image) return;
  const copy = journal.uncheckedImage(conversation,file.id);
  if (!copy) return;
  const path = retention.copyPath(copy.key);
  const info = await uploadInfo(path,file.name,copy.mime);
  let remote = file.remote;
  if (info.name !== file.name || info.mime !== copy.mime) {
    const remaining = Math.max(3600,Math.min(lifetime,Math.floor((file.expires-Date.now())/1000)));
    remote = (await uploadFile(base,key,path,info.name,info.mime,remaining)).id;
  }
  journal.recordImageFormat(conversation,file.id,remote,info.mime,info.name);
  file.remote = remote;
}

export async function receiveAttachment(req: IncomingMessage, res: ServerResponse, journal: Journal, retention: Retention, base: string, key: string) {
  function reply(code: number, body: object) {
    res.writeHead(code, {"Content-Type":"application/json"});
    res.end(JSON.stringify(body));
  }
  const conversation = String(req.headers["x-piggy-session"] ?? "");
  const id = String(req.headers["x-piggy-attachment"] ?? "");
  const name = Buffer.from(String(req.headers["x-piggy-filename"] ?? ""), "base64url").toString("utf8");
  if (!uuid.test(conversation) || !uuid.test(id) || !name.trim() || Buffer.byteLength(name)>255 || /[\x00-\x1f\x7f/\\]/.test(name))
    return reply(400,{error:"附件信息无效，请重新选择文件"});
  if (Number(req.headers["content-length"]) > maxBytes) return reply(413,{error:"每个附件最多 10 MB"});
  const mime = attachmentMime(name, String(req.headers["content-type"] ?? ""));
  if (!mime) return reply(415,{error:"暂不支持该附件格式"});
  const existing = journal.attachment(conversation,id);
  if (existing) {
    if (existing.expires <= Date.now()) return reply(410,{error:"附件已过期，请重新选择文件"});
    return reply(200,{id,size:existing.size});
  }
  if (uploading) {
    res.setHeader("Retry-After","3");
    return reply(409,{error:"附件正在上传，请稍后重试"});
  }
  uploading = true;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(),"piggy-file-"));
    const path = join(dir,"body");
    const file = await open(path,"wx",0o600);
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size>maxBytes) return reply(413,{error:"每个附件最多 10 MB"});
        await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    if (!size) return reply(400,{error:"文件为空，请重新选择"});
    const info = await uploadInfo(path,name,mime);
    const image = info.mime.startsWith("image/");
    const remote = await uploadFile(base,key,path,info.name,info.mime,lifetime);
    const copy = await retention.keep(path);
    try {
      journal.saveAttachment(conversation,{id,name,size,image:Number(image),remote:remote.id,
        expires:(remote.expires_at || remote.created_at + lifetime)*1000},{...copy,mime:info.mime,providerName:info.name});
    } catch (error) {
      await retention.remove(copy.key);
      throw error;
    }
    reply(200,{id,size});
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      if (error instanceof AttachmentError) reply(error.status,{error:error.message});
      else reply(502,{error:"附件上传失败，请重试"});
    }
  } finally {
    uploading = false;
    if (dir) await rm(dir,{recursive:true,force:true});
  }
}
