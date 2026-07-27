import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelPricing, ProviderKind } from "@forge/models";

export interface ForgeConfig {
  tools?: string[];
  pricing?: Record<string, ModelPricing>;
}

// ---------------------------------------------------------------------------
// Provider & Model entries for multi-model configuration
// ---------------------------------------------------------------------------

export interface ProviderEntry {
  type?: "openai" | "anthropic";
  apiKey?: string;
  baseUrl?: string;
}

export interface ModelEntry {
  provider: ProviderKind;
  model: string;
  maxTokens?: number;
}

export interface ResolvedModel {
  provider: ProviderKind;
  type?: "openai" | "anthropic";
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface GlobalForgeConfig {
  providers?: Record<string, ProviderEntry>;
  models?: Record<string, ModelEntry>;
  defaultModel?: string;
  forgePath?: string;
  defaultPermissions?: ("read" | "write" | "execute")[];
}

// ---------------------------------------------------------------------------
// Local project config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Global config (~/.forge/config.json)
// ---------------------------------------------------------------------------

function globalConfigPath(): string {
  return join(homedir(), ".forge", "config.json");
}

export async function loadGlobalConfig(): Promise<GlobalForgeConfig> {
  const content = await readFile(globalConfigPath(), "utf8").catch(() => null);
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

export async function saveGlobalConfig(config: GlobalForgeConfig): Promise<void> {
  const configPath = globalConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Model resolution — resolves an alias or raw model name to a full config
// ---------------------------------------------------------------------------

/**
 * Resolve a model alias or raw model name into a complete provider config.
 *
 * Priority:
 * 1. If `aliasOrName` matches a key in `config.models`, use that entry
 * 2. Otherwise treat `aliasOrName` as a raw model name for `fallbackProvider`
 * 3. API key comes from: model's provider entry → env `FORGE_API_KEY`
 * 4. Base URL comes from: provider entry → env `FORGE_BASE_URL`
 */
function resolveApiKey(config: GlobalForgeConfig, provider: ProviderKind): string | undefined {
  const providerEntry = config.providers?.[provider];
  if (providerEntry?.apiKey) return providerEntry.apiKey;
  const envVar = `FORGE_${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  if (process.env[envVar]) return process.env[envVar];
  if (provider === "gemini" && process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;

  const envProvider = process.env.FORGE_PROVIDER || "openrouter";
  if (process.env.FORGE_API_KEY && envProvider === provider) {
    return process.env.FORGE_API_KEY;
  }
  return undefined;
}

function resolveBaseUrl(config: GlobalForgeConfig, provider: ProviderKind): string | undefined {
  const providerEntry = config.providers?.[provider];
  if (providerEntry?.baseUrl) return providerEntry.baseUrl;

  const envProvider = process.env.FORGE_PROVIDER || "openrouter";
  if (process.env.FORGE_BASE_URL && envProvider === provider) {
    return process.env.FORGE_BASE_URL;
  }
  return undefined;
}

export function resolveModel(
  config: GlobalForgeConfig,
  aliasOrName: string,
  fallbackProvider?: ProviderKind,
): ResolvedModel {
  const modelEntry = config.models?.[aliasOrName];

  if (modelEntry) {
    // Matched a configured alias
    const providerEntry = config.providers?.[modelEntry.provider];
    const apiKey = resolveApiKey(config, modelEntry.provider);
    const baseUrl = resolveBaseUrl(config, modelEntry.provider);
    return {
      provider: modelEntry.provider,
      ...(providerEntry?.type ? { type: providerEntry.type } : {}),
      model: modelEntry.model,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }

  // No alias match — treat as raw model name
  const provider = fallbackProvider ?? (process.env.FORGE_PROVIDER as ProviderKind) ?? "openrouter";
  const providerEntry = config.providers?.[provider];
  const apiKey = resolveApiKey(config, provider);
  const baseUrl = resolveBaseUrl(config, provider);
  return {
    provider,
    ...(providerEntry?.type ? { type: providerEntry.type } : {}),
    model: aliasOrName,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Determine the initial model to use at startup.
 *
 * Priority:
 * 1. CLI `--model` flag (not yet wired — reserved for future use)
 * 2. `config.defaultModel` alias
 * 3. `FORGE_MODEL` env var
 * 4. undefined (caller should prompt or error)
 */
export function getDefaultModelAlias(config: GlobalForgeConfig): string | undefined {
  if (config.defaultModel) return config.defaultModel;
  return process.env.FORGE_MODEL ?? undefined;
}
