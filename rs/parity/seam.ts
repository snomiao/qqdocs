// Parity seam for the TypeScript side. Loaded with `bun --preload`, by the
// `bun` in rs/parity/bin that rs/parity/with-mock.mjs puts first on PATH.
//
// src/index.ts talks to one hard-coded address, https://docs.qq.com/openapi/mcp.
// This sends those requests to the stand-in named by QQDOCS_PARITY_MCP_URL
// instead, and ends the process on any attempt to reach anything that is not
// on this machine. It changes nothing else: the request (method, headers,
// body) goes out exactly as the program built it.

const MCP_URL = "https://docs.qq.com/openapi/mcp";
const standIn = process.env.QQDOCS_PARITY_MCP_URL;
const realFetch = globalThis.fetch;

function isLoopback(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function refuse(url: string): never {
  process.stderr.write(`parity seam: refused to contact ${url}\n`);
  process.exit(97);
}

if (!standIn || !isLoopback(standIn)) {
  process.stderr.write("parity seam: QQDOCS_PARITY_MCP_URL must name a stand-in on 127.0.0.1\n");
  process.exit(97);
}

globalThis.fetch = Object.assign(
  (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url);
    if (url === MCP_URL) return realFetch(standIn, init);
    if (isLoopback(url)) return realFetch(input, init);
    return refuse(url);
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch;

// For `with-mock.mjs --check`: the seam is in place.
(globalThis as any)[Symbol.for("qqdocs-parity-seam")] = true;
