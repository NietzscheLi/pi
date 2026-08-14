import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const BALANCE_CONFIG_FILE_NAME = "balance-config.yaml";
export const PRESETS_CONFIG_FILE_NAME = "presets.yml";

const BALANCE_CONFIG_TEMPLATE = `# Provider balance query configuration.
# Add entries under providers whose names exactly match configured provider IDs.
refreshIntervalMinutes: 5

# Anchor each protocol profile and reference it directly from providers.
profiles:
  newapi: &newapi
    request:
      url: "{{baseUrl}}/api/user/self"
      method: GET
      headers:
        Accept: application/json
        Authorization: "Bearer {{accessToken}}"
        New-Api-User: "{{userId}}"
      timeoutSeconds: 10
    extractor:
      remainingPath: data.quota
      validity:
        allTruthy: [success, data]
      errorPath: message
      errorFallback: Balance query failed

  sub2api: &sub2api
    request:
      url: "{{baseUrl}}/v1/usage"
      method: GET
      headers:
        Accept: application/json
        Authorization: "Bearer {{apiKey}}"
      timeoutSeconds: 10
    extractor:
      remainingPath: remaining
      validity:
        firstDefined: [is_active, isValid]
        fallback: true
      errorFallback: Balance query failed

  deepseek-official: &deepseek-official
    request:
      baseUrl: https://api.deepseek.com
      url: "{{baseUrl}}/user/balance"
      method: GET
      headers:
        Accept: application/json
        Authorization: "Bearer {{apiKey}}"
      timeoutSeconds: 10
    extractor:
      remainingPath: balance_infos.0.total_balance
      unitPath: balance_infos.0.currency
      validity:
        path: is_available
        fallback: true
      errorFallback: Insufficient balance

providers:
  # DeepSeek:
  #   profile: *deepseek-official
  # Example-NewAPI:
  #   profile: *newapi
  #   request:
  #     baseUrl: https://api.example.com
  #   credentials:
  #     accessToken: replace-me
  #     userId: replace-me
  #   extractor:
  #     divideBy: 500000
  #     unit: CNY
`;

const PRESETS_CONFIG_TEMPLATE = `# Named settings and resource presets.
# Resource paths are resolved relative to the agent directory.
version: 1
# Anchor resource IDs in their registries, then use aliases in preset enable/disable lists.
resources:
  # skills:
  #   &skill-example example: ./preset-resources/skills/example
  # mcp:
  #   - &mcp-example example
  # extensions:
  #   &extension-example example: ./preset-runtime/example.ts
  # packages:
  #   &package-example example: npm:@example/pi-package@1.0.0
base:
  settings: {}
presets:
  # Example:
  #   enable:
  #     skills: [*skill-example]
  #     mcp: [*mcp-example]
  #     extensions: [*extension-example]
  #     packages: [*package-example]
`;

function writeIfMissing(path: string, content: string): void {
	try {
		writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/** Initialize user-owned templates without changing existing configuration. */
export function initializeDefaultConfigFiles(agentDir = getAgentDir()): void {
	mkdirSync(agentDir, { recursive: true });
	writeIfMissing(join(agentDir, BALANCE_CONFIG_FILE_NAME), BALANCE_CONFIG_TEMPLATE);
	writeIfMissing(join(agentDir, PRESETS_CONFIG_FILE_NAME), PRESETS_CONFIG_TEMPLATE);
}
