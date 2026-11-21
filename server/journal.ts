import { DatabaseSync } from "node:sqlite";
import type { ReplyFile } from "./reply-files.ts";
import { previewType } from "./retention.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Attachment {
  id: string; name: string; size: number; image: number; remote: string; expires: number;
}

import type { ModelSettings } from "./model-settings.ts";

export interface ContextTurn { sequence: number; messages: AgentMessage[] }
export interface ContextReplacement { through: number; last: number; summary: AgentMessage }

interface Copy { key: string; until: number; mime: string }

export class Journal {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS model_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, effort TEXT NOT NULL, tier TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL,
        created INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','complete','failed')),
        UNIQUE(conversation,request)
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, turn_id INTEGER NOT NULL REFERENCES turns(id),
        created INTEGER NOT NULL, content TEXT NOT NULL, UNIQUE(conversation,content)
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
      UPDATE turns SET status='failed' WHERE status='pending';
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
    this.initializeContext();
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('active_context') WHERE name='output_files'").get())
      this.db.exec("ALTER TABLE active_context ADD COLUMN output_files TEXT");
  }

  modelSettings(): ModelSettings | undefined {
    return this.db.prepare("SELECT model,effort,tier FROM model_settings WHERE id=1").get() as ModelSettings | undefined;
  }
  saveModelSettings({model,effort,tier}: ModelSettings) {
    this.db.prepare("INSERT INTO model_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model, effort=excluded.effort, tier=excluded.tier")
      .run(model,effort,tier);
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
      if (copy) this.db.prepare("INSERT INTO local_files(key,conversation,attachment,until,mime) VALUES(?,?,?,?,?)")
        .run(copy.key,conversation,file.id,copy.until,copy.mime);
      this.db.prepare(`DELETE FROM attachments WHERE expires < ? AND NOT EXISTS
        (SELECT 1 FROM turn_files f JOIN turns t ON t.id=f.turn_id WHERE t.conversation=attachments.conversation AND f.attachment=attachments.id)`).run(Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK"); throw error;
    }
  }
  forgetExpiredCopies(now: number) {
    this.db.prepare("DELETE FROM local_files WHERE until<=?").run(now);
  }
  replyFiles(turn: number | bigint) {
    return this.db.prepare("SELECT key,name,mime,size,until FROM reply_files WHERE turn_id=? ORDER BY position")
      .all(turn).map(row => ({...row,preview:previewType(String(row.mime))}));
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
  contextFiles(conversation: string): (Attachment | undefined)[] {
    const row = this.db.prepare(`SELECT files FROM active_context WHERE conversation=? AND files IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`).get(conversation);
    const ids: string[] = row ? JSON.parse(String(row.files)) : [];
    return ids.map(id => this.attachment(conversation,id));
  }

  contextTurns(conversation: string): ContextTurn[] {
    const turns: ContextTurn[] = [];
    const rows = this.db.prepare("SELECT sequence,messages FROM active_context WHERE conversation=? ORDER BY sequence");
    for (const row of rows.iterate(conversation))
      turns.push({sequence:Number(row.sequence), messages:JSON.parse(String(row.messages))});
    return turns;
  }
  contextMessages(conversation: string): AgentMessage[] {
    return this.contextTurns(conversation).flatMap(turn => turn.messages);
  }
  private replacePrefix(conversation: string, replacement: ContextReplacement) {
    const {through,last,summary} = replacement;
    const latest = this.db.prepare("SELECT max(sequence) AS last FROM active_context WHERE conversation=?").get(conversation);
    if (latest?.last !== last) throw new Error("Conversation changed during compaction");
    // Keep the latest upload and generated-file references independently, even if
    // they were attached to different turns in the replaced prefix.
    const changed = this.db.prepare(`
      UPDATE active_context SET messages=?,
        files=(SELECT files FROM active_context WHERE conversation=? AND sequence<=? AND files IS NOT NULL ORDER BY sequence DESC LIMIT 1),
        output_files=(SELECT output_files FROM active_context WHERE conversation=? AND sequence<=? AND output_files IS NOT NULL ORDER BY sequence DESC LIMIT 1)
      WHERE conversation=? AND sequence=?
    `).run(JSON.stringify([summary]),conversation,through,conversation,through,conversation,through);
    if (changed.changes !== 1) throw new Error("Missing compaction boundary");
    this.db.prepare("DELETE FROM active_context WHERE conversation=? AND sequence<?").run(conversation,through);
  }
  lookup(conversation: string, request: string) {
    return this.db.prepare("SELECT id,question,answer,status,attachment FROM turns WHERE conversation=? AND request=?").get(conversation,request);
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
  complete(id: number | bigint, answer: string, messages: AgentMessage[], files: string[] = [], outputs: ReplyFile[] = [], replacement?: ContextReplacement) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.db.prepare("UPDATE turns SET answer=?,status='complete' WHERE id=? AND status='pending' RETURNING conversation")
        .get(answer,id);
      if (!turn) throw new Error("Turn is no longer pending");
      if (replacement) this.replacePrefix(String(turn.conversation),replacement);
      const insert = this.db.prepare("INSERT INTO reply_files(key,turn_id,position,name,mime,size,until) VALUES(?,?,?,?,?,?,?)");
      outputs.forEach((f,i) => insert.run(f.key,id,i,f.name,f.mime,f.size,f.until));
      this.db.prepare("INSERT INTO active_context(conversation,messages,files,output_files) VALUES(?,?,?,?)")
        .run(turn.conversation,JSON.stringify(messages),files.length ? JSON.stringify(files) : null,outputs.length ? JSON.stringify(outputs) : null);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  saveMemory(turn:number|bigint, content:string) {
    const source = this.db.prepare("SELECT conversation FROM turns WHERE id=? AND status='pending'").get(turn);
    if (!source) throw new Error("当前消息已结束，无法保存记忆。");
    this.db.prepare(`INSERT INTO memories(conversation,turn_id,created,content) VALUES(?,?,?,?)
      ON CONFLICT(conversation,content) DO NOTHING`).run(source.conversation,turn,Date.now(),content);
  }

  fail(id: number | bigint, partial: string) {
    this.db.prepare("UPDATE turns SET status='failed',answer=? WHERE id=? AND status='pending'").run(partial,id);
  }

  page(after: number | null, before: number | null) {
    const columns = `SELECT t.id,created,question,answer,status,a.name AS filename,a.size AS filesize,
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
