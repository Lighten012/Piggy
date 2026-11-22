import type {DatabaseSync} from "node:sqlite";

// Called inside the same transaction as the calendar or memory write.
export function appendReceipt(db:DatabaseSync,turn:number|bigint,conversation:string,text:string) {
  const row=db.prepare("SELECT id FROM turns WHERE id=? AND conversation=? AND status='pending'").get(turn,conversation);
  if(!row) throw new Error("本轮操作已结束");
  db.prepare("INSERT INTO operation_receipts(turn_id,text) VALUES(?,?)").run(turn,text);
}
