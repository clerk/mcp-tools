import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Local scratch files and agent worktrees are not part of the suite
    exclude: [...configDefaults.exclude, '.scratch/**', '.claude/**'],
    typecheck: { enabled: true, ignoreSourceErrors: true },
  },
});
