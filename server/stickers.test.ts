import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import {StickerLibrary, stickerTool} from "./stickers.ts";

test("starter stickers survive shelving and restarts and can only be selected once per turn", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const library = new StickerLibrary(db);
    const directory = new URL("./starter-stickers/", import.meta.url);
    library.seed(directory);
    const [first, second] = library.list(true);
    const image = library.image(first.id)!;
    assert.throws(() => library.add("重复", "相同图片", Buffer.from(image)), /已在表情库/);
    assert.throws(() => library.add("错误", "无效图片", Buffer.from("not an image")), /PNG/);
    const picks:string[] = [];
    const tool = stickerTool(library, id => picks.push(id));
    const pick=(id:string) => tool.execute("call",{id,only:false});
    await pick(first.id);
    await pick(first.id);
    await assert.rejects(pick(second.id), /本轮已选好/);
    assert.deepEqual(picks,[first.id]);
    library.edit(first.id, "改名", "修改后下架", false);
    const reopened = new StickerLibrary(db);
    reopened.seed(directory);
    assert.equal(reopened.list().length,7);
    assert.equal(reopened.list(true).length,6);
    assert.deepEqual(reopened.image(first.id),image);
    await assert.rejects(stickerTool(reopened,()=>assert.fail()).execute("call",{id:first.id,only:true}),/已下架/);
    reopened.edit(first.id, "改名", "重新启用", true);
    assert.ok(reopened.available(first.id));
  } finally { db.close(); }
});

test("upgrading the starter pack removes the old library entries and preserves chat references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const library = new StickerLibrary(db);
    db.exec("CREATE TABLE sticker_seeds(version INTEGER PRIMARY KEY); INSERT INTO sticker_seeds VALUES(1); CREATE TABLE turns(sticker_id TEXT REFERENCES stickers(id))");
    const old = "ed9e8156739f8d5103669ce6", unused = "89022b055fdd0568ea98505b";
    const insert = db.prepare("INSERT INTO stickers VALUES(?,?,?,1,?)");
    insert.run(old, "管理员改过名", "旧表情", Buffer.from("original"));
    insert.run(unused, "另一张", "旧表情", Buffer.from("unused"));
    db.prepare("INSERT INTO turns VALUES(?)").run(old);
    library.seed(new URL("./starter-stickers/", import.meta.url));
    assert.deepEqual(library.list().map(s=>s.name),["亲亲对接成功","猪没干坏事","慵懒型猪格","猪睡觉了","猪不开心","猪好难过","我稀饭你"]);
    assert.equal(Buffer.from(library.image(old)!).toString(),"original");
    assert.equal(library.available(old),false);
    assert.throws(()=>library.edit(old,"旧图","移出表情库",true),/不存在/);
    assert.equal(library.image(unused),undefined);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally {db.close();}
});
