import type { ComponentType } from "react";
import Commands from "./content/commands.mdx";
import Configuration from "./content/configuration.mdx";
import CustomTools from "./content/custom-tools.mdx";
import GettingStarted from "./content/getting-started.mdx";
import Permissions from "./content/permissions.mdx";
import Providers from "./content/providers.mdx";
import Repl from "./content/repl.mdx";
import Sessions from "./content/sessions.mdx";

export type DocGroup = "Guide" | "Reference";
export interface DocMeta {
  slug: string;
  title: string;
  group: DocGroup;
  Component: ComponentType;
}

export const docs: DocMeta[] = [
  { slug: "getting-started", title: "Getting Started", group: "Guide", Component: GettingStarted },
  { slug: "configuration", title: "Configuration", group: "Guide", Component: Configuration },
  { slug: "commands", title: "CLI Commands", group: "Guide", Component: Commands },
  { slug: "repl", title: "Interactive REPL", group: "Guide", Component: Repl },
  { slug: "permissions", title: "Permissions", group: "Reference", Component: Permissions },
  { slug: "sessions", title: "Sessions", group: "Reference", Component: Sessions },
  { slug: "custom-tools", title: "Custom Tools", group: "Reference", Component: CustomTools },
  { slug: "providers", title: "Providers", group: "Reference", Component: Providers },
];

export function getDoc(slug: string): DocMeta | undefined {
  return docs.find((d) => d.slug === slug);
}
