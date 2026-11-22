import { openAsBlob } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { attachmentMime } from "./attachment-format.ts";
import { Retention, week } from "./retention.ts";

export interface ReplyFile {
  key: string; name: string; mime: string; size: number; until: number; remote: string; inlineAt?: number;
}
type Citation = {type:string; filename?:string; file_id?:string; container_id?:string; start_index:number; end_index:number};
type FileSource = {filename:string; container_id:string; file_id:string};
const deliverablePrefix = "sandbox:/mnt/data/deliverables/";
type Output = {type:string; id?:string; result?:string; content?:{text?:string;annotations?:Citation[]}[]};

// Only consume provider-issued output items and citations, never URLs from assistant prose.
export class ReplyFiles {
  readonly files: ReplyFile[] = [];
  private references = new Map<string,FileSource>();
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
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (!part.text) continue;
          const chars = Array.from(part.text);
          for (const ref of part.annotations ?? []) {
            if (ref.type !== "container_file_citation" || !ref.container_id || !ref.file_id || !ref.filename ||
                !Number.isInteger(ref.start_index) || !Number.isInteger(ref.end_index)) continue;
            const href = chars.slice(ref.start_index,ref.end_index).join("");
            if (href.startsWith(deliverablePrefix)) {
              this.references.set(href,{filename:ref.filename,container_id:ref.container_id,file_id:ref.file_id});
            }
          }
        }
      }
    }
  }

  async deliver(text:string, signal?:AbortSignal) {
    // A download needs both a final Markdown link and the provider citation covering that exact URL.
    const sourceText=text.trimStart();
    let answer="", cursor=0;
    for (const match of sourceText.matchAll(/!?\[([^\]]*)\]\(<?(sandbox:\/mnt\/data\/deliverables\/(?:[^()<>\n]|\([^()\n]*\))+)>?\)/g)) {
      answer+=sourceText.slice(cursor,match.index)+match[1];
      cursor=match.index+match[0].length;
      const ref = this.references.get(match[2]);
      if (!ref) throw new Error("无法核对成品文件的引用，请重试。");
      const source = [ref.container_id,ref.file_id];
      if (!source.every(id => /^[a-zA-Z0-9_-]+$/.test(id))) throw new Error("生成文件的引用无效");
      const identity = source.join("/");
      if (this.seen.has(identity)) continue;
      const file=await this.save(ref.filename, signal, async path => {
        const response = await fetch(this.base+"/containers/"+source[0]+"/files/"+source[1]+"/content", {
          headers:{authorization:"Bearer "+this.apiKey},signal,redirect:"error",
        });
        if (!response.ok || !response.body) throw new Error("无法取回生成的文件");
        const file = await open(path,"wx",0o600);
        try { await file.writeFile(response.body as AsyncIterable<Uint8Array>); } finally { await file.close(); }
      });
      file.inlineAt=answer.length;
      this.seen.add(identity);
    }
    if (!this.files.length) return text;
    const clean=(answer+sourceText.slice(cursor)).trimEnd();
    for (const file of this.files) {
      if (file.inlineAt===undefined) continue;
      const offset=Math.min(file.inlineAt,clean.length);
      // Keep closing emphasis and sentence punctuation with a standalone caption.
      const suffix=clean.slice(offset).match(/^[*_~。！？：:.,，、;；!？? )）】]*?(?=\r?\n|$)/)?.[0] ?? "";
      file.inlineAt=offset+suffix.length;
    }
    return clean || "已生成附件。";
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
      const file:ReplyFile={...copy,name,mime,size,remote};
      this.files.push(file);
      return file;
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
  async discard() { await Promise.all(this.files.map(file => this.archive.remove(file.key))); }
}
