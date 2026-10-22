import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const layer = (files, forbidden) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: forbidden,
            message: "Layer violation: see docs/architecture.md (Allowed imports).",
          },
        ],
      },
    ],
  },
});

const ALL = [
  "**/infra/**",
  "**/store/**",
  "**/snapshot/**",
  "**/history/**",
  "**/runtime/**",
  "**/session/**",
  "**/host/**",
  "**/extension.js",
  "**/index.js",
];
const above = (...allowed) => ALL.filter((p) => !allowed.includes(p));

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-console": "warn",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  layer(["src/types.ts", "src/host-contract.ts"], ALL),
  layer(["src/infra/**/*.ts"], above()),
  layer(["src/store/**/*.ts"], above("**/infra/**")),
  layer(["src/snapshot/**/*.ts"], above("**/infra/**", "**/store/**")),
  layer(["src/history/**/*.ts"], above("**/infra/**", "**/store/**")),
  layer(["src/runtime/**/*.ts"], above("**/infra/**")),
  layer(["src/session/**/*.ts"], ["**/host/**", "**/extension.js", "**/index.js"]),
  // host/ reaches session logic only through the SessionRegistry.
  layer(
    ["src/host/**/*.ts"],
    [
      "**/extension.js",
      "**/index.js",
      "**/session/**",
      "!**/session/registry.js",
      "!**/session/services.js",
      "!**/session/navigation.js",
    ],
  ),
  {
    files: ["src/host/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/session/services.js", "**/session/navigation.js"],
              allowTypeImports: true,
              message: "host/ imports only types from these: see docs/architecture.md.",
            },
          ],
        },
      ],
    },
  },
];
