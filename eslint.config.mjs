import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "web/assets/cad/generated/**",
      "web/assets/pptist/generated/**",
      "web/assets/math/generated/**",
      "web/assets/markdown/generated/**",
      "release/**",
      ".tmp/**",
      "agents/**",
      "test-results/**"
    ]
  },
  {
    files: ["web/**/*.js", "desktop/**/*.cjs", "scripts/**/*.mjs", "e2e/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    files: ["src/**/*.ts", ".pi/**/*.ts"],
    languageOptions: { parser: tseslint.parser, globals: globals.node },
    rules: {
      "no-debugger": "error",
      "no-constant-condition": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      "@typescript-eslint/no-explicit-any": "error"
    },
    plugins: { "@typescript-eslint": tseslint.plugin }
  },
  {
    files: ["src/dashboard/*routes.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: ["node:child_process", "../runtime/process-host.js"], patterns: ["**/cli/**"] }
      ]
    }
  },
  {
    files: ["src/dashboard/run-service.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: ["node:http", "./http.js"], patterns: ["**/cli/**"] }]
    }
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/cli/**", "src/dashboard/*routes.ts", "src/dashboard/run-service.ts", "src/gui/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/cli/**"] }]
    }
  },
  {
    files: ["src/runtime/**/*.ts", "src/applications/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/cli/**", "**/dashboard/**"] }]
    }
  },
  {
    files: [".pi/extensions/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: ["../../src/**", "../../dist/**"] }] }
  },
  {
    files: ["src/gui/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["**/applications/**", "**/dashboard/**", "**/cli/**"] }]
    }
  },
  {
    files: [
      "src/dashboard/**/*.ts",
      "src/software/**/*.ts",
      "src/gui/**/*.ts",
      "src/security/**/*.ts",
      ".pi/runtime/**/*.ts",
      "desktop/**/*.cjs",
      "web/assets/controllers/**/*.js"
    ],
    rules: { "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }] }
  }
];
