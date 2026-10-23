import { startHost } from "../../src/host.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
const fake = fauxProvider({ tokensPerSecond: process.env.TEST_SLOW ? 100 : 100000 });
const models = createModels(); models.setProvider(fake.provider);
fake.setResponses(Array.from({ length: 100 }, () => () => fauxAssistantMessage(process.env.TEST_SLOW ? "recoverable work ".repeat(100) : "recovered answer")));
const host = await startHost(process.argv[2]!, process.argv[3]!, { models });
process.stdout.write("READY\n");
process.on("SIGTERM", () => { void host.close().then(() => process.exit(0)); });
