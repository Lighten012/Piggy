import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDeclaration } from "@earendil-works/pi-ai";

interface LoadedSkill {
  name: string;
  description: string;
  instructions: string;
}

// Only include skills and tools available to this Piggy worker.
export const loadedSkills: LoadedSkill[] = [];
export const agentTools: AgentTool[] = [];

export function capabilityCatalog() {
  return {
    skills: loadedSkills.map(({name, description, instructions}) => ({name, description, instructions})),
    tools: agentTools.map(tool => {
      const {name, description, parameters} = toToolDeclaration(tool);
      return {name, description, parameters};
    }),
  };
}
