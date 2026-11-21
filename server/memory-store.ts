import type { DatabaseSync } from "node:sqlite";

export interface Fact { id:number; content:string; turnId:number }
export interface FactEdit { content:string; quote:string; previous?:Fact }

export class MemoryStore {
  private readonly db:DatabaseSync;

  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
      const old=exists("memories") && !db.prepare("SELECT 1 FROM pragma_table_info('memories') WHERE name='quote'").get();
      if (old) db.exec("ALTER TABLE memories RENAME TO old_memories");
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, turn_id INTEGER NOT NULL REFERENCES turns(id),
          content TEXT NOT NULL, quote TEXT NOT NULL, vector_file TEXT UNIQUE, indexed INTEGER NOT NULL DEFAULT 0,
          retry_after INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation,content));
        CREATE TABLE IF NOT EXISTS memory_stores (conversation TEXT PRIMARY KEY,namespace TEXT NOT NULL UNIQUE,remote TEXT);
        CREATE TABLE IF NOT EXISTS retired_memory_resources (path TEXT PRIMARY KEY,retry_after INTEGER NOT NULL DEFAULT 0);
      `);
      if (old) {
        const columns=new Set(db.prepare("PRAGMA table_info(old_memories)").all().map(r=>r.name));
        const topics=exists("memory_topics");
        const active=columns.has("superseded_by")?"superseded_by IS NULL":"1";
        const unimported=topics?"AND id NOT IN (SELECT legacy FROM memory_imports)":"";
        const vector=columns.has("vector_file")?"vector_file,indexed,retry_after":"NULL,0,0";
        db.exec(`
          DROP TRIGGER IF EXISTS memory_terms_insert;
          DROP TRIGGER IF EXISTS memory_terms_update;
          DROP TRIGGER IF EXISTS memory_terms_delete;
          DROP TABLE IF EXISTS memory_terms;
          INSERT INTO memories(id,conversation,turn_id,content,quote,vector_file,indexed,retry_after)
            SELECT id,conversation,turn_id,content,content,${vector} FROM old_memories WHERE ${active} ${unimported};
          UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(id) FROM old_memories),0)) WHERE name='memories';
        `);
        if (columns.has("vector_file")) db.exec(`
          INSERT OR IGNORE INTO retired_memory_resources(path)
            SELECT '/files/'||vector_file FROM old_memories WHERE vector_file IS NOT NULL
            AND vector_file NOT IN (SELECT vector_file FROM memories WHERE vector_file IS NOT NULL);
        `);
        if (topics) db.exec(`
          INSERT INTO memories(conversation,turn_id,content,quote)
            SELECT t.conversation,m.turn_id,t.subject||t.label||'：'||m.value||'。',
              coalesce((SELECT c.quote FROM memory_changes c WHERE c.member=m.id AND c.turn_id=m.turn_id ORDER BY c.id DESC LIMIT 1),
                (SELECT question FROM turns WHERE id=m.turn_id))
            FROM memory_members m JOIN memory_topics t ON t.id=m.topic WHERE m.active=1 ORDER BY m.turn_id,m.id
            ON CONFLICT(conversation,content) DO UPDATE SET turn_id=excluded.turn_id,quote=excluded.quote
            WHERE excluded.turn_id>=memories.turn_id;
          INSERT OR IGNORE INTO retired_memory_resources(path) SELECT '/files/'||vector_file FROM memory_topics WHERE vector_file IS NOT NULL;
          INSERT OR IGNORE INTO retired_memory_resources(path,retry_after) SELECT '/files/'||file,retry_after FROM retired_topic_files;
          INSERT OR IGNORE INTO retired_memory_resources(path) SELECT '/vector_stores/'||remote FROM topic_stores
            WHERE remote IS NOT NULL AND remote NOT IN (SELECT remote FROM memory_stores WHERE remote IS NOT NULL);
          DROP TABLE memory_changes;
          DROP TABLE memory_members;
          DROP TABLE memory_topics;
          DROP TABLE memory_receipts;
          DROP TABLE memory_imports;
          DROP TABLE memory_import_retry;
          DROP TABLE retired_topic_files;
          DROP TABLE topic_stores;
        `);
        db.exec("DROP TABLE old_memories");
      }
      db.exec("CREATE INDEX IF NOT EXISTS memory_pending ON memories(retry_after,id) WHERE indexed=0; COMMIT");
    } catch(error) { db.exec("ROLLBACK"); throw error; }
  }

  pending(conversation:string):Fact[] {
    return this.db.prepare("SELECT id,content,turn_id AS turnId FROM memories WHERE conversation=? AND indexed=0 ORDER BY turn_id DESC,id DESC LIMIT 20")
      .all(conversation) as unknown as Fact[];
  }

  apply(conversation:string,turn:number,edits:FactEdit[]) {
    const ids:number[]=[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM turns WHERE conversation=? AND id=? AND status='pending'").get(conversation,turn))
        throw new Error("当前消息已结束。");
      for (const {content,quote,previous} of edits) {
        if (previous) {
          const row=this.db.prepare("SELECT content,turn_id,vector_file FROM memories WHERE conversation=? AND id=?").get(conversation,previous.id);
          if (!row || row.content!==previous.content || row.turn_id!==previous.turnId) throw new Error("这条记忆已变更，请重新核对。");
          if (content!==row.content) {
            if (row.vector_file) this.db.prepare("INSERT OR IGNORE INTO retired_memory_resources(path) VALUES(?)").run("/files/"+row.vector_file);
            this.db.prepare("UPDATE memories SET content=?,vector_file=NULL,indexed=0,retry_after=0 WHERE id=?").run(content,previous.id);
          }
          this.db.prepare("UPDATE memories SET turn_id=?,quote=? WHERE id=?").run(turn,quote,previous.id);
          ids.push(previous.id);
        } else {
          const row=this.db.prepare(`INSERT INTO memories(conversation,turn_id,content,quote) VALUES(?,?,?,?)
            ON CONFLICT(conversation,content) DO UPDATE SET turn_id=excluded.turn_id,quote=excluded.quote RETURNING id`)
            .get(conversation,turn,content,quote)!;
          ids.push(Number(row.id));
        }
      }
      this.db.exec("COMMIT");
      return ids;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
