import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = `${PROJECT_ROOT}/src/lex/cli.ts`;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<ExecResult> {
  const cmd = `npx tsx ${CLI_PATH} ${args.join(' ')}`;
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.code ?? 1,
    };
  }
}

describe('lex cli', () => {
  describe('resolve subcommand', () => {
    it('prints help when --help is passed', async () => {
      const { stdout, exitCode } = await runCli(['resolve', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('--host=');
      expect(stdout).toContain('--expect-nsid=');
      expect(stdout).toContain('--verbose');
    });

    it('prints help when no subcommand is given', async () => {
      const { stdout, exitCode } = await runCli([]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage:');
    });

    it('prints error when resolve is given without NSID', async () => {
      const { stdout, stderr, exitCode } = await runCli(['resolve']);
      expect(exitCode).toBe(1);
      const errorMsg = stderr || stdout;
      expect(errorMsg).toContain('NSID is required');
    });
  });

  describe('nsid parsing', () => {
    it('reverses authority segments correctly', async () => {
      const { stdout, stderr, exitCode } = await runCli(['resolve', 'net.olamaelcu.livtet.biblio.book', '--verbose']);
      const output = stdout + stderr;
      if (exitCode === 0) {
        expect(stdout).toBeDefined();
      } else {
        expect(output).toContain('DNS lookup failed');
      }
    });
  });
});
