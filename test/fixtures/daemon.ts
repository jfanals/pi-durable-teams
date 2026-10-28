// Stand-in for src/daemon.ts with a faux model, started through PI_TEAMS_DAEMON.
import { startHost } from "../../src/host.ts";
import { stateDir, socketPath } from "../../src/paths.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const models = createModels(); models.setProvider(fauxProvider().provider);
const host = await startHost(stateDir, socketPath, { models });
process.on("SIGTERM", () => { void host.close().then(() => process.exit(0)); });
