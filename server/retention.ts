import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, unlink } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Journal } from "./journal.ts";

export const week = 7 * 24 * 60 * 60 * 1000;
const archiveKey = /^(\d{13})-[0-9a-f-]{36}$/;

export function previewType(mime: string) {
  if (["image/png","image/jpeg","image/gif","image/webp","application/pdf"].includes(mime)) return mime;
  if (mime === "text/rtf") return null;
  if (mime.startsWith("text/") || mime === "message/rfc822" ||
    /^application\/(?:x-(?:ndjson|subrip|sql|powershell)|json5?|javascript|typescript|toml|yaml|graphql)$/.test(mime))
    return "text/plain; charset=utf-8";
  return null;
}

export class Retention {
  private dir: string;
  constructor(dbPath: string) {
    this.dir = join(dirname(dbPath), "attachments");
  }
  async keep(path: string, until = Date.now() + week) {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const key = until + "-" + randomUUID();
    try {
      await copyFile(path,join(this.dir,key),constants.COPYFILE_EXCL);
      await chmod(join(this.dir,key),0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") await this.remove(key);
      throw error;
    }
    return { key, until };
  }
  copyPath(key:string) {
    if (!archiveKey.test(key)) throw new Error("Invalid archive key");
    return join(this.dir,key);
  }
  async remove(key: string) {
    try { await unlink(join(this.dir,key)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  async sweep(journal: Journal, now = Date.now()) {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    // The deadline in the filename also covers a crash between copy and DB commit.
    for (const name of await readdir(this.dir)) {
      const match = archiveKey.exec(name);
      if (match && Number(match[1]) <= now) await this.remove(name);
    }
    journal.forgetExpiredCopies(now);
  }
  async serve(journal: Journal, key: string, download: boolean, head: boolean, res: ServerResponse, conversation?: string) {
    const record = archiveKey.test(key) ? journal.retained(key,conversation) : undefined;
    if (!record || record.until <= Date.now()) {
      res.writeHead(404); res.end("附件已过期或不存在"); return;
    }
    let file;
    try { file = await open(join(this.dir,key),"r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      res.writeHead(404); res.end("附件已不可用"); return;
    }
    try {
      const preview = !download && previewType(record.mime);
      const filename = encodeURIComponent(record.name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16));
      res.writeHead(200,{
        "Content-Type": preview || "application/octet-stream",
        "Content-Disposition": (preview ? "inline" : "attachment") + "; filename*=UTF-8''" + filename,
        "Content-Length": (await file.stat()).size,
        "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store"
      });
      if (head) res.end(); else await pipeline(file.createReadStream({autoClose:false}),res);
    } finally { await file.close(); }
  }
}
