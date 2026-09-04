import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const serverRoot = fileURLToPath(new URL('../', import.meta.url));

export function testInvocation(extraArgs = [], inheritedEnv = process.env) {
  const files = readdirSync(path.join(serverRoot, 'test'))
    .filter(name => name.endsWith('.test.mjs')).sort()
    .map(name => path.join('test', name));
  if (!files.length) throw new Error('No server test files discovered');
  return {
    command: process.execPath,
    args: ['--test', '--no-warnings', '--test-concurrency=4', ...extraArgs, ...files],
    options: {
      cwd: serverRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...inheritedEnv,
        NANOWORK_TEST_TEMPLATE_AI: '1',
        NANOWORK_DB: ':memory:',
        NODE_ENV: 'test',
        ENABLE_SCHEDULER: 'false',
        ENABLE_BACKGROUND_EMBEDDINGS: 'false',
        YUNWU_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        // CLI test entrypoints are supplied by each isolated fixture only.
        CONTENTCREW_CLAUDE_PATH: '',
      },
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const invocation = testInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options, stdio: 'inherit',
  });
  child.once('error', error => {
    console.error(`Server test runner failed to start: ${error.code || error.name}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}
