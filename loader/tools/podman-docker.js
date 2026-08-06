import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((argument) => !argument.startsWith("--provenance"));
const result = spawnSync("podman", args, { stdio: "inherit", shell: false });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
