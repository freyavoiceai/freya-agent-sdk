import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "docs/api/", "coverage/", "examples/"] },
  js.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { globals: { console: "readonly", process: "readonly" } } },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
