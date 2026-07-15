import { spawn } from "node:child_process";
import type { SandboxRunner } from "@forge/types";

export interface DockerSandboxOptions {
  image?: string;
  fallbackToHost?: boolean;
}

export class DockerSandboxRunner implements SandboxRunner {
  private readonly image: string;
  private readonly fallbackToHost: boolean;
  private isDockerAvailable: boolean | undefined;

  constructor(options: DockerSandboxOptions = {}) {
    this.image = options.image ?? "node:20-alpine";
    this.fallbackToHost = options.fallbackToHost ?? true;
  }

  async checkDocker(): Promise<boolean> {
    if (this.isDockerAvailable !== undefined) return this.isDockerAvailable;
    try {
      this.isDockerAvailable = await new Promise<boolean>((resolve) => {
        const proc = spawn("docker", ["--version"], { env: process.env });
        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });
    } catch {
      this.isDockerAvailable = false;
    }
    return this.isDockerAvailable;
  }

  async execute(
    command: string[],
    cwd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const hasDocker = await this.checkDocker();
    if (!hasDocker) {
      if (this.fallbackToHost) {
        console.warn("⚠️ Docker is not available. Falling back to host execution.");
        return executeOnHost(command, cwd, timeoutMs, signal);
      }
      throw new Error("Docker sandbox required but docker command not found on host.");
    }

    // Run command in a temporary docker container with current directory mounted
    // We mount cwd to /workspace and run the command there
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",
      this.image,
      ...command,
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn("docker", dockerArgs, { env: process.env });
      let stdout = "";
      let stderr = "";

      const kill = () => {
        proc.kill();
      };

      const timeout = timeoutMs
        ? setTimeout(() => {
            kill();
            reject(new Error(`Command timed out after ${timeoutMs / 1000} seconds.`));
          }, timeoutMs)
        : undefined;

      if (signal) {
        signal.addEventListener("abort", kill, { once: true });
      }

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (exitCode) => {
        if (timeout) clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", kill);
        resolve({ exitCode: exitCode ?? 0, stdout, stderr });
      });

      proc.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", kill);
        reject(err);
      });
    });
  }
}

async function executeOnHost(
  command: string[],
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0] as string, command.slice(1), { cwd, env: process.env });
    let stdout = "";
    let stderr = "";

    const kill = () => {
      proc.kill();
    };

    const timeout = timeoutMs
      ? setTimeout(() => {
          kill();
          reject(new Error(`Command timed out after ${timeoutMs / 1000} seconds.`));
        }, timeoutMs)
      : undefined;

    if (signal) {
      signal.addEventListener("abort", kill, { once: true });
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", kill);
      resolve({ exitCode: exitCode ?? 0, stdout, stderr });
    });

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", kill);
      reject(err);
    });
  });
}
