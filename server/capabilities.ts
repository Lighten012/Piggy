import { fileURLToPath } from "node:url";
import { loadSkills } from "./skill-loader.ts";
import { readCycle, recordPeriod, cancelPeriod, updatePeriod, updateSettings } from "./cycle.ts";
import { stickerDeclaration } from "./stickers.ts";
import { skipDeclaration } from "./schedules.ts";
import { locationDeclaration, weatherDeclaration } from "./weather.ts";
import { hostedTools } from "./hosted-tools.ts";
import { saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration } from "./memory.ts";

const skillsDir = fileURLToPath(new URL("./skills/",import.meta.url));
export const loadedSkills = loadSkills(skillsDir);
export const toolDeclarations = [locationDeclaration, weatherDeclaration, stickerDeclaration, saveMemoryDeclaration, searchMemoryDeclaration, searchChatDeclaration, readChatDeclaration, readCycle, recordPeriod, cancelPeriod, updatePeriod, updateSettings];

export function capabilityCatalog() {
  return {
    skills: loadedSkills.map(({name, description, instructions}) => ({name, description, instructions})),
    tools: [...hostedTools.map(t => ({name:t.type,description:t.description})), ...toolDeclarations,skipDeclaration],
  };
}
