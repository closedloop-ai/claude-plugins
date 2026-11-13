import { fileURLToPath } from "node:url";

// Imported by every test that reaches the model resolver, so no test result depends on the models this machine's
// person chose in ~/.codex/vibe/models.json (ISS-14109). The path never exists.
process.env.VIBE_MODELS_FILE = fileURLToPath(new URL("../no-model-overrides/models.json", import.meta.url));
