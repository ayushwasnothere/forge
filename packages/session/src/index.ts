import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeEvent } from "@forge/events";
import type { ModelMessage } from "@forge/types";

export interface StoredSession {
  id: string;
  task: string;
  plan: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
  messages?: ModelMessage[];
}

export class SessionStore {
  constructor(private readonly repositoryPath: string) {}

  private getSessionsDir(): string {
    return join(this.repositoryPath, ".forge", "sessions");
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
    return JSON.parse(
      await readFile(join(this.getSessionsDir(), `${id}.json`), "utf8"),
    ) as StoredSession;
  }

  async list(): Promise<StoredSession[]> {
    const directory = this.getSessionsDir();
    const files = await readdir(directory).catch(() => []);
    return Promise.all(
      files
        .filter((file) => file.endsWith(".json") && !file.endsWith(".events.jsonl"))
        .map((file) => this.load(file.slice(0, -5))),
    );
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
