// FE-C1 工程基线：先立门槛（error 级只留真 bug 类），存量风格问题降为 warn 逐步收敛。
// 运行：npm run lint（零 error 通过）；npm run lint:strict（warn 也拦，供 CI 收紧用）
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

// 无障碍规则以 warn 级启用（保留规则自带配置项，仅把严重级降为 warn）：
// 不阻塞 lint（npm run lint 仍零 error 通过），存量问题可见并逐步收敛。
const jsxA11yRecommendedAsWarn = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([rule, level]) => [
    rule,
    Array.isArray(level) ? ['warn', ...level.slice(1)] : 'warn',
  ]),
);

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'vite.config.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11yRecommendedAsWarn,
      // 存量代码大量使用 any：不在基线一次性清零，按文件迁移时收敛（见 src/api/types.ts）
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // 以下为存量问题降级（真实但非本次交付范围，保持可见逐步修）：
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/purity': 'warn',
      'no-irregular-whitespace': ['warn', { skipStrings: true, skipTemplates: true, skipJSXText: true }],
      'no-control-regex': 'warn',
    },
  },
);
