import { fileURLToPath } from "node:url";
import { loadSkills } from "./skill-loader.ts";
import { readCycle, recordPeriod } from "./cycle.ts";
import { hostedTools } from "./hosted-tools.ts";
import { saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration } from "./memory.ts";

const skillsDir = fileURLToPath(new URL("./skills/",import.meta.url));
export const loadedSkills = loadSkills(skillsDir);
export const toolDeclarations = [saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration, readCycle, recordPeriod];

export function capabilityCatalog() {
  return {
    skills: loadedSkills.map(({name, description, instructions}) => ({name, description, instructions})),
    tools: [...hostedTools.map(t => ({name:t.type,description:t.description})), ...toolDeclarations],
  };
}
