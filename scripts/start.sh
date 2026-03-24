#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start.sh
#
# Convenience wrapper to build (if needed) and start the TUI harness MCP
# server over HTTP transport.
#
# Usage:
#   ./scripts/start.sh              # default port 24100
#   ./scripts/start.sh --port 8080  # custom port
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=24100

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --port requires a value" >&2
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--port PORT]" >&2
      exit 1
      ;;
  esac
done

# Build if needed
if [[ ! -d "$PROJECT_DIR/dist" ]]; then
  echo "Building TypeScript..."
  (cd "$PROJECT_DIR" && npm run build)
  echo ""
fi

echo "=========================================="
echo "  TUI Harness MCP Server (HTTP transport)"
echo "=========================================="
echo ""
echo "  URL:  http://127.0.0.1:${PORT}/mcp"
echo ""
echo "  Add this to your .mcp.json:"
echo ""
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"tui-harness\": {"
echo "        \"type\": \"http\","
echo "        \"url\": \"http://127.0.0.1:${PORT}/mcp\""
echo "      }"
echo "    }"
echo "  }"
echo ""
echo "  Press Ctrl-C to stop the server."
echo "=========================================="
echo ""

exec node "$PROJECT_DIR/dist/mcp/index.js" --http --port "$PORT"
