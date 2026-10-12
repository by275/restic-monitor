import { chmod, readFile, writeFile } from "node:fs/promises";

export const DEPLOY_CONFIG_PATH = ".wrangler.deploy.jsonc";

const REQUIRED_VARIABLES = [
  "DEPLOY_WORKER_NAME",
  "DEPLOY_ADMIN_HOST",
  "DEPLOY_PING_HOST",
  "DEPLOY_D1_DATABASE_NAME",
  "DEPLOY_D1_DATABASE_ID",
];

const OPTIONAL_VARIABLES = ["DEPLOY_ACCOUNT_ID", "DEPLOY_COMPATIBILITY_DATE"];
const ACCEPTED_VARIABLES = new Set([...REQUIRED_VARIABLES, ...OPTIONAL_VARIABLES]);

export function generateDeploymentConfig(baseConfig, env) {
  const unknown = Object.keys(env).filter((key) => key.startsWith("DEPLOY_") && !ACCEPTED_VARIABLES.has(key));
  if (unknown.length) {
    throw new Error(`Unsupported deployment variable(s): ${unknown.sort().join(", ")}`);
  }

  const values = Object.fromEntries(
    [...REQUIRED_VARIABLES, ...OPTIONAL_VARIABLES].map((key) => [key, env[key]?.trim() ?? ""]),
  );
  const missing = REQUIRED_VARIABLES.filter((key) => !values[key]);
  if (missing.length) {
    throw new Error(`Missing required deployment variable(s): ${missing.join(", ")}`);
  }

  validateWorkerName(values.DEPLOY_WORKER_NAME);
  validateHostname(values.DEPLOY_ADMIN_HOST, "DEPLOY_ADMIN_HOST");
  validateHostname(values.DEPLOY_PING_HOST, "DEPLOY_PING_HOST");
  if (values.DEPLOY_ADMIN_HOST.toLowerCase() === values.DEPLOY_PING_HOST.toLowerCase()) {
    throw new Error("DEPLOY_ADMIN_HOST and DEPLOY_PING_HOST must be different hostnames");
  }
  validateDatabaseName(values.DEPLOY_D1_DATABASE_NAME);
  validateDatabaseId(values.DEPLOY_D1_DATABASE_ID);
  if (values.DEPLOY_ACCOUNT_ID) validateAccountId(values.DEPLOY_ACCOUNT_ID);
  if (values.DEPLOY_COMPATIBILITY_DATE) validateCompatibilityDate(values.DEPLOY_COMPATIBILITY_DATE);

  const config = structuredClone(baseConfig);
  if (!Array.isArray(config.d1_databases) || config.d1_databases.filter((binding) => binding.binding === "DB").length !== 1) {
    throw new Error("The tracked Wrangler config must define exactly one DB D1 binding");
  }
  config.name = values.DEPLOY_WORKER_NAME;
  config.vars = {
    ...config.vars,
    ADMIN_HOST: values.DEPLOY_ADMIN_HOST.toLowerCase(),
    PING_BASE_URL: `https://${values.DEPLOY_PING_HOST.toLowerCase()}`,
  };
  config.d1_databases = config.d1_databases.map((binding) =>
    binding.binding === "DB"
      ? {
          ...binding,
          database_name: values.DEPLOY_D1_DATABASE_NAME,
          database_id: values.DEPLOY_D1_DATABASE_ID.toLowerCase(),
        }
      : binding,
  );
  config.routes = [
    { pattern: values.DEPLOY_ADMIN_HOST.toLowerCase(), custom_domain: true },
    { pattern: values.DEPLOY_PING_HOST.toLowerCase(), custom_domain: true },
  ];
  delete config.route;
  config.workers_dev = false;
  if (values.DEPLOY_ACCOUNT_ID) config.account_id = values.DEPLOY_ACCOUNT_ID.toLowerCase();
  if (values.DEPLOY_COMPATIBILITY_DATE) config.compatibility_date = values.DEPLOY_COMPATIBILITY_DATE;
  return config;
}

export async function readBaseConfig(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeDeploymentConfig(config, path) {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

function validateWorkerName(value) {
  if (value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error("DEPLOY_WORKER_NAME must be 1–63 lowercase letters, digits, or internal hyphens");
  }
}

function validateHostname(value, variableName) {
  const labels = value.toLowerCase().split(".");
  if (
    value.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`${variableName} must be a public DNS hostname without a scheme, path, port, or trailing dot`);
  }
}

function validateDatabaseName(value) {
  if (value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error("DEPLOY_D1_DATABASE_NAME must be 1–63 lowercase letters, digits, or internal hyphens");
  }
}

function validateDatabaseId(value) {
  const trackedPlaceholder = "00000000-0000-0000-0000-000000000001";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    value.toLowerCase() === trackedPlaceholder ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  ) {
    throw new Error("DEPLOY_D1_DATABASE_ID must be a real D1 UUID, not the tracked placeholder");
  }
}

function validateAccountId(value) {
  if (!/^[0-9a-f]{32}$/i.test(value)) {
    throw new Error("DEPLOY_ACCOUNT_ID must be a 32-character hexadecimal Cloudflare account ID");
  }
}

function validateCompatibilityDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("DEPLOY_COMPATIBILITY_DATE must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("DEPLOY_COMPATIBILITY_DATE must be a real calendar date");
  }
}
