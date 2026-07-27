import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      ...mdx({
        providerImportSource: "@mdx-js/react",
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSlug],
      }),
    },
    react({ include: /\.(jsx|tsx|mdx|md)$/ }),
    tailwindcss(),
  ],
});
