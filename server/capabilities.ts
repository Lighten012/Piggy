import { hostedTools } from "./hosted-tools.ts";
import { memorySkill, saveMemoryDeclaration } from "./memory.ts";

export const loadedSkills = [memorySkill];
export const toolDeclarations = [saveMemoryDeclaration];

export function capabilityCatalog() {
  return {
    skills: loadedSkills.map(({name, description, instructions}) => ({name, description, instructions})),
    tools: [...hostedTools.map(t => ({name:t.type,description:t.description})), ...toolDeclarations],
  };
}
