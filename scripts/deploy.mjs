import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_CONFIG_PATH, generateDeploymentConfig, readBaseConfig, writeDeploymentConfig } from "./deploy-config.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const allowedArgs = new Set(["--config-only", "--dry-run"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length || args.length > 1) {
  console.error("Usage: node scripts/deploy.mjs [--config-only | --dry-run]");
  process.exit(2);
}

try {
  const baseConfig = await readBaseConfig(resolve(projectRoot, "wrangler.jsonc"));
  const config = generateDeploymentConfig(baseConfig, process.env);
  const configPath = resolve(projectRoot, DEPLOY_CONFIG_PATH);
  await writeDeploymentConfig(config, configPath);
  console.log(`Generated ${DEPLOY_CONFIG_PATH} from validated DEPLOY_* values.`);

  if (args.includes("--config-only")) process.exit(0);

  const wranglerBin = resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js");
  const wranglerArgs = ["deploy", "--config", configPath];
  if (args.includes("--dry-run")) wranglerArgs.splice(1, 0, "--dry-run");
  const result = spawnSync(process.execPath, [wranglerBin, ...wranglerArgs], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment configuration failed.");
  process.exit(1);
}
