/**
 * qqdocs — Tencent Docs (docs.qq.com) integration via raw MCP JSON-RPC.
 *
 * No SDK, no mcporter, no initialize handshake. Just one HTTP POST per call.
 * Auth via TENCENT_DOCS_TOKEN from environment or .env.local.
 */

import { env } from "./env";

const DOCS_MCP_URL = "https://docs.qq.com/openapi/mcp";

function getToken(): string {
  const token = process.env.TENCENT_DOCS_TOKEN ?? env.TENCENT_DOCS_TOKEN;
  if (!token) throw new Error("TENCENT_DOCS_TOKEN not set (in process env or .env.local)");
  return token;
}

async function mcpCall(url: string, tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: getToken() },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const j = (await res.json()) as any;
  if (j.error) {
    const msg = j.error?.data?.message ?? j.error?.message ?? JSON.stringify(j.error);
    throw new Error(`MCP error: ${msg}`);
  }
  return j.result?.structuredContent ?? JSON.parse(j.result?.content?.[0]?.text ?? "{}");
}

const docs = (tool: string, args?: Record<string, unknown>) => mcpCall(DOCS_MCP_URL, tool, args);

// ── Public API ────────────────────────────────────────────────────────────

export type DocFile = { file_id: string; file_name: string; file_url: string };
export type CreateType = "smartcanvas" | "doc" | "sheet" | "slide" | "mind" | "flowchart" | "smartsheet" | "form";

/** List recently viewed documents (page-based, page=1 is first page). */
export async function listRecent(count = 20, page = 1): Promise<DocFile[]> {
  const r = await docs("manage.recent_online_file", { num: page, count });
  return r.files ?? r.file ?? [];
}

/** Search documents by keyword. */
export async function searchDocs(query: string): Promise<DocFile[]> {
  const r = await docs("manage.search_file", { search_key: query });
  return r.list ?? [];
}

/** Get document metadata. */
export async function getDocInfo(fileId: string): Promise<any> {
  return docs("manage.query_file_info", { file_id: fileId });
}

/** Read document content. */
export async function readDoc(fileId: string): Promise<string> {
  const r = await docs("get_content", { file_id: fileId });
  return r.content ?? JSON.stringify(r);
}

/** Create a new document. Returns { file_id, title, url }. */
export async function createDoc(
  title: string,
  type: CreateType = "smartcanvas",
  opts?: { content?: string; parentId?: string; spaceId?: string },
): Promise<{ file_id: string; title: string; url: string }> {
  if (type === "smartcanvas" && opts?.content) {
    return docs("create_smartcanvas_by_mdx", {
      title,
      mdx: opts.content,
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
    });
  }
  return docs("manage.create_file", {
    title,
    file_type: type,
    ...(opts?.parentId ? { parent_id: opts.parentId } : {}),
    ...(opts?.spaceId ? { space_id: opts.spaceId } : {}),
  });
}

// ── CLI command handlers ──────────────────────────────────────────────────

export async function cmdDocsLs(opts: { count?: number; page?: number } = {}) {
  const files = await listRecent(opts.count ?? 20, opts.page ?? 1);
  if (!files.length) { console.log("(no recent documents)"); return; }
  for (const f of files) {
    const type = f.file_url.includes("/sheet/") ? "sheet"
      : f.file_url.includes("/smartsheet/") ? "smartsheet"
      : f.file_url.includes("/slide/") ? "slide"
      : f.file_url.includes("/form/") ? "form"
      : f.file_url.includes("/pdf/") ? "pdf"
      : "doc";
    console.log(`  [${type.padEnd(10)}] ${f.file_name}  ${f.file_url}`);
  }
}

export async function cmdDocsSearch(query: string) {
  if (!query) { console.log("Usage: qqdocs search <query>"); return; }
  const files = await searchDocs(query);
  if (!files.length) { console.log(`(no documents matching "${query}")`); return; }
  for (const f of files) {
    console.log(`  ${(f as any).title ?? f.file_name}  ${(f as any).url ?? f.file_url}`);
  }
}

export async function cmdDocsRead(fileIdOrUrl: string) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs read <file-id-or-url>"); return; }
  const fileId = extractFileId(fileIdOrUrl);
  const content = await readDoc(fileId);
  console.log(content);
}

export async function cmdDocsInfo(fileIdOrUrl: string) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs info <file-id-or-url>"); return; }
  const fileId = extractFileId(fileIdOrUrl);
  const info = await getDocInfo(fileId);
  for (const [k, v] of Object.entries(info)) {
    if (v !== null && v !== undefined && v !== "") console.log(`  ${k}: ${v}`);
  }
}

export async function cmdDocsCreate(title: string, opts: { type?: string; content?: string } = {}) {
  if (!title) { console.log("Usage: qqdocs create <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart]"); return; }
  const type = (opts.type ?? "smartcanvas") as CreateType;
  const result = await createDoc(title, type, { content: opts.content });
  console.log(`Created: ${result.title ?? title}`);
  console.log(`URL: ${result.url}`);
  console.log(`ID: ${result.file_id}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Extract file_id from a docs.qq.com URL, or pass through a raw ID. */
export function extractFileId(input: string): string {
  const m = input.match(/docs\.qq\.com\/(?:doc|sheet|slide|smartsheet|form|pdf|mind|flowchart)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  const m2 = input.match(/docs\.qq\.com\/[^/]+\/([A-Za-z0-9]+)/);
  if (m2) return m2[1];
  return input;
}
