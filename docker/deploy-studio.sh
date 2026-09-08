# Deploy the subgraph to Subgraph Studio (The Graph hosted service) in one command.
#
# Prereqs:
#   1. Create a subgraph at https://thegraph.com/studio (name it, e.g. "agent-passport")
#      and copy its API key (Deploy key: "Open Subgraph Studio > select subgraph > Deploy key").
#   2. This script runs from the repo root or anywhere; it operates inside subgraph/.
#
# Usage:
#   export STUDIO_API_KEY=<your-studio-deploy-key>
#   bash docker/deploy-studio.sh [SLUG] [VERSION]
#
#   SLUG    defaults to "agent-passport" (must match the name chosen in Studio).
#   VERSION defaults to "v0.0.6" (Studio requires a fresh, monotonic version each deploy).
#
# After a successful deploy, copy the printed "Queries (HTTP)" URL into:
#   - app/.env      VITE_SUBGRAPH_URL=<...>
#   - mcp  SUBGRAPH_URL env (if you run the MCP server against hosted)
#   - docker-compose.yml default VITE_SUBGRAPH_URL (optional)

set -euo pipefail

SLUG="${1:-agent-passport}"
VERSION="${2:-v0.0.6}"
: "${STUDIO_API_KEY:?set STUDIO_API_KEY to your Subgraph Studio deploy key first}"

cd "$(dirname "$0")/../subgraph"

echo "==> codegen + build"
npm run codegen >/dev/null
npm run build >/dev/null

echo "==> authenticate with Subgraph Studio"
npx graph auth --studio "$STUDIO_API_KEY"

echo "==> deploy '$SLUG' @ $VERSION"
npx graph deploy --studio "$SLUG" --version-label "$VERSION"

echo
echo "done. Copy the 'Queries (HTTP)' URL printed above into app/.env VITE_SUBGRAPH_URL"
echo "e.g. VITE_SUBGRAPH_URL=https://api.studio.thegraph.com/query/<deployment-id>/$SLUG/$VERSION/graphql"