import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const candidates = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
let composeFile;

for (const candidate of candidates) {
  try {
    await access(candidate);
    composeFile = candidate;
    break;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Compose is introduced by the deployment Slice. Until then, absence is the policy:
// this check becomes real automatically in the first change that adds a Compose file.
if (composeFile === undefined) {
  console.log("[compose] no Compose topology is checked in yet");
  process.exit(0);
}

const result = spawnSync(
  "docker",
  ["compose", "-f", composeFile, "config", "--quiet"],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(
    `[compose] could not validate ${composeFile}: ${result.error.message}`,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
