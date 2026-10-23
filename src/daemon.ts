import { startHost } from "./host.ts";
import { productionOptions, socketPath, stateDir } from "./resources.ts";

process.umask(0o077);
const host = await startHost(stateDir, socketPath, await productionOptions());
console.error(`Durable teams host ${process.pid}: ${socketPath}`);
const stop = () => { void host.close().then(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// A storage failure must not leave a healthy-looking server around a closed Harness.
host.service.harness.closed.then(end => {
  if (end.reason === "failed") { console.error("Harness failed", end.error); void host.close().then(() => process.exit(1)); }
});
