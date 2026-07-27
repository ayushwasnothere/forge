import { confirm, isCancel, log, select, text } from "@clack/prompts";
import type { ProviderKind } from "@forge/models";
import { type GlobalForgeConfig, loadGlobalConfig, saveGlobalConfig } from "./config";

export async function runConfigWizard(): Promise<GlobalForgeConfig> {
  const config = await loadGlobalConfig();

  config.providers = config.providers ?? {};
  config.models = config.models ?? {};

  log.info("⚙️  Forge Setup & Configuration Wizard");

  const action = await select({
    message: "What would you like to configure?",
    options: [
      { value: "provider", label: "Add or edit a Provider (API Key & Endpoint)" },
      { value: "model", label: "Add or edit a Model Alias" },
      { value: "default", label: "Set Default Model Alias" },
      { value: "view", label: "View Current Configuration" },
      { value: "exit", label: "Done / Exit Setup" },
    ],
  });

  if (isCancel(action) || action === "exit") {
    return config;
  }

  if (action === "view") {
    log.info(JSON.stringify(config, null, 2));
    return runConfigWizard();
  }

  if (action === "provider") {
    const configuredKeys = Object.keys(config.providers ?? {});
    const standardKeys = ["openrouter", "openai", "anthropic", "groq", "grok", "gemini", "ollama"];
    const customKeys = configuredKeys.filter((k) => !standardKeys.includes(k));

    const providerOptions = [
      { value: "openrouter", label: "OpenRouter" },
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "groq", label: "Groq" },
      { value: "grok", label: "Grok (xAI)" },
      { value: "gemini", label: "Google Gemini" },
      { value: "ollama", label: "Ollama (Local)" },
      ...customKeys.map((k) => ({
        value: k,
        label: `${k} (Custom ${config.providers?.[k]?.type ?? "openai"})`,
      })),
      { value: "__custom_provider__", label: "➕ Custom Provider (OpenAI or Anthropic)..." },
    ];

    const provider = (await select({
      message: "Select provider to configure",
      options: providerOptions,
    })) as ProviderKind | symbol;

    if (isCancel(provider)) return config;

    let pName = provider as string;
    if (pName === "__custom_provider__") {
      const created = await configureCustomProvider(config);
      if (!created) return config;
      pName = created;
    } else if (!customKeys.includes(pName)) {
      const existing = config.providers[pName] ?? {};

      let apiKey = existing.apiKey ?? "";
      if (pName !== "ollama") {
        const keyInput = await text({
          message: `API Key for ${pName}`,
          defaultValue:
            existing.apiKey ?? process.env[`FORGE_${pName.toUpperCase()}_API_KEY`] ?? "",
          placeholder: "paste key here",
        });
        if (isCancel(keyInput)) return config;
        apiKey = String(keyInput).trim();
      }

      const defaultUrl =
        pName === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : pName === "openai"
            ? "https://api.openai.com/v1"
            : pName === "anthropic"
              ? "https://api.anthropic.com/v1"
              : pName === "groq"
                ? "https://api.groq.com/openai/v1"
                : pName === "grok"
                  ? "https://api.x.ai/v1"
                  : pName === "gemini"
                    ? "https://generativelanguage.googleapis.com/v1beta/openai"
                    : "http://localhost:11434/v1";

      const urlInput = await text({
        message: `Base URL for ${pName} (optional)`,
        defaultValue: existing.baseUrl ?? defaultUrl,
        placeholder: defaultUrl,
      });
      if (isCancel(urlInput)) return config;
      const baseUrl = String(urlInput).trim();

      config.providers[pName] = {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl !== defaultUrl ? { baseUrl } : {}),
      };

      await saveGlobalConfig(config);
      log.success(`✅ Configured provider "${pName}"`);
    }
    return runConfigWizard();
  }

  if (action === "model") {
    await addModelAliasWizard(config);
    return runConfigWizard();
  }

  if (action === "default") {
    const aliases = Object.keys(config.models);
    if (aliases.length === 0) {
      log.warn("No model aliases configured yet. Create a model alias first.");
      return runConfigWizard();
    }

    const chosen = await select({
      message: "Select default model alias",
      options: aliases.map((a) => ({
        value: a,
        label: `${a} (${config.models?.[a]?.provider}/${config.models?.[a]?.model})`,
      })),
      initialValue: config.defaultModel,
    });

    if (isCancel(chosen)) return config;

    config.defaultModel = String(chosen);
    await saveGlobalConfig(config);
    log.success(`✅ Set default model alias to "${config.defaultModel}"`);
    return runConfigWizard();
  }

  return config;
}

async function configureCustomProvider(config: GlobalForgeConfig): Promise<string | null> {
  const nameInput = await text({
    message: "Enter custom provider identifier/name (e.g. agentrouter, litellm, azure)",
    placeholder: "e.g., agentrouter",
  });
  if (isCancel(nameInput)) return null;
  const providerName = String(nameInput).trim();
  if (!providerName) {
    log.error("Provider name cannot be empty.");
    return null;
  }

  const apiType = await select({
    message: `Select API protocol type for "${providerName}"`,
    options: [
      { value: "openai", label: "OpenAI-compatible REST API (standard /chat/completions)" },
      { value: "anthropic", label: "Anthropic-compatible REST API (standard /v1/messages)" },
    ],
  });
  if (isCancel(apiType)) return null;
  const type = String(apiType) as "openai" | "anthropic";

  const urlInput = await text({
    message: `Base URL / Endpoint for "${providerName}" (e.g. https://agentrouter.org/v1)`,
    placeholder: "https://your-custom-endpoint.com/v1",
  });
  if (isCancel(urlInput)) return null;
  const baseUrl = String(urlInput).trim();
  if (!baseUrl) {
    log.error("Base URL cannot be empty.");
    return null;
  }

  const existing = config.providers?.[providerName];
  const keyInput = await text({
    message: `API Key for "${providerName}" (optional if local)`,
    defaultValue: existing?.apiKey ?? "",
    placeholder: "paste key here",
  });
  if (isCancel(keyInput)) return null;
  const apiKey = String(keyInput).trim();

  config.providers = config.providers ?? {};
  config.providers[providerName] = {
    type,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  };

  await saveGlobalConfig(config);
  log.success(`✅ Saved custom provider "${providerName}" (${type}-compatible -> ${baseUrl})`);
  return providerName;
}

export async function addModelAliasWizard(config: GlobalForgeConfig): Promise<string | null> {
  config.models = config.models ?? {};
  config.providers = config.providers ?? {};

  const aliasInput = await text({
    message: "Enter new model alias name (e.g., sonnet, opus, fast, local)",
    placeholder: "e.g., sonnet",
  });
  if (isCancel(aliasInput)) return null;
  const alias = String(aliasInput).trim();

  if (!alias) {
    log.error("Alias cannot be empty.");
    return null;
  }

  const configuredKeys = Object.keys(config.providers ?? {});
  const standardKeys = ["openrouter", "openai", "anthropic", "groq", "grok", "gemini", "ollama"];
  const customKeys = configuredKeys.filter((k) => !standardKeys.includes(k));

  const providerOptions = [
    { value: "openrouter", label: "OpenRouter" },
    { value: "openai", label: "OpenAI" },
    { value: "anthropic", label: "Anthropic" },
    { value: "groq", label: "Groq" },
    { value: "grok", label: "Grok (xAI)" },
    { value: "gemini", label: "Google Gemini" },
    { value: "ollama", label: "Ollama (Local)" },
    ...customKeys.map((k) => ({
      value: k,
      label: `${k} (Custom ${config.providers?.[k]?.type ?? "openai"})`,
    })),
    { value: "__custom_provider__", label: "➕ Custom Provider (OpenAI or Anthropic)..." },
  ];

  const provider = (await select({
    message: `Select provider for alias "${alias}"`,
    options: providerOptions,
  })) as ProviderKind | symbol;

  if (isCancel(provider)) return null;

  let pName = provider as string;
  if (pName === "__custom_provider__") {
    const created = await configureCustomProvider(config);
    if (!created) return null;
    pName = created;
  }

  if (pName !== "ollama" && !customKeys.includes(pName)) {
    const envVar = `FORGE_${pName.toUpperCase()}_API_KEY`;
    const existingKey =
      config.providers[pName]?.apiKey ?? process.env[envVar] ?? process.env.FORGE_API_KEY ?? "";
    const keyInput = await text({
      message: `Enter API Key for provider "${pName}" (prefilled with ${envVar} if set)`,
      defaultValue: existingKey,
      placeholder: existingKey ? "••••••••" : "paste key here",
    });
    if (isCancel(keyInput)) return null;
    const apiKey = String(keyInput).trim();
    if (apiKey) {
      config.providers[pName] = {
        ...config.providers[pName],
        apiKey,
      };
    }
  }

  const defaultModel =
    pName === "openrouter"
      ? "anthropic/claude-sonnet-4"
      : pName === "openai"
        ? "gpt-4o"
        : pName === "anthropic"
          ? "claude-3-5-sonnet-20241022"
          : pName === "groq"
            ? "llama-3.3-70b-versatile"
            : pName === "grok"
              ? "grok-beta"
              : pName === "gemini"
                ? "gemini-2.5-flash"
                : "llama3";

  const modelInput = await text({
    message: `Model ID/name for provider "${pName}"`,
    defaultValue: defaultModel,
    placeholder: defaultModel,
  });
  if (isCancel(modelInput)) return null;
  const model = String(modelInput).trim();

  config.models[alias] = {
    provider: pName,
    model,
  };

  if (!config.defaultModel) {
    config.defaultModel = alias;
  }

  await saveGlobalConfig(config);
  log.success(`✅ Saved new model alias "${alias}" (${pName}/${model}) to config.`);
  return alias;
}
