// Bundled daemon entry (dist/daemon.mjs). Kept separate from the CLI bundle so
// `self-healer start` can spawn a dist complete process. `npm start` (dev) and
// direct repo runs use src/index.ts's own direct-run guard instead.

import { startDaemon } from "./index.ts";

startDaemon().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
