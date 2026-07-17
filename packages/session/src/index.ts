import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeEvent } from "@forge/events";
import type { ModelMessage } from "@forge/types";

export interface StoredSession {
  id: string;
  task: string;
  repositoryPath: string;
  plan?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  messages?: ModelMessage[];
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export class SessionStore {
  constructor(private readonly repositoryPath: string) {}

  private getSessionsDir(): string {
    const base = process.env.FORGE_CLI_ROOT || this.repositoryPath;
    return join(base, ".forge", "sessions");
  }

  async save(session: StoredSession): Promise<void> {
    const directory = this.getSessionsDir();
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      "utf8",
    );
  }

  async load(id: string): Promise<StoredSession> {
    const raw = JSON.parse(await readFile(join(this.getSessionsDir(), `${id}.json`), "utf8"));
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.task !== "string" ||
      typeof raw.repositoryPath !== "string" ||
      typeof raw.createdAt !== "string" ||
      typeof raw.updatedAt !== "string" ||
      (raw.messages !== undefined && !Array.isArray(raw.messages)) ||
      (raw.totalInputTokens !== undefined && typeof raw.totalInputTokens !== "number") ||
      (raw.totalOutputTokens !== undefined && typeof raw.totalOutputTokens !== "number")
    ) {
      throw new Error(
        `Session file for "${id}" is missing required fields (id, task, repositoryPath, createdAt, updatedAt) or is malformed.`,
      );
    }
    return raw as StoredSession;
  }

  async list(): Promise<StoredSession[]> {
    const directory = this.getSessionsDir();
    const files = await readdir(directory).catch(() => []);
    const jsonFiles = files.filter(
      (file) => file.endsWith(".json") && !file.endsWith(".events.jsonl"),
    );

    const results = await Promise.allSettled(jsonFiles.map((file) => this.load(file.slice(0, -5))));

    const sessions: StoredSession[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        sessions.push(result.value);
      } else {
        console.warn(`[SessionStore] Failed to load session file: ${String(result.reason)}`);
      }
    }
    return sessions;
  }

  async appendEvent(id: string, event: ForgeEvent): Promise<void> {
    const directory = this.getSessionsDir();
    await mkdir(directory, { recursive: true });
    const eventLine = `${JSON.stringify(event)}\n`;
    await appendFile(join(directory, `${id}.events.jsonl`), eventLine, "utf8");
  }

  async getEvents(id: string): Promise<ForgeEvent[]> {
    const directory = this.getSessionsDir();
    try {
      const content = await readFile(join(directory, `${id}.events.jsonl`), "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ForgeEvent);
    } catch {
      return [];
    }
  }
}
