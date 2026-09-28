export const CONTAINER_TENANT_ROOT = '/tenant';
export const CONTAINER_WORKSPACE = `${CONTAINER_TENANT_ROOT}/workspace`;
export const CONTAINER_STATE_DIR = `${CONTAINER_TENANT_ROOT}/openclaw`;
export const CONTAINER_CLAUDE_HOME = `${CONTAINER_TENANT_ROOT}/cli-home/claude`;
export const CONTAINER_SYNCED_SKILLS = `${CONTAINER_CLAUDE_HOME}/skills/synced`;
export const CONTAINER_ORG_DIR = '/org';
export const CONTAINER_HOME = `${CONTAINER_STATE_DIR}/.home`;
// These two live INSIDE the image: `docker/openclaw/entrypoint.sh` creates and
// reads them, so they are part of the image contract. Host and image must agree
// exactly — the entrypoint swallows ENOENT on the projection, so a mismatch
// starts a container with no MCP servers at all and says nothing.
// `assertImageContract()` is what keeps the two ends honest.
export const CONTAINER_RUNTIME_DIR = '/run/rocky';
export const CONTAINER_CONFIG_PATH = `${CONTAINER_RUNTIME_DIR}/openclaw.json`;
export const CONTAINER_MCP_INPUT_DIR = '/run/rocky-input';
export const CONTAINER_MCP_PROJECTION = `${CONTAINER_MCP_INPUT_DIR}/composio.json`;
