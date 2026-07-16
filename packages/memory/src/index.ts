import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryData {
  facts: Record<string, string>;
  updatedAt: string;
}

function getMemoryPath(repositoryPath: string): string {
  return join(repositoryPath, ".forge", "memory.json");
}

export const MemoryStore = {
  async load(repositoryPath: string): Promise<Record<string, string>> {
    const memoryPath = getMemoryPath(repositoryPath);
    try {
      const content = await readFile(memoryPath, "utf8");
      const data = JSON.parse(content) as MemoryData;
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

    // Ensure .forge directory exists
    await mkdir(join(repositoryPath, ".forge"), { recursive: true }).catch(() => {});
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

    await mkdir(join(repositoryPath, ".forge"), { recursive: true }).catch(() => {});
    await writeFile(memoryPath, JSON.stringify(data, null, 2), "utf8");
    return facts;
  },
};
