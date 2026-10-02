#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# Private UI over Tailscale. When TS_AUTHKEY is set, join the tailnet in userspace
# mode (no TUN device or root needed) and serve the wrapper over HTTPS at
# https://<TS_HOSTNAME>.<tailnet>.ts.net, reachable only from your tailnet.
# Node identity lives on the volume, so the auth key is only used on first boot.
if [ -n "${TS_AUTHKEY:-}" ]; then
  TS_SOCKET=/tmp/tailscaled.sock
  ts() { gosu openclaw tailscale --socket="$TS_SOCKET" "$@"; }

  mkdir -p /data/tailscale
  chown openclaw:openclaw /data/tailscale
  gosu openclaw tailscaled \
    --tun=userspace-networking \
    --statedir=/data/tailscale \
    --socket="$TS_SOCKET" >/tmp/tailscaled.log 2>&1 &

  for _ in $(seq 1 40); do
    [ -S "$TS_SOCKET" ] && break
    sleep 0.25
  done

  if ts up --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-openclaw}"; then
    ts serve --bg --https=443 "http://127.0.0.1:${PORT:-8080}" \
      || echo "[tailscale] serve failed: enable HTTPS certificates in the Tailscale admin console (DNS page)"
    OPENCLAW_PUBLIC_HOST="$(ts status --json | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        console.log(JSON.parse(s).Self.DNSName.replace(/\.$/, ""));
      });')"
    export OPENCLAW_PUBLIC_HOST
    echo "[tailscale] serving UI at https://${OPENCLAW_PUBLIC_HOST}"
  else
    echo "[tailscale] up failed; see /tmp/tailscaled.log"
  fi
fi

# Keep the auth key away from the agent's tools and shell.
unset TS_AUTHKEY

exec gosu openclaw node src/server.js
