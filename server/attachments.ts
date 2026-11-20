import type { IncomingMessage, ServerResponse } from "node:http";
import { openAsBlob } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "./journal.ts";

const maxBytes = 10 * 1024 * 1024;
const lifetime = 7 * 24 * 3600;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let uploading = false;

export async function receiveAttachment(req: IncomingMessage, res: ServerResponse, journal: Journal, base: string, key: string) {
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
  const existing = journal.attachment(conversation,id);
  if (existing) {
    if (existing.expires <= Date.now()) return reply(410,{error:"附件已过期，请重新选择文件"});
    return reply(200,{id,size:existing.size});
  }
  if (uploading) return reply(409,{error:"另一份附件正在上传，请稍后重试"});
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
    const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    const image = mime.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name);
    const form = new FormData();
    form.append("purpose","user_data");
    form.append("expires_after[anchor]","created_at");
    form.append("expires_after[seconds]",String(lifetime));
    form.append("file",await openAsBlob(path,{type:mime}),name);
    const response = await fetch(base+"/files",{method:"POST",headers:{authorization:"Bearer "+key},
      body:form,signal:AbortSignal.timeout(85000)});
    if (!response.ok) return reply(response.status===400 ? 415 : 502,{error:response.status===400 ?
      "OpenAI 无法接收此文件，请更换文件或格式" : "附件上传到 OpenAI 失败，请重试"});
    const remote = await response.json();
    if (typeof remote.id !== "string") throw new Error("Missing OpenAI file id");
    journal.saveAttachment(conversation,{id,name,size,image:Number(image),remote:remote.id,
      expires:(remote.expires_at || remote.created_at + lifetime)*1000});
    reply(200,{id,size});
  } catch {
    if (!res.headersSent && !res.destroyed) reply(502,{error:"附件上传失败，请重试"});
  } finally {
    try { if (dir) await rm(dir,{recursive:true,force:true}); } finally { uploading=false; }
  }
}
