#!/usr/bin/env bun

import { AgentRuntime } from "@forge/runtime";
import { Command } from "commander";

const program = new Command();

program
  .name("forge")
  .description("A modular, terminal-first AI coding-agent runtime")
  .version("0.1.0")
  .action(() => {
    const runtime = new AgentRuntime();
    console.log(`Forge v0.1.0\n\n${runtime.statusMessage()}`);
  });

program.parse();
