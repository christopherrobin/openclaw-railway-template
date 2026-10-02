import assert from "node:assert/strict";
import test from "node:test";

import { rebuildForwardedHeaders } from "./proxy-headers.js";

function proxyRequest(headers) {
  const values = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    getHeaderNames: () => [...values.keys()],
    removeHeader: (name) => values.delete(name.toLowerCase()),
    setHeader: (name, value) => values.set(name.toLowerCase(), value),
    headers: values,
  };
}

test("rebuilds Railway forwarding headers from the trusted client IP", () => {
  const proxyReq = proxyRequest({
    forwarded: "for=192.0.2.1",
    "x-forwarded-for": "192.0.2.1",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "claw.example.com",
    "x-forwarded-client-cert": "spoofed",
    "x-real-ip": "192.0.2.1",
  });

  rebuildForwardedHeaders(
    proxyReq,
    {
      headers: {
        host: "internal.railway",
        "x-forwarded-host": "claw.example.com",
        "x-real-ip": "203.0.113.10",
      },
      socket: { remoteAddress: "100.64.0.1" },
    },
    "claw.up.railway.app",
  );

  assert.deepEqual(Object.fromEntries(proxyReq.headers), {
    "x-forwarded-for": "203.0.113.10",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "claw.example.com",
  });
});

test("fails closed when Railway client attribution is missing or malformed", () => {
  for (const realIp of [undefined, "not-an-ip"]) {
    const proxyReq = proxyRequest({});
    rebuildForwardedHeaders(
      proxyReq,
      {
        headers: {
          "x-forwarded-host": "invalid.example.com, spoofed.example.com",
          ...(realIp === undefined ? {} : { "x-real-ip": realIp }),
        },
        socket: { remoteAddress: "100.64.0.1" },
      },
      "claw.up.railway.app",
    );

    assert.deepEqual(Object.fromEntries(proxyReq.headers), {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "claw.up.railway.app",
    });
  }
});

test("keeps loopback client attribution fail-closed for OpenClaw", () => {
  const proxyReq = proxyRequest({});
  rebuildForwardedHeaders(
    proxyReq,
    {
      headers: { "x-real-ip": "::1" },
      socket: { remoteAddress: "100.64.0.1" },
    },
    "claw.up.railway.app",
  );

  assert.equal(proxyReq.headers.get("x-forwarded-for"), "::1");
});

test("strips untrusted forwarding headers outside Railway", () => {
  const proxyReq = proxyRequest({
    "x-forwarded-for": "192.0.2.1",
    "x-real-ip": "192.0.2.1",
  });

  rebuildForwardedHeaders(
    proxyReq,
    {
      headers: { "x-real-ip": "192.0.2.1" },
      socket: { remoteAddress: "127.0.0.1" },
    },
    undefined,
  );

  assert.deepEqual(Object.fromEntries(proxyReq.headers), {});
});

test("uses the Tailscale Serve client IP for loopback connections", () => {
  const proxyReq = proxyRequest({});
  rebuildForwardedHeaders(
    proxyReq,
    {
      headers: {
        "x-forwarded-for": "100.86.179.32",
        "x-forwarded-host": "openclaw.tail0000.ts.net",
      },
      socket: { remoteAddress: "127.0.0.1" },
    },
    "openclaw.tail0000.ts.net",
  );

  assert.deepEqual(Object.fromEntries(proxyReq.headers), {
    "x-forwarded-for": "100.86.179.32",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "openclaw.tail0000.ts.net",
  });
});

test("ignores X-Forwarded-For from non-loopback peers", () => {
  const proxyReq = proxyRequest({});
  rebuildForwardedHeaders(
    proxyReq,
    {
      headers: { "x-forwarded-for": "100.86.179.32" },
      socket: { remoteAddress: "100.64.0.1" },
    },
    "claw.up.railway.app",
  );

  assert.equal(proxyReq.headers.get("x-forwarded-for"), "127.0.0.1");
});

test("fails closed on malformed or loopback Tailscale attribution", () => {
  for (const forwardedFor of [undefined, "not-an-ip", "127.0.0.1", "100.86.179.32, ::1"]) {
    const proxyReq = proxyRequest({});
    rebuildForwardedHeaders(
      proxyReq,
      {
        headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
        socket: { remoteAddress: "::ffff:127.0.0.1" },
      },
      "openclaw.tail0000.ts.net",
    );

    assert.equal(proxyReq.headers.get("x-forwarded-for"), "127.0.0.1");
  }
});
