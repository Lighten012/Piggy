import { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
      CREATE INDEX IF NOT EXISTS recent_context ON turns(conversation,id) WHERE status='complete';
      UPDATE turns SET status='failed' WHERE status='pending';
    `);
  }

  previous(conversation: string): AgentMessage[] {
    return this.db.prepare("SELECT context FROM turns WHERE conversation=? AND status='complete' ORDER BY id DESC LIMIT 12")
      .all(conversation).reverse().flatMap(row => JSON.parse(String(row.context)));
  }
  lookup(conversation: string, request: string) {
    return this.db.prepare("SELECT question,answer,status FROM turns WHERE conversation=? AND request=?").get(conversation,request);
  }
  begin(conversation: string, request: string, question: string) {
    return this.db.prepare("INSERT INTO turns(conversation,request,created,question,status) VALUES(?,?,?,?,'pending')")
      .run(conversation,request,Date.now(),question).lastInsertRowid;
  }
  complete(id: number | bigint, answer: string, pair: AgentMessage[]) {
    this.db.prepare("UPDATE turns SET answer=?,context=?,status='complete' WHERE id=?").run(answer,JSON.stringify(pair),id);
  }
  fail(id: number | bigint, partial: string) {
    this.db.prepare("UPDATE turns SET status='failed',answer=? WHERE id=? AND status='pending'").run(partial,id);
  }

  page(after: number | null, before: number | null) {
    const columns = "SELECT id,created,question,answer,status FROM turns";
    if (after !== null) {
      return this.db.prepare(columns + " WHERE id>? ORDER BY id LIMIT 40").all(after);
    }
    return this.db.prepare(columns + " WHERE id<? ORDER BY id DESC LIMIT 40")
      .all(before ?? Number.MAX_SAFE_INTEGER).reverse();
  }
}
