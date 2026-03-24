/**
 * Runtime availability check for node-pty.
 *
 * This module attempts to load node-pty at module evaluation time and
 * exports a boolean flag indicating whether it succeeded. Consumer code
 * can use this to skip TUI harness operations gracefully when node-pty
 * is not installed or its native addon failed to compile.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Whether node-pty is available and its native addon loaded successfully.
 *
 * When `true`, it is safe to `import * as pty from 'node-pty'` and use
 * the PTY APIs. When `false`, check {@link unavailableReason} for details.
 */
export let isAvailable = false;

/**
 * Human-readable reason why node-pty is not available.
 *
 * Empty string when {@link isAvailable} is `true`.
 */
export let unavailableReason = '';

try {
  require('node-pty');
  isAvailable = true;
} catch (err) {
  unavailableReason = `node-pty not available: ${(err as Error).message}`;
}
