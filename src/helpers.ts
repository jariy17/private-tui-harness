import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTempDirOptions {
  /** Prefix for the temporary directory name. Defaults to 'tui-harness-test-'. */
  prefix?: string;
  /**
   * Files to create inside the temp directory.
   * Keys are relative paths, values are file contents.
   */
  files?: Record<string, string>;
}

export interface TempDirResult {
  dir: string;
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory, optionally pre-populated with files.
 *
 * Useful for tests that need a working directory with specific file
 * structure (e.g. config files, scripts) without polluting the real
 * filesystem.
 */
export async function createTempDir(
  options: CreateTempDirOptions = {}
): Promise<TempDirResult> {
  const { prefix = 'tui-harness-test-', files = {} } = options;

  const dir = await mkdtemp(join(tmpdir(), prefix));

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}
