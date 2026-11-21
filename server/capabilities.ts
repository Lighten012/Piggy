import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, FAILSAFE_SCHEMA } from "js-yaml";
import { hostedTools } from "./hosted-tools.ts";
import { saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration } from "./memory.ts";

const skillsDir = fileURLToPath(new URL("./skills/",import.meta.url));
function loadSkill(directory:string) {
  const path = join(skillsDir,directory,"SKILL.md");
  const source = readFileSync(path,"utf8").replace(/\r\n/g,"\n");
  const sections = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!sections) throw new Error("Missing skill front matter: " + path);
  const metadata = load(sections[1],{schema:FAILSAFE_SCHEMA}) as {name?:string;description?:string} | null;
  const instructions = sections[2].trim();
  if (metadata?.name !== directory || typeof metadata.description !== "string" || !metadata.description.trim() || !instructions)
    throw new Error("Invalid skill name, description or body: " + path);
  return {name:directory,description:metadata.description.trim(),instructions};
}
export const loadedSkills = readdirSync(skillsDir,{withFileTypes:true})
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().map(loadSkill);
export const toolDeclarations = [saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration];

export function capabilityCatalog() {
  return {
    skills: loadedSkills.map(({name, description, instructions}) => ({name, description, instructions})),
    tools: [...hostedTools.map(t => ({name:t.type,description:t.description})), ...toolDeclarations],
  };
}
