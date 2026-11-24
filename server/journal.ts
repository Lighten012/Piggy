import { Installation } from "./installation.ts";
import { Schedules } from "./schedules.ts";
import { StickerLibrary } from "./stickers.ts";
import { CycleStore } from "./cycle.ts";
import { MemoryStore } from "./memory-store.ts";
import { DatabaseSync } from "node:sqlite";
import { MemoryIndex } from "./memory-index.ts";
import { queryKeywords } from "./memory-keywords.ts";
import type { ReplyFile } from "./reply-files.ts";
import { previewType } from "./retention.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Attachment {
  id: string; name: string; size: number; image: number; remote: string; expires: number;
}

import type { ModelSettings } from "./model-settings.ts";

type ContextMessage = AgentMessage & {fileRefs?: Attachment[]};
export interface ContextTurn { sequence: number; messages: ContextMessage[] }
export interface ContextReplacement { through: number; last: number; summary: AgentMessage }

interface Copy { key: string; until: number; mime: string; providerName?: string }

function keywordExcerpt(text:string, terms:string[], size:number) {
  if (text.length <= size) return text;
  const lower = text.toLowerCase();
  const position = terms.map(term => lower.indexOf(term)).find(offset => offset >= 0) ?? 0;
  const start = Math.min(Math.max(0,position-Math.floor(size/4)),text.length-size);
  return (start ? "…" : "") + text.slice(start,start+size) + (start+size < text.length ? "…" : "");
}

export class Journal {
  readonly installation:Installation;
  readonly schedules:Schedules;
  private db: DatabaseSync;
  readonly stickers:StickerLibrary;
  readonly cycles:CycleStore;
  readonly memories:MemoryStore;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.installation = new Installation(this.db);
    this.schedules = new Schedules(this.db,this.installation);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS reply_phrases (
        id INTEGER PRIMARY KEY CHECK(id=1), phrases TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, effort TEXT NOT NULL, tier TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL,
        created INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','complete','failed')),
        UNIQUE(conversation,request)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        conversation TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
        image INTEGER NOT NULL, remote TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(conversation,id)
      );
      CREATE TABLE IF NOT EXISTS local_files (
        key TEXT PRIMARY KEY, conversation TEXT NOT NULL, attachment TEXT NOT NULL,
        until INTEGER NOT NULL, mime TEXT NOT NULL, UNIQUE(conversation,attachment)
      );
      CREATE INDEX IF NOT EXISTS local_expiry ON local_files(until);
      CREATE TABLE IF NOT EXISTS operation_receipts (
        id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL REFERENCES turns(id), text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipt_turn ON operation_receipts(turn_id);

    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('turns') WHERE name='attachment'").get()) {
      this.db.exec("ALTER TABLE turns ADD COLUMN attachment TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_files (
        turn_id INTEGER NOT NULL, position INTEGER NOT NULL, attachment TEXT NOT NULL,
        PRIMARY KEY(turn_id,position), UNIQUE(turn_id,attachment)
      );
      CREATE TABLE IF NOT EXISTS reply_files (
        key TEXT PRIMARY KEY, turn_id INTEGER NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, until INTEGER NOT NULL, UNIQUE(turn_id,position)
      );
      CREATE INDEX IF NOT EXISTS turn_files_attachment ON turn_files(attachment);
      INSERT OR IGNORE INTO turn_files SELECT id,0,attachment FROM turns WHERE attachment IS NOT NULL;
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('local_files') WHERE name='provider_name'").get())
      this.db.exec("ALTER TABLE local_files ADD COLUMN provider_name TEXT");
    this.stickers=new StickerLibrary(this.db);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('turns') WHERE name='sticker_id'").get())
      this.db.exec("ALTER TABLE turns ADD COLUMN sticker_id TEXT REFERENCES stickers(id)");
    this.cycles=new CycleStore(this.db);
    this.memories=new MemoryStore(this.db);
    this.initializeContext();
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('active_context') WHERE name='output_files'").get())
      this.db.exec("ALTER TABLE active_context ADD COLUMN output_files TEXT");
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('reply_files') WHERE name='remote'").get()) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE reply_files ADD COLUMN remote TEXT;
        UPDATE reply_files AS f SET remote=old.remote FROM (
          SELECT json_extract(j.value,'$.key') AS key,json_extract(j.value,'$.remote') AS remote
          FROM active_context a,json_each(a.output_files) j WHERE a.output_files IS NOT NULL
        ) old WHERE old.key=f.key;
        COMMIT`);
    }
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('reply_files') WHERE name='inline_at'").get())
      this.db.exec("ALTER TABLE reply_files ADD COLUMN inline_at INTEGER");
    for(const row of this.db.prepare("SELECT id FROM turns WHERE status='pending'").all())
      this.finishInterrupted(Number(row.id),"");

  }

  replyPhrases(): string[] {
    const row=this.db.prepare("SELECT phrases FROM reply_phrases WHERE id=1").get();
    return row ? JSON.parse(String(row.phrases)) : ["小猪正在努力回复中","小猪正在为你寻找答案","Piggy 正在加油哦"];
  }
  saveReplyPhrases(phrases:string[]) {
    this.db.prepare("INSERT INTO reply_phrases VALUES(1,?) ON CONFLICT(id) DO UPDATE SET phrases=excluded.phrases")
      .run(JSON.stringify(phrases));
  }
  modelSettings(): ModelSettings | undefined {
    return this.db.prepare("SELECT model,effort,tier FROM model_settings WHERE id=1").get() as ModelSettings | undefined;
  }
  saveModelSettings({model,effort,tier}: ModelSettings) {
    this.db.prepare("INSERT INTO model_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model, effort=excluded.effort, tier=excluded.tier")
      .run(model,effort,tier);
  }

  memoryIndex(baseUrl:string,key:string) {
    return new MemoryIndex(this.db,baseUrl,key);
  }

  private initializeContext() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_context'").get()) {
        this.db.exec(`
          CREATE TABLE active_context (
            sequence INTEGER PRIMARY KEY, conversation TEXT NOT NULL, messages TEXT NOT NULL, files TEXT
          );
          CREATE INDEX context_order ON active_context(conversation,sequence);
          CREATE INDEX context_files ON active_context(conversation,sequence) WHERE files IS NOT NULL;
        `);
        // Import the previous format once. An empty working context is valid after this point.
        if (this.db.prepare("SELECT 1 FROM pragma_table_info('turns') WHERE name='context'").get()) {
          this.db.exec(`
            INSERT INTO active_context(conversation,messages,files)
            SELECT t.conversation,t.context,
              CASE WHEN t.attachment IS NOT NULL THEN
                (SELECT json_group_array(f.attachment ORDER BY f.position) FROM turn_files f WHERE f.turn_id=t.id)
              END
            FROM turns t WHERE t.status='complete' AND json_valid(t.context) AND json_type(t.context)='array'
            ORDER BY t.id
          `);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  attachment(conversation: string, id: string) {
    return this.db.prepare("SELECT * FROM attachments WHERE conversation=? AND id=?")
      .get(conversation,id) as Attachment | undefined;
  }
  saveAttachment(conversation: string, file: Attachment, copy?: Copy) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO attachments(conversation,id,name,size,image,remote,expires) VALUES(?,?,?,?,?,?,?)")
        .run(conversation,file.id,file.name,file.size,file.image,file.remote,file.expires);
      if (copy) this.db.prepare("INSERT INTO local_files(key,conversation,attachment,until,mime,provider_name) VALUES(?,?,?,?,?,?)")
        .run(copy.key,conversation,file.id,copy.until,copy.mime,copy.providerName ?? null);
      this.db.prepare(`DELETE FROM attachments WHERE expires < ? AND NOT EXISTS
        (SELECT 1 FROM turn_files f JOIN turns t ON t.id=f.turn_id WHERE t.conversation=attachments.conversation AND f.attachment=attachments.id)`).run(Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK"); throw error;
    }
  }
  uncheckedImage(conversation: string, id: string) {
    return this.db.prepare("SELECT key,mime FROM local_files WHERE conversation=? AND attachment=? AND provider_name IS NULL AND until>?")
      .get(conversation,id,Date.now()) as {key:string;mime:string} | undefined;
  }
  recordImageFormat(conversation:string, id:string, remote:string, mime:string, providerName:string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE attachments SET remote=? WHERE conversation=? AND id=?").run(remote,conversation,id);
      this.db.prepare("UPDATE local_files SET mime=?,provider_name=? WHERE conversation=? AND attachment=?")
        .run(mime,providerName,conversation,id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK"); throw error;
    }
  }
  forgetExpiredCopies(now: number) {
    this.db.prepare("DELETE FROM local_files WHERE until<=?").run(now);
  }
  replyFiles(turn: number | bigint) {
    return this.db.prepare("SELECT key,name,mime,size,until,inline_at AS inlineAt FROM reply_files WHERE turn_id=? ORDER BY position")
      .all(turn).map(row => ({...row,preview:previewType(String(row.mime))}));
  }
  archivedOutputs(turn:number) {
    return this.db.prepare("SELECT key,name,size,mime,until,remote FROM reply_files WHERE turn_id=? ORDER BY position")
      .all(turn) as unknown as (Omit<ReplyFile,"remote"> & {remote:string|null})[];
  }
  restoreOutputReference(key:string,remote:string) {
    this.db.prepare("UPDATE reply_files SET remote=? WHERE key=? AND remote IS NULL").run(remote,key);
  }
  previousOutputs(conversation: string): ReplyFile[] {
    const row = this.db.prepare(`SELECT output_files FROM active_context WHERE conversation=? AND output_files IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`).get(conversation);
    return row ? JSON.parse(String(row.output_files)) : [];
  }
  retained(key: string, conversation?: string) {
    const output = this.db.prepare(`SELECT f.name,f.until,f.mime FROM reply_files f JOIN turns t ON t.id=f.turn_id
      WHERE f.key=? AND (? IS NULL OR t.conversation=?)`).get(key,conversation ?? null,conversation ?? null);
    if (output || conversation !== undefined) return output as {name:string;until:number;mime:string} | undefined;
    return this.db.prepare(`SELECT a.name,l.until,l.mime FROM local_files l JOIN attachments a
      ON a.conversation=l.conversation AND a.id=l.attachment WHERE l.key=? AND EXISTS
      (SELECT 1 FROM turns t JOIN turn_files f ON f.turn_id=t.id
       WHERE t.conversation=l.conversation AND f.attachment=l.attachment)`).get(key) as
        {name:string;until:number;mime:string} | undefined;
  }
  turnFiles(turn: number | bigint) {
    return this.db.prepare(`SELECT a.* FROM turn_files f JOIN turns t ON t.id=f.turn_id
      JOIN attachments a ON a.conversation=t.conversation AND a.id=f.attachment
      WHERE f.turn_id=? ORDER BY f.position`).all(turn) as unknown as Attachment[];
  }
  contextTurns(conversation: string): ContextTurn[] {
    const turns: ContextTurn[] = [];
    const rows = this.db.prepare("SELECT sequence,messages,files FROM active_context WHERE conversation=? ORDER BY sequence");
    for (const row of rows.iterate(conversation)) {
      const messages = JSON.parse(String(row.messages));
      // Older checkpoints copied the last upload into a synthetic summary row.
      // Real upload turns always include the user's message and the assistant reply.
      if (row.files && messages[0]?.role === "user" &&
          !(messages.length === 1 && String(messages[0].content).startsWith("历史对话摘要（仅作背景资料）\n"))) {
        messages[0].fileRefs = JSON.parse(String(row.files)).map((id:string) => this.attachment(conversation,id)).filter(Boolean);
      }
      turns.push({sequence:Number(row.sequence), messages});
    }
    return turns;
  }
  contextMessages(conversation: string): ContextMessage[] {
    return this.contextTurns(conversation).flatMap(turn => turn.messages);
  }
  private replacePrefix(conversation: string, replacement: ContextReplacement) {
    const {through,last,summary} = replacement;
    const latest = this.db.prepare("SELECT max(sequence) AS last FROM active_context WHERE conversation=?").get(conversation);
    if (latest?.last !== last) throw new Error("Conversation changed during compaction");
    const changed = this.db.prepare(`
      UPDATE active_context SET messages=?, files=NULL,
        output_files=(SELECT output_files FROM active_context WHERE conversation=? AND sequence<=? AND output_files IS NOT NULL ORDER BY sequence DESC LIMIT 1)
      WHERE conversation=? AND sequence=?
    `).run(JSON.stringify([summary]),conversation,through,conversation,through);
    if (changed.changes !== 1) throw new Error("Missing compaction boundary");
    this.db.prepare("DELETE FROM active_context WHERE conversation=? AND sequence<?").run(conversation,through);
  }
  lookup(conversation: string, request: string) {
    return this.db.prepare("SELECT id,question,answer,status,attachment,sticker_id AS stickerId FROM turns WHERE conversation=? AND request=?").get(conversation,request);
  }
  begin(conversation: string, request: string, question: string, files: string[] = []) {
    this.db.exec("BEGIN");
    try {
      const turn = this.db.prepare("INSERT INTO turns(conversation,request,created,question,attachment,status) VALUES(?,?,?,?,?,'pending')")
        .run(conversation,request,Date.now(),question,files[0] ?? null).lastInsertRowid;
      const insert = this.db.prepare("INSERT INTO turn_files(turn_id,position,attachment) VALUES(?,?,?)");
      files.forEach((file,index) => insert.run(turn,index,file));
      this.db.exec("COMMIT");
      return turn;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  complete(id: number | bigint, answer: string, messages: AgentMessage[], files: string[] = [], outputs: ReplyFile[] = [], replacement?: ContextReplacement, stickerId?:string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.db.prepare("UPDATE turns SET answer=?,sticker_id=?,status='complete' WHERE id=? AND status='pending' RETURNING conversation")
        .get(answer,stickerId??null,id);
      if (!turn) throw new Error("Turn is no longer pending");
      this.db.prepare("DELETE FROM operation_receipts WHERE turn_id=?").run(id);
      if (replacement) this.replacePrefix(String(turn.conversation),replacement);
      const insert = this.db.prepare("INSERT INTO reply_files(key,turn_id,position,name,mime,size,until,remote,inline_at) VALUES(?,?,?,?,?,?,?,?,?)");
      outputs.forEach((f,i) => insert.run(f.key,id,i,f.name,f.mime,f.size,f.until,f.remote,f.inlineAt??null));
      this.db.prepare("INSERT INTO active_context(conversation,messages,files,output_files) VALUES(?,?,?,?)")
        .run(turn.conversation,JSON.stringify(messages.map(({fileRefs, ...message}:ContextMessage) => message)),files.length ? JSON.stringify(files) : null,outputs.length ? JSON.stringify(outputs) : null);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  searchChatHistory(conversation:string, before:number|bigint, keywords:string[], offset=0) {
    const terms = queryKeywords(keywords);
    if (!terms.length) return {matches:[]};
    const rows = this.db.prepare(`
      SELECT t.id,t.created,t.question,t.answer,t.status FROM turns t JOIN json_each(?) word
      ON instr(lower(t.question),word.value)>0 OR instr(lower(t.answer),word.value)>0 OR EXISTS
        (SELECT 1 FROM turn_files f JOIN attachments a ON a.conversation=t.conversation AND a.id=f.attachment
         WHERE f.turn_id=t.id AND instr(lower(a.name),word.value)>0) OR EXISTS
        (SELECT 1 FROM reply_files f WHERE f.turn_id=t.id AND instr(lower(f.name),word.value)>0)
      WHERE t.conversation=? AND t.id<? GROUP BY t.id
      ORDER BY count(*) DESC,t.id DESC LIMIT 9 OFFSET ?
    `).all(JSON.stringify(terms),conversation,before,offset);
    const matches = rows.slice(0,8).map(row => ({
      turnId:row.id,created:row.created,status:row.status,
      question:keywordExcerpt(String(row.question),terms,400),answer:keywordExcerpt(String(row.answer),terms,500),
    }));
    return {matches,nextOffset:rows.length > 8 ? offset+8 : undefined};
  }

  readChatContext(conversation:string, before:number|bigint, source:"memory"|"turn", id:number, offset=0) {
    const anchor = source === "memory"
      ? this.db.prepare("SELECT turn_id FROM memories WHERE conversation=? AND id=?").get(conversation,id)?.turn_id : id;
    if (typeof anchor !== "number") return {turns:[]};
    const columns = "SELECT id,created,status,question,answer FROM turns WHERE conversation=? AND id<?";
    const main = this.db.prepare(columns+" AND id=?").get(conversation,before,anchor);
    if (!main) return {turns:[]};
    // Follow the save request back into the archive, even after working context compaction.
    const older = offset ? [] : this.db.prepare(columns+" AND id<? ORDER BY id DESC LIMIT 2").all(conversation,before,anchor).reverse();
    const newer = offset ? [] : this.db.prepare(columns+" AND id>? ORDER BY id LIMIT 2").all(conversation,before,anchor);
    const turns = [...older,main,...newer].map(row => {
      const question = String(row.question), answer = String(row.answer);
      const end = offset+1200;
      return {turnId:row.id,created:row.created,status:row.status,attachments:this.turnFiles(Number(row.id)).map(f=>({name:f.name,available:f.expires>Date.now()})),replyFiles:this.archivedOutputs(Number(row.id)).map(f=>({name:f.name,available:f.until>Date.now()})),question:question.slice(offset,end),answer:answer.slice(offset,end),
        nextOffset:Math.max(question.length,answer.length)>end ? end : undefined};
    });
    return {anchorTurnId:anchor,turns};
  }

  finishInterrupted(id:number|bigint,partial:string) {
    const receipts=this.db.prepare("SELECT text FROM operation_receipts WHERE turn_id=? ORDER BY id").all(id);
    if(!receipts.length) { this.fail(id,partial); return; }
    const answer=receipts.map(r=>r.text).join("\n")+"\n其余回复未能完成。";
    const turn=this.db.prepare("SELECT question,created FROM turns WHERE id=? AND status='pending'").get(id)!;
    const timestamp=Number(turn.created);
    const messages:AgentMessage[]=[
      {role:"user",content:String(turn.question),timestamp},
      {role:"assistant",content:[{type:"text",text:answer}],timestamp,api:"openai-responses",provider:"openai",model:"piggy-receipt",stopReason:"stop",
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},
    ];
    this.complete(id,answer,messages,this.turnFiles(id).map(f=>f.id));
    return answer;
  }
  fail(id: number | bigint, partial: string) {
    this.db.prepare("UPDATE turns SET status='failed',answer=? WHERE id=? AND status='pending'").run(partial,id);
  }

  page(after: number | null, before: number | null) {
    const columns = `SELECT t.id,created,question,answer,status,t.sticker_id AS stickerId,a.name AS filename,a.size AS filesize,
      (SELECT json_group_array(json_patch(json_object('name',b.name,'size',b.size),
         CASE WHEN l.until>? THEN json_object('key',l.key,'until',l.until,'mime',l.mime) ELSE '{}' END) ORDER BY f.position)
       FROM turn_files f JOIN attachments b ON b.conversation=t.conversation AND b.id=f.attachment
       LEFT JOIN local_files l ON l.conversation=b.conversation AND l.attachment=b.id
       WHERE f.turn_id=t.id) AS files FROM turns t LEFT JOIN attachments a
      ON a.conversation=t.conversation AND a.id=t.attachment`;
    const rows = after !== null
      ? this.db.prepare(columns + " WHERE t.id>? ORDER BY t.id LIMIT 40").all(Date.now(),after)
      : this.db.prepare(columns + " WHERE t.id<? ORDER BY t.id DESC LIMIT 40").all(Date.now(),before ?? Number.MAX_SAFE_INTEGER).reverse();
    return rows.map(row => ({...row, replyFiles:this.replyFiles(Number(row.id)), files:JSON.parse(String(row.files)).map(({mime, ...file}: {mime?:string}) =>
      mime ? {...file,preview:previewType(mime)} : file)}));
  }
}
