import { openAsBlob } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { attachmentMime } from "./attachment-format.ts";
import { Retention, week } from "./retention.ts";

export interface ReplyFile {
  key: string; name: string; mime: string; size: number; until: number; remote: string;
}
type Citation = {type:string; filename?:string; file_id?:string; container_id?:string};
type Output = {type:string; id?:string; result?:string; content?:{annotations?:Citation[]}[]};

export const hostedTools = [
  {type:"code_interpreter", description:"生成和处理 Excel、PowerPoint 等文件。"},
  {type:"image_generation", description:"生成图片并作为回复附件发送。"},
];
export function fileTools(ids: string[]) {
  return [
    {type:"code_interpreter",container:{type:"auto",...(ids.length ? {file_ids:[...new Set(ids)]} : {})}},
    {type:"image_generation",output_format:"jpeg",quality:"medium"},
  ];
}

// Only consume provider-issued output items and citations, never URLs from assistant prose.
export class ReplyFiles {
  readonly files: ReplyFile[] = [];
  private seen = new Set<string>();
  private archive: Retention;
  private base: string;
  private apiKey: string;
  constructor(archive: Retention, base: string, apiKey: string) {
    this.archive = archive; this.base = base; this.apiKey = apiKey;
  }

  async observe(raw: unknown, signal?: AbortSignal) {
    const event = raw as {type:string; item?:Output; response?:{output?:Output[]}};
    const items = event.type === "response.output_item.done" && event.item ? [event.item]
      : event.type === "response.completed" ? event.response?.output ?? [] : [];
    for (const item of items) {
      if (item.type === "image_generation_call" && item.id && item.result && !this.seen.has(item.id)) {
        const bytes = Buffer.from(item.result, "base64");
        const ext = bytes.subarray(0,2).equals(Buffer.from([255,216])) ? "jpg"
          : bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
          : bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP" ? "webp" : null;
        if (!ext) throw new Error("生成的图片格式无法识别");
        await this.save("Piggy-"+(this.files.length+1)+"."+ext, signal, async path => {
          await writeFile(path, bytes, {mode:0o600});
        });
        this.seen.add(item.id);
      }
      for (const part of item.content ?? []) for (const ref of part.annotations ?? []) {
        if (ref.type !== "container_file_citation" || !ref.file_id || !ref.container_id || !ref.filename) continue;
        const source = [ref.container_id,ref.file_id];
        if (!source.every(id => /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("生成文件的引用无效");
        const identity = source.join("/");
        if (this.seen.has(identity)) continue;
        await this.save(ref.filename, signal, async path => {
          const response = await fetch(this.base+"/containers/"+source[0]+"/files/"+source[1]+"/content", {
            headers:{authorization:"Bearer "+this.apiKey},signal,redirect:"error",
          });
          if (!response.ok || !response.body) throw new Error("无法取回生成的文件");
          const file = await open(path,"wx",0o600);
          try { await file.writeFile(response.body as AsyncIterable<Uint8Array>); } finally { await file.close(); }
        });
        this.seen.add(identity);
      }
    }
  }

  private async save(filename: string, signal: AbortSignal | undefined, write:(path:string)=>Promise<void>) {
    const name = basename(filename.replaceAll("\\","/")).replace(/[\x00-\x1f\x7f]/g,"_") || "Piggy-file";
    const mime = attachmentMime(name,"application/octet-stream") ?? "application/octet-stream";
    const dir = await mkdtemp(join(tmpdir(),"piggy-output-"));
    const path = join(dir,"content");
    try {
      await write(path);
      const {size} = await stat(path);
      if (!size) throw new Error("生成的文件为空");
      // A Files API reference lets a later tool call reopen the file after its original container expires.
      const form = new FormData();
      form.append("purpose","user_data");
      form.append("expires_after[anchor]","created_at");
      form.append("expires_after[seconds]",String(week/1000));
      form.append("file",await openAsBlob(path,{type:mime}),name);
      const response = await fetch(this.base+"/files",{method:"POST",headers:{authorization:"Bearer "+this.apiKey},body:form,signal});
      if (!response.ok) throw new Error("生成文件的引用保存失败");
      const remote = (await response.json()).id;
      if (typeof remote !== "string" || !remote) throw new Error("生成文件缺少引用");
      const copy = await this.archive.keep(path);
      this.files.push({...copy,name,mime,size,remote});
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
  async discard() { await Promise.all(this.files.map(file => this.archive.remove(file.key))); }
}

export function replyText(text: string, files: ReplyFile[]) {
  if (!files.length) return text;
  // Native attachments replace the temporary links to the interpreter's sandbox.
  const clean = text.replace(/!?\[([^\]]*)\]\(sandbox:[^)]+\)/gi,"$1").trim();
  return clean || "已生成附件。";
}
