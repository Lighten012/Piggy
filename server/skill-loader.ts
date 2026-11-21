import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load, FAILSAFE_SCHEMA } from "js-yaml";

export function loadSkills(root:string) {
  const directories = readdirSync(root,{withFileTypes:true}).filter(entry => entry.isDirectory());
  return directories.map(entry => entry.name).sort().map(directory => {
    const path = join(root,directory,"SKILL.md");
    const source = readFileSync(path,"utf8").replace(/^\uFEFF/,"").replace(/\r\n/g,"\n");
    const sections = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n([\s\S]*)$/.exec(source);
    if (!sections) throw new Error("Missing skill front matter: " + path);
    const metadata = load(sections[1],{schema:FAILSAFE_SCHEMA}) as Record<string,unknown> | null;
    if (!metadata || metadata.name !== directory || directory.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(directory))
      throw new Error("Invalid skill name: " + path);
    const description = metadata.description;
    if (typeof description !== "string" || !description.trim() || [...description].length > 1024)
      throw new Error("Invalid skill description: " + path);
    const instructions = sections[2].trim();
    if (!instructions) throw new Error("Empty skill instructions: " + path);
    return {name:directory,description:description.trim(),instructions};
  });
}
