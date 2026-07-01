// Flat ESLint config (ESLint v9). Type-aware linting for the TypeScript sources,
// with Prettier turned off as a linter so formatting is owned solely by Prettier.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Build output, deps, and lockfiles are never linted.
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    // Plain Node scripts, the Vercel functions, and this config file: declare the
    // Node globals they use (TypeScript resolves these via @types/node, but raw JS
    // needs them spelled out).
    files: ["scripts/**/*.{js,mjs}", "api/**/*.mjs", "*.{js,mjs}"],
    languageOptions: {
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", fetch: "readonly" },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // `bigint`/on-chain code occasionally needs deliberate any at ABI boundaries;
      // keep it a warning so it surfaces in review without failing CI on intent.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow intentionally-unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off", // this is a CLI — stdout/stderr are the product
      eqeqeq: ["error", "smart"],
    },
  },
  {
    // Test files: a little more latitude for fixtures and assertions.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Must be last: disables stylistic rules that would conflict with Prettier.
  prettier,
);
