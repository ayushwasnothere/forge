import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryData {
  facts: Record<string, string>;
  updatedAt: string;
}

function getMemoryPath(repositoryPath: string): string {
  const base = process.env.FORGE_CLI_ROOT || repositoryPath;
  return join(base, ".forge", "memory.json");
}

export const MemoryStore = {
  async load(repositoryPath: string): Promise<Record<string, string>> {
    const memoryPath = getMemoryPath(repositoryPath);
    try {
      const content = await readFile(memoryPath, "utf8");
      const parsed = JSON.parse(content);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof parsed.facts !== "object" ||
        parsed.facts === null ||
        Array.isArray(parsed.facts)
      ) {
        return {};
      }
      const data = parsed as MemoryData;
      return data.facts ?? {};
    } catch {
      return {};
    }
  },

  async remember(
    repositoryPath: string,
    key: string,
    value: string,
  ): Promise<Record<string, string>> {
    const memoryPath = getMemoryPath(repositoryPath);
    const facts = await this.load(repositoryPath);
    facts[key.trim()] = value.trim();

    const data: MemoryData = {
      facts,
      updatedAt: new Date().toISOString(),
    };

    // Ensure directory for memoryPath exists
    const base = process.env.FORGE_CLI_ROOT || repositoryPath;
    await mkdir(join(base, ".forge"), { recursive: true }).catch(() => {});
    await writeFile(memoryPath, JSON.stringify(data, null, 2), "utf8");
    return facts;
  },

  async forget(repositoryPath: string, key: string): Promise<Record<string, string>> {
    const memoryPath = getMemoryPath(repositoryPath);
    const facts = await this.load(repositoryPath);
    delete facts[key.trim()];

    const data: MemoryData = {
      facts,
      updatedAt: new Date().toISOString(),
    };

    // Ensure directory for memoryPath exists
    const base = process.env.FORGE_CLI_ROOT || repositoryPath;
    await mkdir(join(base, ".forge"), { recursive: true }).catch(() => {});
    await writeFile(memoryPath, JSON.stringify(data, null, 2), "utf8");
    return facts;
  },
};
