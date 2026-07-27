import { MDXProvider } from "@mdx-js/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Footer } from "./components/Footer";
import { mdxComponents } from "./components/mdx-components";
import { Navbar } from "./components/Navbar";
import { DocPage } from "./docs/DocPage";
import { DocsLayout } from "./docs/DocsLayout";
import { Landing } from "./landing/Landing";
import { NotFound } from "./NotFound";
import { ThemeProvider } from "./ThemeProvider";

export function App() {
  return (
    <ThemeProvider>
      <MDXProvider components={mdxComponents}>
        <BrowserRouter>
          <Navbar />
          <main>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/docs" element={<Navigate to="/docs/getting-started" replace />} />
              <Route path="/docs/:slug" element={<DocsLayout />}>
                <Route index element={<DocPage />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>
          <Footer />
        </BrowserRouter>
      </MDXProvider>
    </ThemeProvider>
  );
}
