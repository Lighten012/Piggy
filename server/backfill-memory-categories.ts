// Run against the target environment with the same database and model settings as Pi.
import { DatabaseSync } from "node:sqlite";
import { classifyMemory } from "./memory-classification.ts";
import { defaultSettings, resolveModel, type ModelSettings } from "./model-settings.ts";

const path = process.env.PIGGY_DB;
const key = process.env.PI_API_KEY;
if (!path || !key) throw new Error("PIGGY_DB and PI_API_KEY are required");
const db = new DatabaseSync(path,{timeout:5000});
try {
  const settings = db.prepare("SELECT model,effort,tier FROM model_settings WHERE id=1").get() as ModelSettings | undefined;
  const model = resolveModel(settings ?? defaultSettings,"https://api.openai.com/v1");
  const next = db.prepare("SELECT id,content FROM memories WHERE categories IS NULL ORDER BY id LIMIT 1");
  const update = db.prepare("UPDATE memories SET categories=? WHERE id=? AND categories IS NULL AND content=?");
  let count = 0;
  for (let row=next.get(); row; row=next.get()) {
    const decision = await classifyMemory(model,key,String(row.content));
    if (!decision.authorized) throw new Error("未能为旧记忆确认分类");
    count += Number(update.run(JSON.stringify(decision.categories),row.id,row.content).changes);
  }
  console.log("已补全分类的旧记忆条数",count);
} finally {
  db.close();
}
