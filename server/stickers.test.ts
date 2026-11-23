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
    assert.equal(reopened.list().length,5);
    assert.equal(reopened.list(true).length,4);
    assert.deepEqual(reopened.image(first.id),image);
    await assert.rejects(stickerTool(reopened,()=>assert.fail()).execute("call",{id:first.id,only:true}),/已下架/);
    reopened.edit(first.id, "改名", "重新启用", true);
    assert.ok(reopened.available(first.id));
  } finally { db.close(); }
});
