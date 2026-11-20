import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface Attachment {
  id: string; name: string; size: number; image: number; remote: string; expires: number;
}

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
      CREATE INDEX IF NOT EXISTS recent_context ON turns(conversation,id) WHERE status='complete';
      UPDATE turns SET status='failed' WHERE status='pending';
    `);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('turns') WHERE name='attachment'").get()) {
      this.db.exec("ALTER TABLE turns ADD COLUMN attachment TEXT");
    }
  }

  attachment(conversation: string, id: string) {
    return this.db.prepare("SELECT * FROM attachments WHERE conversation=? AND id=?")
      .get(conversation,id) as Attachment | undefined;
  }
  saveAttachment(conversation: string, file: Attachment) {
    this.db.prepare("INSERT INTO attachments(conversation,id,name,size,image,remote,expires) VALUES(?,?,?,?,?,?,?)")
      .run(conversation,file.id,file.name,file.size,file.image,file.remote,file.expires);
    this.db.prepare(`DELETE FROM attachments WHERE expires < ? AND NOT EXISTS
      (SELECT 1 FROM turns WHERE turns.conversation=attachments.conversation AND turns.attachment=attachments.id)`).run(Date.now());
  }
  latestAttachment(conversation: string) {
    return this.db.prepare(`SELECT a.* FROM turns t JOIN attachments a ON a.id=t.attachment AND a.conversation=t.conversation
      WHERE t.conversation=? AND t.status='complete' ORDER BY t.id DESC LIMIT 1`).get(conversation) as Attachment | undefined;
  }

  previous(conversation: string): AgentMessage[] {
    return this.db.prepare("SELECT context FROM turns WHERE conversation=? AND status='complete' ORDER BY id DESC LIMIT 12")
      .all(conversation).reverse().flatMap(row => JSON.parse(String(row.context)));
  }
  lookup(conversation: string, request: string) {
    return this.db.prepare("SELECT question,answer,status,attachment FROM turns WHERE conversation=? AND request=?").get(conversation,request);
  }
  begin(conversation: string, request: string, question: string, attachment: string | null = null) {
    return this.db.prepare("INSERT INTO turns(conversation,request,created,question,attachment,status) VALUES(?,?,?,?,?,'pending')")
      .run(conversation,request,Date.now(),question,attachment).lastInsertRowid;
  }
  complete(id: number | bigint, answer: string, pair: AgentMessage[]) {
    this.db.prepare("UPDATE turns SET answer=?,context=?,status='complete' WHERE id=?").run(answer,JSON.stringify(pair),id);
  }
  fail(id: number | bigint, partial: string) {
    this.db.prepare("UPDATE turns SET status='failed',answer=? WHERE id=? AND status='pending'").run(partial,id);
  }

  page(after: number | null, before: number | null) {
    const columns = "SELECT t.id,created,question,answer,status,a.name AS filename,a.size AS filesize FROM turns t LEFT JOIN attachments a ON a.conversation=t.conversation AND a.id=t.attachment";
    if (after !== null) {
      return this.db.prepare(columns + " WHERE t.id>? ORDER BY t.id LIMIT 40").all(after);
    }
    return this.db.prepare(columns + " WHERE t.id<? ORDER BY t.id DESC LIMIT 40")
      .all(before ?? Number.MAX_SAFE_INTEGER).reverse();
  }
}
