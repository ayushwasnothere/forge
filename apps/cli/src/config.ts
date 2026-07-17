import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelPricing } from "@forge/models";

export interface ForgeConfig {
  tools?: string[];
  pricing?: Record<string, ModelPricing>;
}

export interface GlobalForgeConfig {
  forgePath?: string;
  defaultPermissions?: ("read" | "write" | "execute")[];
}

export async function loadConfig(root: string): Promise<ForgeConfig> {
  const configPath = join(root, "forge.config.json");
  const content = await readFile(configPath, "utf8").catch(() => null);
  if (!content) return {};

  try {
    return JSON.parse(content) as ForgeConfig;
  } catch (err) {
    console.warn(
      `⚠️ Failed to parse forge.config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

export async function loadGlobalConfig(): Promise<GlobalForgeConfig> {
  const configPath = join(homedir(), ".forge", "config.json");
  const content = await readFile(configPath, "utf8").catch(() => null);
  if (!content) return {};

  try {
    return JSON.parse(content) as GlobalForgeConfig;
  } catch (err) {
    console.warn(
      `⚠️ Failed to parse global config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}
