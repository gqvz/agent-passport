# Build the subgraph WASM mappings and deploy to the compose graph-node.
# Requires node + @graphprotocol/graph-cli on the host (kept out of the image
# to avoid a heavy toolchain in the deploy loop).
#
# Usage:  cd subgraph && bash ../docker/deploy-subgraph.sh [version-label]

set -euo pipefail

GRAPH_NODE="${GRAPH_NODE:-http://127.0.0.1:18021}"
IPFS="${IPFS:-http://127.0.0.1:15001}"
SUBGRAPH_NAME="${SUBGRAPH_NAME:-agent-passport}"
VERSION="${1:-v0.0.5}"

cd "$(dirname "$0")/../subgraph"

echo "==> codegen + build"
npm run codegen >/dev/null
npm run build >/dev/null

echo "==> ensure subgraph '$SUBGRAPH_NAME' exists on $GRAPH_NODE"
curl -s -X POST "$GRAPH_NODE" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"subgraph_create\",\"params\":{\"name\":\"$SUBGRAPH_NAME\"}}" \
  >/dev/null || true

echo "==> deploy $SUBGRAPH_NAME @ $VERSION"
npx graph deploy --node "$GRAPH_NODE" --ipfs "$IPFS" "$SUBGRAPH_NAME" --version-label "$VERSION"

echo "==> smoke test"
GRAPH_ENDPOINT="${GRAPH_ENDPOINT:-http://127.0.0.1:18001/subgraphs/name/agent-passport}" npm run test:smoke

echo "done."