#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
network=jam-antigravity-private
proxy=jam-antigravity-provider-proxy
docker network inspect "$network" >/dev/null 2>&1 || docker network create --internal "$network" >/dev/null
test "$(docker network inspect --format '{{.Internal}}' "$network")" = true
docker build -q -f "$here/Dockerfile.proxy" -t jam-antigravity-proxy:local "$here" >/dev/null
if docker inspect "$proxy" >/dev/null 2>&1; then
  test "$(docker inspect -f '{{.Image}}' "$proxy")" = "$(docker image inspect -f '{{.Id}}' jam-antigravity-proxy:local)"
  docker start "$proxy" >/dev/null
  exit
fi
subnet=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$network")
docker create --name "$proxy" --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 \
  --memory 96m --cpus 0.25 --network "$network" --env JAM_PROXY_NETWORK="$subnet" --restart unless-stopped jam-antigravity-proxy:local >/dev/null
docker network connect bridge "$proxy"
docker start "$proxy" >/dev/null
