/**
 * Public API surface for the TUI harness.
 *
 * This barrel file re-exports only the symbols intended for external
 * consumption. Internal implementation details (SettlingMonitor, screen
 * reader helpers, session registry internals) are deliberately excluded.
 */

// --- Core session class ---
export { TuiSession } from './lib/tui-session.js';

// --- Types and error classes ---
export type { LaunchOptions, ScreenState, ReadOptions, CloseResult, SendResult, SessionInfo } from './lib/types.js';
export type { SpecialKey } from './lib/types.js';
export {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
  SPECIAL_KEY_VALUES,
  WaitForTimeoutError,
  LaunchError,
} from './lib/types.js';

// --- Key mapping ---
export { KEY_MAP, resolveKey } from './lib/key-map.js';

// --- Availability ---
export { isAvailable, unavailableReason } from './lib/availability.js';

// --- Session management (for cleanup) ---
export { closeAll } from './lib/session-manager.js';

// --- Test helpers ---
export { createTempDir } from './helpers.js';
export type { CreateTempDirOptions, TempDirResult } from './helpers.js';

// --- SVG Screenshots ---
export {
  renderTerminalToSvg,
  DARK_TERMINAL_PROFILE,
  DARK_THEME,
  LIGHT_TERMINAL_PROFILE,
  LIGHT_THEME,
} from './lib/svg-renderer.js';
export type { SvgRenderOptions, SvgTheme, TerminalVisualProfile } from './lib/svg-renderer.js';

// --- PNG Screenshots ---
export { rasterizeTerminalSvg, renderTerminalToPng } from './lib/terminal-rasterizer.js';
export type { RasterizedTerminalImage } from './lib/terminal-rasterizer.js';

// --- Demo recording and rendering ---
export { DemoRecorder, assertDemoRecording, readDemoRecording, saveDemoRecording } from './demo/recorder.js';
export { buildDemoTimeline, captionAt, replayDemoFrames } from './demo/replay.js';
export { buildMacProgram, exportDemoKeyframes, renderMacVisual } from './demo/mac.js';
export type {
  ExportDemoKeyframesOptions,
  RenderMacVisualOptions,
  RenderMacVisualResult,
} from './demo/mac.js';
export { rasterizeSvg } from './demo/rasterizer.js';
export { renderDemo } from './demo/render.js';
export { DEMO_RECORDING_VERSION } from './demo/types.js';
export type {
  DemoExitEvent,
  DemoInputEvent,
  DemoKeyframe,
  DemoKeyframeExportResult,
  DemoMacEasing,
  DemoMacFrameSequenceFrame,
  DemoMacFrameSequenceManifest,
  DemoMacManifest,
  DemoMacOptions,
  DemoMacScene,
  DemoMacTransition,
  DemoMarkerEvent,
  DemoMarkerOptions,
  DemoOutputEvent,
  DemoPollyOptions,
  DemoRecording,
  DemoRecordingCapture,
  DemoRecordingEvent,
  DemoRecordingMetadata,
  DemoRecordingOptions,
  DemoRecordingResult,
  DemoRecordingStatus,
  DemoRenderOptions,
  DemoRenderResult,
  DemoRenderer,
  DemoTimeline,
  DemoTimelineMarker,
  PreparedNarrationClip,
} from './demo/types.js';
