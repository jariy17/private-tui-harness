/**
 * MCP tool constants for the TUI harness.
 *
 * This module exports the canonical tool names, launch defaults, and the
 * special-key enum array used by the MCP server when registering tools and
 * building Zod schemas.
 */
import { SPECIAL_KEY_VALUES } from '../index.js';

// ---------------------------------------------------------------------------
// Re-export: Special Key Enum
// ---------------------------------------------------------------------------

/**
 * All special key names recognized by the TUI harness.
 */
export { SPECIAL_KEY_VALUES as SPECIAL_KEY_ENUM };

// ---------------------------------------------------------------------------
// Tool Name Constants
// ---------------------------------------------------------------------------

/**
 * Canonical tool names used by the MCP server.
 */
export const TOOL_NAMES = {
  LAUNCH: 'tui_launch',
  SEND_KEYS: 'tui_send_keys',
  READ_SCREEN: 'tui_read_screen',
  WAIT_FOR: 'tui_wait_for',
  SCREENSHOT: 'tui_screenshot',
  CLOSE: 'tui_close',
  LIST_SESSIONS: 'tui_list_sessions',
  ACTION: 'tui_action',
} as const;

// ---------------------------------------------------------------------------
// Launch Defaults
// ---------------------------------------------------------------------------

/**
 * Default command and args for `tui_launch` when not specified by the caller.
 *
 * Defaults to launching a bash shell. Override via tui_launch parameters to
 * launch any TUI application (e.g. vim, htop, your own CLI).
 */
export const LAUNCH_DEFAULTS = {
  command: 'bash',
  args: [] as string[],
} as const;
