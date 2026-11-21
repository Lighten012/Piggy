import type { DatabaseSync } from "node:sqlite";

export interface TopicKey { subject:string; label:string }
export interface Edit extends TopicKey { key:string; value:string; action:"set"|"remove" }
export interface Evidence { conversation:string; turn:number; quote:string; legacy?:number }
const pageSize=50;

export class MemoryTopics {
  private readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_topics (
        id INTEGER PRIMARY KEY, conversation TEXT NOT NULL, subject TEXT NOT NULL, label TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, turn_id INTEGER NOT NULL,
        vector_file TEXT UNIQUE, indexed INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0,
        UNIQUE(conversation,subject,label));
      CREATE TABLE IF NOT EXISTS memory_members (
        id INTEGER PRIMARY KEY, topic INTEGER NOT NULL REFERENCES memory_topics(id), key TEXT NOT NULL,
        value TEXT NOT NULL, turn_id INTEGER NOT NULL, active INTEGER NOT NULL, UNIQUE(topic,key));
      CREATE TABLE IF NOT EXISTS memory_changes (
        id INTEGER PRIMARY KEY, member INTEGER NOT NULL, turn_id INTEGER NOT NULL, quote TEXT NOT NULL,
        action TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_receipts (
        conversation TEXT NOT NULL,turn_id INTEGER NOT NULL,quote TEXT NOT NULL,topics TEXT NOT NULL,
        PRIMARY KEY(conversation,turn_id,quote));
      CREATE TABLE IF NOT EXISTS memory_imports (legacy INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_import_retry (conversation TEXT PRIMARY KEY, retry_after INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_stores (conversation TEXT PRIMARY KEY,namespace TEXT NOT NULL UNIQUE,remote TEXT);
      CREATE TABLE IF NOT EXISTS retired_topic_files (file TEXT PRIMARY KEY,retry_after INTEGER NOT NULL DEFAULT 0);
    `);
  }

  nextLegacy(conversation?:string, readyOnly=false) {
    return this.db.prepare(`SELECT id AS legacy,conversation,turn_id AS turn,content AS quote FROM memories
      WHERE superseded_by IS NULL AND (? IS NULL OR conversation=?) AND id NOT IN (SELECT legacy FROM memory_imports)
      AND (?=0 OR conversation NOT IN (SELECT conversation FROM memory_import_retry WHERE retry_after>?))
      ORDER BY turn_id,id LIMIT 1`).get(conversation??null,conversation??null,Number(readyOnly),Date.now()) as unknown as Evidence|undefined;
  }
  deferLegacy(conversation:string) {
    this.db.prepare("INSERT OR REPLACE INTO memory_import_retry VALUES(?,?)").run(conversation,Date.now()+60000);
  }
  catalog(conversation:string) {
    return this.db.prepare("SELECT id AS topicId,subject,label,revision FROM memory_topics WHERE conversation=? ORDER BY id")
      .all(conversation);
  }
  page(conversation:string,topicId?:number,after=0) {
    const topic=topicId===undefined ? undefined : this.db.prepare("SELECT id AS topicId,subject,label FROM memory_topics WHERE conversation=? AND id=?").get(conversation,topicId);
    const rows=topicId === undefined ? this.db.prepare(`SELECT id AS topicId,subject,label FROM memory_topics
        WHERE conversation=? AND content<>'' AND id>? ORDER BY id LIMIT ?`).all(conversation,after,pageSize+1) :
      this.db.prepare(`SELECT m.id AS memberId,m.key,m.value,m.turn_id AS turnId FROM memory_members m JOIN memory_topics t
        ON t.id=m.topic WHERE t.conversation=? AND t.id=? AND m.active=1 AND m.id>? ORDER BY m.id LIMIT ?`)
        .all(conversation,topicId,after,pageSize+1);
    const entries=rows.slice(0,pageSize);
    return {topic,entries,complete:rows.length<=pageSize,nextAfter:rows.length>pageSize ? entries.at(-1)!.memberId??entries.at(-1)!.topicId : null,
      migrationPending:!!this.nextLegacy(conversation)};
  }
  members(conversation:string,group:TopicKey) {
    return this.db.prepare(`SELECT m.key,m.value FROM memory_members m JOIN memory_topics t ON t.id=m.topic
      WHERE t.conversation=? AND t.subject=? AND t.label=? AND m.active=1 ORDER BY m.id`).all(conversation,group.subject,group.label);
  }
  receipt(source:Evidence):number[]|undefined {
    const row=this.db.prepare("SELECT topics FROM memory_receipts WHERE conversation=? AND turn_id=? AND quote=?")
      .get(source.conversation,source.turn,source.quote);
    return row && JSON.parse(String(row.topics));
  }

  apply(source:Evidence, edits:Edit[], snapshot:ReturnType<MemoryTopics["catalog"]>) {
    const {conversation,turn,quote,legacy}=source;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing=this.receipt(source);
      if (existing) {
        if (legacy) this.db.prepare("INSERT OR IGNORE INTO memory_imports VALUES(?)").run(legacy);
        this.db.exec("COMMIT");
        return existing;
      }
      if (legacy) {
        if (this.nextLegacy(conversation)?.legacy!==legacy) throw new Error("旧记忆顺序已变，请重试。");
      } else {
        if (this.nextLegacy(conversation)) throw new Error("本会话的旧记忆正在整理，请稍后重试。");
        if (!this.db.prepare("SELECT 1 FROM turns WHERE id=? AND conversation=? AND status='pending'").get(turn,conversation))
          throw new Error("当前消息已结束。");
      }
      if (JSON.stringify(this.catalog(conversation))!==JSON.stringify(snapshot)) throw new Error("记忆已更新，请重新核对后重试。");
      const changed=new Set<number>();
      const touched=new Set<string>();
      if (!edits.length) throw new Error("没有可保存的记忆。");
      for (const edit of edits) {
        const {subject,label,key,value,action}=edit;
        const identity=JSON.stringify([subject,label,key]);
        if (touched.has(identity) || !subject || !label || !key || !["remove","set"].includes(action) || (action==="set"&&!value))
          throw new Error("记忆修改有歧义。");
        touched.add(identity);
        if (action==="set") this.db.prepare(`INSERT INTO memory_topics(conversation,subject,label,turn_id) VALUES(?,?,?,?)
          ON CONFLICT(conversation,subject,label) DO NOTHING`).run(conversation,subject,label,turn);
        const topic=this.db.prepare("SELECT id FROM memory_topics WHERE conversation=? AND subject=? AND label=?").get(conversation,subject,label);
        if (!topic) throw new Error("找不到要修改的主题。");
        let member;
        if (action==="set") member=this.db.prepare(`INSERT INTO memory_members(topic,key,value,turn_id,active) VALUES(?,?,?,?,1)
          ON CONFLICT(topic,key) DO UPDATE SET value=excluded.value,turn_id=excluded.turn_id,active=1 RETURNING id,value`).get(topic.id,key,value,turn);
        else member=this.db.prepare("UPDATE memory_members SET active=0,turn_id=? WHERE topic=? AND key=? AND active=1 RETURNING id,value")
          .get(turn,topic.id,key);
        if (!member) throw new Error("找不到要移除的成员。");
        this.db.prepare("INSERT INTO memory_changes(member,turn_id,quote,action,value) VALUES(?,?,?,?,?)").run(member.id,turn,quote,action,member.value);
        changed.add(Number(topic.id));
      }
      for (const id of changed) {
        const row=this.db.prepare("SELECT subject,label,content,vector_file FROM memory_topics WHERE id=?").get(id)!;
        const values=this.db.prepare("SELECT value FROM memory_members WHERE topic=? AND active=1 ORDER BY id").all(id);
        const content=values.length ? String(row.subject)+String(row.label)+"："+values.map(m=>m.value).join("、")+"。" : "";
        if (content!==row.content) {
          if (row.vector_file) this.db.prepare("INSERT OR IGNORE INTO retired_topic_files(file) VALUES(?)").run(row.vector_file);
          this.db.prepare("UPDATE memory_topics SET content=?,vector_file=NULL,indexed=?,retry_after=0 WHERE id=?").run(content,content?0:1,id);
        }
        this.db.prepare("UPDATE memory_topics SET revision=revision+1,turn_id=? WHERE id=?").run(turn,id);
      }
      const ids=[...changed];
      this.db.prepare("INSERT INTO memory_receipts VALUES(?,?,?,?)").run(conversation,turn,quote,JSON.stringify(ids));
      if (legacy) this.db.prepare("INSERT INTO memory_imports VALUES(?)").run(legacy);
      this.db.exec("COMMIT");
      return ids;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
}
