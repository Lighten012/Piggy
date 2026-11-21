import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "./skill-loader.ts";

test("discover sorted Skill files and reject invalid packages before release", t => {
  const root = mkdtempSync(join(tmpdir(),"piggy-skills-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  function write(dir:string,name=dir,description="支持中文说明",body="一段普通文字。") {
    mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,dir,"SKILL.md"),["---","name: "+name,"description: "+description,"---",body].join("\r\n"));
  }
  write("two"); write("one");
  assert.deepEqual(loadSkills(root).map(s=>s.name),["one","two"]);
  write("one","wrong");
  assert.throws(()=>loadSkills(root),/skill name/);
  write("one","one","a".repeat(1025));
  assert.throws(()=>loadSkills(root),/description/);
  write("one","one","描述"," ");
  assert.throws(()=>loadSkills(root),/instructions/);
  write("one"); write("bad--name");
  assert.throws(()=>loadSkills(root),/skill name/);
});
