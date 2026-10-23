import { homedir } from "node:os";
import { join } from "node:path";
export const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const stateDir = process.env.PI_TEAMS_DIR ?? join(agentDir, "durable-teams");
export const socketPath = process.env.PI_TEAMS_SOCKET ?? join(stateDir, "host.sock");
