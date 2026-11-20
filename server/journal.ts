import { DatabaseSync } from "node:sqlite";
import { previewType } from "./retention.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Attachment {
  id: string; name: string; size: number; image: number; remote: string; expires: number;
}

interface Copy { key: string; until: number; mime: string }

export class Journal {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL,
        created INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending','complete','failed')),
        context TEXT, UNIQUE(conversation,request)
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
      CREATE INDEX IF NOT EXISTS recent_context ON turns(conversation,id) WHERE status='complete';
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
      CREATE INDEX IF NOT EXISTS turn_files_attachment ON turn_files(attachment);
      INSERT OR IGNORE INTO turn_files SELECT id,0,attachment FROM turns WHERE attachment IS NOT NULL;
    `);
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
  retained(key: string) {
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
  latestFiles(conversation: string) {
    const turn = this.db.prepare(`SELECT id FROM turns WHERE conversation=? AND status='complete'
      AND attachment IS NOT NULL ORDER BY id DESC LIMIT 1`).get(conversation);
    return turn ? this.turnFiles(Number(turn.id)) : [];
  }

  previous(conversation: string): AgentMessage[] {
    return this.db.prepare("SELECT context FROM turns WHERE conversation=? AND status='complete' ORDER BY id DESC LIMIT 12")
      .all(conversation).reverse().flatMap(row => JSON.parse(String(row.context)));
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
  complete(id: number | bigint, answer: string, pair: AgentMessage[]) {
    this.db.prepare("UPDATE turns SET answer=?,context=?,status='complete' WHERE id=?").run(answer,JSON.stringify(pair),id);
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
    return rows.map(row => ({...row, files:JSON.parse(String(row.files)).map(({mime, ...file}: {mime?:string}) =>
      mime ? {...file,preview:previewType(mime)} : file)}));
  }
}
