import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { uuid } from "./attachments.ts";

const fingerprint = (value:string) => createHash("sha256").update(value).digest("hex");

export class Installation {
  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS mobile_installation(
      id INTEGER PRIMARY KEY CHECK(id=1), key_hash TEXT NOT NULL, session TEXT NOT NULL, reg TEXT
    )`);
  }
  private readonly db: DatabaseSync;
  session(): string | undefined {
    return this.db.prepare("SELECT session FROM mobile_installation WHERE id=1").get()?.session as string | undefined;
  }
  admit(req:IncomingMessage, claim:boolean): boolean {
    const version=String(req.headers["x-piggy-version-code"]??"");
    const build=/^\d{1,9}$/.test(version)?Number(version):null;
    const key=req.headers["x-piggy-installation"], session=req.headers["x-piggy-session"];
    const valid=typeof key==="string" && uuid.test(key) && typeof session==="string" && uuid.test(session);
    if (valid) {
      const hash=fingerprint(key);
      if (claim) {
        const added=this.db.prepare("INSERT OR IGNORE INTO mobile_installation(id,key_hash,session) VALUES(1,?,?)").run(hash,session).changes;
        if(added) console.info(JSON.stringify({event:"mobile_installation_bound",build,installation:hash.slice(0,12)}));
      }
      if (this.db.prepare("SELECT 1 FROM mobile_installation WHERE id=1 AND key_hash=? AND session=?").get(hash,session)) return true;
    }
    // A path can contain a conversation ID or a filename. Log the endpoint only.
    const endpoint=(req.url??"").split(/[/?]/)[1]??"";
    console.warn(JSON.stringify({event:"mobile_access_denied",build,endpoint:endpoint.slice(0,32),
      reason:!valid?"missing_or_invalid_identity":this.session()?"installation_mismatch":"not_bound",
      installation:valid?fingerprint(key).slice(0,12):null}));
    return false;
  }
}
