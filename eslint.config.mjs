// eslint.config.mjs
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    files: ["**/*.js", "**/*.tsx"],
    languageOptions: {
        parser: tsParser,
        parserOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
},
  },
  // Apply TypeScript-specific rules
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
        "no-unused-vars": "warn",
        "no-undef": "warn",
        "no-console": "warn",
        "no-empty": "warn",
        "no-debugger": "warn",
        "no-alert": "warn",
        "no-eval": "warn",
        "no-implied-eval": "warn",
        "no-multi-str": "warn",
        "no-template-curly-in-string": "warn",
        "no-unreachable": "warn",
        "no-useless-escape": "warn",

      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      semi: ["warn", "always"],
      "prettier/prettier": "warn", // Integrate Prettier
    },
  },
];
