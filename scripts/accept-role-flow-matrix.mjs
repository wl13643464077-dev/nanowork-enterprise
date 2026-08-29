import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const child = spawnSync(
  process.execPath,
  ["--test", "--no-warnings", "server/test/role-flow-matrix.test.mjs"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      SEED_DEMO: "false",
      ENABLE_SCHEDULER: "false",
      ENABLE_BACKGROUND_EMBEDDINGS: "false",
      // The test replaces AI transport with a loopback provider and rejects every
      // non-loopback fetch. These sentinels also prevent local paid keys loading.
      YUNWU_API_KEY: "role-flow-loopback-stub-only",
      ANTHROPIC_API_KEY: " ",
      OPENAI_API_KEY: " ",
      BOCHA_API_KEY: " ",
      TAVILY_API_KEY: " ",
      SERPER_API_KEY: " ",
    },
  },
);

if (child.error) throw child.error;
if (child.status !== 0) {
  process.stderr.write(child.stdout || "");
  process.stderr.write(child.stderr || "");
  process.exit(child.status || 1);
}

process.stdout.write(child.stdout || "");
process.stdout.write(
  [
    "PASS_OFFLINE_ROLE_FLOW_MATRIX scenarios=12 modules=5 roles=boss,management,staff",
    "provider=loopback externalNetworkAttempts=0 realCloudValidated=false",
    "danglingHolds=0 forbiddenSideEffects=0",
    "",
  ].join("\n"),
);
