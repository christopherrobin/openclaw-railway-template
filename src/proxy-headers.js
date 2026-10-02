import net from "node:net";

function validForwardedHost(value, fallback) {
  if (typeof value !== "string" || value.includes(",")) return fallback;

  try {
    const url = new URL(`https://${value.trim()}`);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return fallback;
    }
    return url.host;
  } catch {
    return fallback;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Railway's edge sets X-Real-IP; anything missing or malformed fails closed to loopback.
function railwayClientIp(req) {
  const realIp = req.headers["x-real-ip"];
  return typeof realIp === "string" && net.isIP(realIp.trim())
    ? realIp.trim()
    : "127.0.0.1";
}

// Tailscale Serve runs inside the container, so it is the only peer that can reach
// the wrapper over loopback. It appends the tailnet client IP to X-Forwarded-For.
function tailscaleServeClientIp(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return undefined;
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor !== "string") return undefined;
  const last = forwardedFor.split(",").pop().trim();
  return net.isIP(last) && !LOOPBACK.has(last) ? last : undefined;
}

export function rebuildForwardedHeaders(proxyReq, req, railwayPublicDomain) {
  for (const name of proxyReq.getHeaderNames()) {
    const lower = name.toLowerCase();
    if (
      lower === "forwarded" ||
      lower === "x-real-ip" ||
      lower.startsWith("x-forwarded-")
    ) {
      proxyReq.removeHeader(name);
    }
  }

  if (!railwayPublicDomain) return;

  const clientIp = tailscaleServeClientIp(req) ?? railwayClientIp(req);
  const forwardedHost = validForwardedHost(
    req.headers["x-forwarded-host"],
    railwayPublicDomain,
  );

  proxyReq.setHeader("X-Forwarded-For", clientIp);
  proxyReq.setHeader("X-Forwarded-Proto", "https");
  proxyReq.setHeader("X-Forwarded-Host", forwardedHost);
}
