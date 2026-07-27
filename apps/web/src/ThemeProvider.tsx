import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { applyTheme, resolveInitialTheme, STORAGE_KEY, type Theme } from "./theme";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    resolveInitialTheme(
      typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
      typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
    ),
  );

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
