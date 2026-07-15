import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { EventBus } from "@forge/events";
import type { Session, Task } from "@forge/types";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";
export type CheckStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface HealthReport {
  status: HealthStatus;
  checkedAt: Date;
  checks: readonly HealthCheck[];
}

export class AgentRuntime {
  readonly events = new EventBus();
  private session: Session | undefined;
  private task: Task | undefined;

  statusMessage(): string {
    if (!this.session) {
      return "No session active.";
    }

    if (!this.task) {
      return `Session ${this.session.id} is ready.`;
    }

    return `Task is ${this.task.status}.`;
  }

  async healthCheck(repositoryPath: string): Promise<HealthReport> {
    const checks: HealthCheck[] = [
      { name: "runtime", status: "pass", detail: "Forge runtime is initialized." },
      configurationCheck(process.env),
      await gitRepositoryCheck(repositoryPath),
    ];
    return {
      status: aggregateHealth(checks),
      checkedAt: new Date(),
      checks,
    };
  }
}

export function aggregateHealth(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "unhealthy";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "degraded";
  }
  return "healthy";
}

export function configurationCheck(env: NodeJS.ProcessEnv = process.env): HealthCheck {
  const missing: string[] = [];
  if (!env.FORGE_API_KEY) missing.push("FORGE_API_KEY");
  if (!env.FORGE_MODEL) missing.push("FORGE_MODEL");

  if (missing.length === 0) {
    return {
      name: "configuration",
      status: "pass",
      detail: "Forge API key and model are configured.",
    };
  }
  return {
    name: "configuration",
    status: "warn",
    detail: `Missing environment variables: ${missing.join(", ")}.`,
  };
}

async function gitRepositoryCheck(repositoryPath: string): Promise<HealthCheck> {
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repositoryPath,
    });
    if (stdout.trim() !== "true") throw new Error("Not a Git work tree.");
    return {
      name: "git",
      status: "pass",
      detail: "Current directory is a Git repository.",
    };
  } catch {
    return {
      name: "git",
      status: "warn",
      detail: "Current directory is not a Git repository.",
    };
  }
}

export async function detectTestCommand(repositoryPath: string): Promise<string> {
  const exists = async (path: string) =>
    stat(join(repositoryPath, path))
      .then(() => true)
      .catch(() => false);

  if (await exists("package.json")) {
    try {
      const packageJsonContent = await readFile(join(repositoryPath, "package.json"), "utf8");
      const pkg = JSON.parse(packageJsonContent);
      if (pkg.scripts?.test) {
        if ((await exists("bun.lockb")) || (await exists("bun.lock"))) {
          return "bun run test";
        }
        if (await exists("yarn.lock")) {
          return "yarn test";
        }
        if (await exists("pnpm-lock.yaml")) {
          return "pnpm test";
        }
        if (await exists("package-lock.json")) {
          return "npm test";
        }
        return "npm test";
      }
    } catch {}
  }
  if (await exists("Cargo.toml")) {
    return "cargo test";
  }
  if (await exists("go.mod")) {
    return "go test ./...";
  }
  if (
    (await exists("pyproject.toml")) ||
    (await exists("requirements.txt")) ||
    (await exists("Pipfile"))
  ) {
    return "pytest";
  }
  return "bun run test";
}

export { DockerSandboxRunner } from "./sandbox";
