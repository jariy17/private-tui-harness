/**
 * Global session registry for TUI harness sessions.
 *
 * Tracks all active TuiSession instances and ensures they are cleaned up
 * on process exit or signal termination. Uses a module-level Map as the
 * singleton registry -- no class needed.
 *
 * To avoid circular dependencies, this module defines a {@link ManagedSession}
 * interface that TuiSession (defined elsewhere) must implement. This module
 * never imports TuiSession directly.
 */
import type { CloseResult, SessionInfo } from './types.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Interface for session objects managed by this registry.
 *
 * Avoids circular dependency with TuiSession (which imports session-manager).
 * TuiSession must implement this interface to be registered here.
 */
export interface ManagedSession {
  readonly sessionId: string;
  readonly info: SessionInfo;
  close(): Promise<CloseResult>;
}

// ---------------------------------------------------------------------------
// Module-level state (singleton registry)
// ---------------------------------------------------------------------------

const sessions = new Map<string, ManagedSession>();
let handlersRegistered = false;

// ---------------------------------------------------------------------------
// Process exit handlers
// ---------------------------------------------------------------------------

/**
 * Registers process signal handlers (once) so that all tracked sessions are
 * closed before the process terminates. The handlers are installed lazily on
 * the first call to {@link register}.
 */
function ensureProcessHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  process.on('exit', () => {
    if (sessions.size > 0) {
      console.warn(
        `[tui-harness] ${sessions.size} session(s) still open at process exit. ` +
          'Child processes will be cleaned up by the OS.'
      );
    }
  });

  const handleSignal = async (): Promise<void> => {
    await closeAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void handleSignal();
  });
  process.on('SIGINT', () => {
    void handleSignal();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a session in the global registry.
 *
 * On the first registration, process signal handlers are installed to ensure
 * cleanup on SIGTERM and SIGINT.
 */
export function register(session: ManagedSession): void {
  sessions.set(session.sessionId, session);
  ensureProcessHandlers();
}

/**
 * Remove a session from the global registry.
 *
 * This does **not** close the session -- it simply stops tracking it.
 */
export function unregister(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Look up a session by its unique identifier.
 */
export function get(sessionId: string): ManagedSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Return metadata for all currently registered sessions.
 */
export function listAll(): SessionInfo[] {
  return Array.from(sessions.values()).map(s => s.info);
}

/**
 * Close all registered sessions and clear the registry.
 *
 * Each session's `close()` method is called concurrently. Errors from
 * individual sessions are swallowed so that one failing session does not
 * prevent others from being cleaned up.
 */
export async function closeAll(): Promise<void> {
  const promises = Array.from(sessions.values()).map(async session => {
    try {
      await session.close();
    } catch {
      // Best-effort cleanup
    }
  });

  await Promise.allSettled(promises);
  sessions.clear();
}
