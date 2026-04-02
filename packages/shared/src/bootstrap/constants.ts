export const DEPLOYMENT_DATA_DIR = "/data";
export const DEPLOYMENT_SQLITE_PATH = `${DEPLOYMENT_DATA_DIR}/deal-pump.sqlite`;
export const DEPLOYMENT_ARTIFACTS_DIR = `${DEPLOYMENT_DATA_DIR}/artifacts`;

export const SQLITE_RUNTIME_GUARDS = {
  journal_mode: "wal",
  synchronous: 1,
  busy_timeout: 5000,
  foreign_keys: 1,
  trusted_schema: 0,
} as const;

export const MIN_SQLITE_VERSION = "3.51.3";
