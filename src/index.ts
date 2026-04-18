/**
 * qqdocs — Tencent Docs (docs.qq.com) integration via raw MCP JSON-RPC.
 *
 * No SDK, no mcporter, no initialize handshake. Just one HTTP POST per call.
 * Auth via TENCENT_DOCS_TOKEN from environment or .env.local.
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import { readFile, stat, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { basename, extname, resolve as resolvePath } from "path";
import { env } from "./env";

const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function readLocalFile(filePath: string): Promise<Buffer> {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Local file not found: ${filePath}`);
    }
    throw error;
  }
  return readFile(filePath);
}

const DOCS_MCP_URL = "https://docs.qq.com/openapi/mcp";
const RETRYABLE_FETCH_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_FETCH_RETRY_MAX_ATTEMPTS = 4;
const DEFAULT_FETCH_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_FETCH_RETRY_MAX_DELAY_MS = 10_000;
const FETCH_RETRY_JITTER_RATIO = 0.25;

export type FetchWithRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Retry on fetch-level network failures (default true). Set false for non-idempotent writes. */
  retryNetworkErrors?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

type RetryDelayOptions = {
  retryAfterHeader?: string | null;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  now?: () => number;
};

function getToken(): string {
  const token = process.env.TENCENT_DOCS_TOKEN ?? env.TENCENT_DOCS_TOKEN;
  if (!token) throw new Error("TENCENT_DOCS_TOKEN not set (in process env or .env.local)");
  return token;
}

/** Retry transient HTTP responses (429/5xx) and fetch-level network failures. */
export async function fetchWithRetry(url: string, init: RequestInit, opts: FetchWithRetryOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_FETCH_RETRY_MAX_ATTEMPTS));
  const retryNetworkErrors = opts.retryNetworkErrors ?? true;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchImpl(url, init);
      if (!isRetryableFetchStatus(res.status) || attempt === maxAttempts) return res;
      await sleep(computeRetryDelayMs(attempt, {
        retryAfterHeader: res.headers.get("Retry-After"),
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        random: opts.random,
        now: opts.now,
      }));
    } catch (error) {
      if (!retryNetworkErrors || attempt === maxAttempts) throw error;
      await sleep(computeRetryDelayMs(attempt, {
        baseDelayMs: opts.baseDelayMs,
        maxDelayMs: opts.maxDelayMs,
        random: opts.random,
        now: opts.now,
      }));
    }
  }

  throw new Error("Retry loop exhausted unexpectedly.");
}

type McpCallOptions = { retryNetworkErrors?: boolean };

async function mcpRequest(url: string, method: string, params: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<any> {
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: getToken() },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  }, { retryNetworkErrors: opts.retryNetworkErrors });
  const body = await res.text();
  const j = parseJsonResponseBody(body);
  if (!res.ok) {
    const msg = extractMcpErrorMessage(j) ?? body;
    const suffix = msg ? `: ${summarizeText(msg, 160)}` : "";
    throw new Error(`MCP HTTP ${res.status} ${res.statusText}${suffix}`);
  }
  if (!j || Array.isArray(j) || typeof j !== "object") {
    const suffix = body ? `: ${summarizeText(body, 160)}` : "";
    throw new Error(`Invalid MCP response JSON${suffix}`);
  }
  if (j.error) {
    const msg = j.error?.data?.message ?? j.error?.message ?? JSON.stringify(j.error);
    throw new Error(`MCP error: ${msg}`);
  }
  return j.result;
}

async function mcpCall(url: string, tool: string, args: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<any> {
  const result = await mcpRequest(url, "tools/call", { name: tool, arguments: args }, opts);
  const j = result as any;
  if (j.structuredContent !== undefined) return j.structuredContent;
  const text = j.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP tool "${tool}" returned non-JSON content: ${message}: ${summarizeText(text, 160)}`);
  }
}

const docs = (tool: string, args?: Record<string, unknown>, opts?: McpCallOptions) => mcpCall(DOCS_MCP_URL, tool, args, opts);
const NO_NETWORK_RETRY: McpCallOptions = { retryNetworkErrors: false };

async function mcpListTools(url: string): Promise<any[]> {
  const result = await mcpRequest(url, "tools/list");
  return result?.tools ?? [];
}

// ── Public API ────────────────────────────────────────────────────────────

export type DocFile = { file_id: string; file_name: string; file_url: string };
export type CreateType = "smartcanvas" | "doc" | "sheet" | "slide" | "mind" | "flowchart" | "smartsheet" | "form";
export type SmartCanvasContentFormat = "mdx" | "markdown";
export type DocPermissionPolicy = 0 | 1 | 2 | 3;
export type SetDocPermissionPolicy = 2 | 3;
export type CreateDocPermissionPolicy = 0 | SetDocPermissionPolicy;
export type SetDocPermissionInput = SetDocPermissionPolicy | "read" | "edit" | "link-read" | "link-edit";
export type DocPermission = { file_id: string; policy: DocPermissionPolicy; trace_id?: string; [key: string]: unknown };
export type ToolInfo = { name: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> };
export type SpaceListScope = 0 | 1 | 2;
export type SpaceListScopeInput = SpaceListScope | "all" | "mine" | "joined";
export type SpaceListOrder = 1 | 2 | 3;
export type SpaceListOrderInput = SpaceListOrder | "preview" | "edited" | "created";
export type SpaceInfo = { space_id: string; title: string; description?: string; policy?: number; file_cnt?: number; member_cnt?: number; is_owner?: boolean; [key: string]: unknown };
export type SpaceNode = { node_id: string; title: string; node_type: string; doc_type?: string; has_child?: boolean; url?: string; [key: string]: unknown };
export type SpaceDocType = "smartcanvas" | "word" | "excel" | "slide" | "mind" | "flowchart" | "smartsheet" | "form";
export type SpaceDocTypeInput = SpaceDocType | CreateType;
export type CanvasBlock = { id: string; content: string };
export type CanvasEditAction = "INSERT_BEFORE" | "INSERT_AFTER" | "UPDATE" | "DELETE";
export type CanvasEditActionInput =
  | CanvasEditAction
  | "insert-before"
  | "before"
  | "insert-after"
  | "after"
  | "append"
  | "update"
  | "delete";
export type LocalDocImportStrategy =
  | { kind: "import" }
  | { kind: "smartcanvas"; contentFormat: SmartCanvasContentFormat };
export type ImportPreparation = { upload_url: string; file_key: string; task_id: string; trace_id?: string };
export type ImportProgress = { progress: number; file_id: string; file_name: string; file_url: string; trace_id?: string };
export type ImportResult = ImportProgress & { task_id: string };

const DOC_PERMISSION_LABELS: Record<DocPermissionPolicy, string> = {
  0: "private",
  1: "partially shared",
  2: "link-read",
  3: "link-edit",
};
const SMARTCANVAS_CONTENT_FORMATS = new Set<SmartCanvasContentFormat>(["mdx", "markdown"]);
const IMPORTABLE_FILE_EXTENSIONS = new Set([
  "xls",
  "xlsx",
  "csv",
  "doc",
  "docx",
  "txt",
  "text",
  "ppt",
  "pptx",
  "pdf",
  "xmind",
]);
const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown"]);
const MDX_FILE_EXTENSIONS = new Set([".mdx"]);
const DEFAULT_IMPORT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_IMPORT_TIMEOUT_MS = 5 * 60_000;
const DELETE_CONFIRM_CODE_DIGITS = 4;
const DELETE_CONFIRM_CODE_MODULUS = 10 ** DELETE_CONFIRM_CODE_DIGITS;

/** List recently viewed documents (page-based, page=1 is first page). */
export async function listRecent(count = 20, page = 1): Promise<DocFile[]> {
  const r = await docs("manage.recent_online_file", { num: page, count });
  return r.files ?? r.file ?? [];
}

export type FolderItem = { id: string; is_folder: boolean; title: string; url: string };

/** List folder contents. Pass no folderId for the root. */
export async function listFolderContents(folderId?: string): Promise<{ list: FolderItem[]; finish: boolean }> {
  const args = folderId ? { folder_id: folderId } : {};
  const r = await docs("manage.folder_list", args);
  return { list: r.list ?? [], finish: r.finish ?? true };
}

/** Get folder metadata. */
export async function getFolderMeta(folderId: string): Promise<{ id: string; parent_id: string; title: string }> {
  const r = await docs("manage.query_folder_meta", { folder_id: folderId });
  return r.folder;
}

/**
 * Resolve a folder path like "项目文档/2026" to a folder ID.
 * Each segment is matched against the listing at that level — unique match required.
 * Pass undefined or "" or "root" for the root folder.
 */
export async function resolveFolderId(input: string): Promise<string | undefined> {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "root") return undefined;
  // If it looks like an ID (not a path with slashes), return as-is.
  if (!trimmed.includes("/") && looksLikeFileId(trimmed)) return trimmed;
  const segments = trimmed.split("/").map(s => s.trim()).filter(Boolean);
  let parentId: string | undefined = undefined;
  for (const seg of segments) {
    const { list } = await listFolderContents(parentId);
    const folders = list.filter(i => i.is_folder);
    const matches = folders.filter(i => i.title === seg);
    if (matches.length === 0) throw new Error(`Folder not found: "${seg}" (in ${parentId ?? "root"})`);
    if (matches.length > 1) {
      const ids = matches.map(m => m.id).join(", ");
      throw new Error(`Ambiguous folder name "${seg}" — multiple matches: ${ids}`);
    }
    parentId = matches[0].id;
  }
  return parentId;
}

/** Search documents by keyword. */
export async function searchDocs(query: string): Promise<DocFile[]> {
  const r = await docs("manage.search_file", { search_key: query });
  return r.list ?? [];
}

/** List live Tencent Docs MCP tools. */
export async function listTools(pattern?: string): Promise<ToolInfo[]> {
  const tools = (await mcpListTools(DOCS_MCP_URL)) as ToolInfo[];
  if (!pattern) return tools;
  const normalized = pattern.trim().toLowerCase();
  return tools.filter(t => `${t.name} ${t.description ?? ""}`.toLowerCase().includes(normalized));
}

/** Call a raw Tencent Docs MCP tool by name. */
export async function callTool(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  return docs(tool, args);
}

/** Get document metadata. */
export async function getDocInfo(fileId: string): Promise<any> {
  return docs("manage.query_file_info", { file_id: fileId });
}

/** Get document permission metadata. */
export async function getDocPermission(fileId: string): Promise<DocPermission> {
  return docs("manage.get_privilege", { file_id: fileId });
}

/** Alias of getDocPermission for Tencent Docs MCP naming parity. */
export const getDocPrivilege = getDocPermission;

/** Read document content. */
export async function readDoc(fileId: string): Promise<string> {
  const r = await docs("get_content", { file_id: fileId });
  if (typeof r?.content !== "string") {
    const suffix = r?.error ? `: ${r.error}` : "";
    throw new Error(`MCP get_content returned no content for file ${fileId}${suffix}`);
  }
  return r.content;
}

/** Delete a document. */
export async function deleteDoc(
  fileId: string,
  opts: { deleteType?: "origin" | "recent" } = {},
): Promise<{ trace_id?: string; error?: string; [key: string]: unknown }> {
  return docs("manage.delete_file", {
    file_id: fileId,
    ...(opts.deleteType ? { delete_type: opts.deleteType } : {}),
  });
}

/** Create a 4-digit delete confirmation code from current document content. */
export function createDeleteConfirmCode(content: string): string {
  const hash = createHash("sha256").update(content).digest();
  const code = hash.readUIntBE(0, 6) % DELETE_CONFIRM_CODE_MODULUS;
  return `${code}`.padStart(DELETE_CONFIRM_CODE_DIGITS, "0");
}

/** Derive the current delete confirmation code for a document. */
export async function getDocDeleteConfirmCode(fileId: string): Promise<string> {
  const content = await readDoc(fileId);
  return createDeleteConfirmCode(content);
}

/** Create a new document. Returns { file_id, title, url }. */
export async function createDoc(
  title: string,
  type: CreateType = "smartcanvas",
  opts?: { content?: string; contentFormat?: SmartCanvasContentFormat; parentId?: string; spaceId?: string },
): Promise<{ file_id: string; title: string; url: string }> {
  if (type === "smartcanvas" && opts?.content !== undefined) {
    return docs("create_smartcanvas_by_mdx", {
      title,
      mdx: opts.content,
      ...(opts.contentFormat ? { content_format: normalizeSmartCanvasContentFormat(opts.contentFormat) } : {}),
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
    }, NO_NETWORK_RETRY);
  }
  return docs("manage.create_file", {
    title,
    file_type: type,
    ...(opts?.parentId ? { parent_id: opts.parentId } : {}),
    ...(opts?.spaceId ? { space_id: opts.spaceId } : {}),
  }, NO_NETWORK_RETRY);
}

/** Set document permission. Tencent Docs MCP currently supports only public-read and public-edit. */
export async function setDocPermission(fileId: string, policy: SetDocPermissionInput): Promise<DocPermission> {
  return docs("manage.set_privilege", { file_id: fileId, policy: normalizeSetDocPermissionPolicy(policy) });
}

/** Alias of setDocPermission for Tencent Docs MCP naming parity. */
export const setDocPrivilege = setDocPermission;

/** Rename a document. */
export async function renameDoc(fileId: string, title: string): Promise<{ file_id: string; title: string; trace_id?: string }> {
  return docs("manage.rename_file_title", { file_id: fileId, title });
}

/** Duplicate a document. The copy is private (only owner can view). */
export async function copyDoc(fileId: string): Promise<{ id: string; title: string; url: string; trace_id?: string }> {
  return docs("manage.copy_file", { file_id: fileId }, NO_NETWORK_RETRY);
}

/** Prepare an async import and receive the signed upload URL. */
export async function preImportFile(fileName: string, fileSize: number, fileMd5: string): Promise<ImportPreparation> {
  return docs("manage.pre_import", { file_name: fileName, file_size: fileSize, file_md5: fileMd5 }, NO_NETWORK_RETRY);
}

/** Start an async import after uploading the source bytes. */
export async function asyncImportFile(input: {
  fileName: string;
  fileSize: number;
  fileMd5: string;
  fileKey: string;
  taskId: string;
}): Promise<{ task_id: string; trace_id?: string }> {
  return docs("manage.async_import", {
    file_name: input.fileName,
    file_size: input.fileSize,
    file_md5: input.fileMd5,
    file_key: input.fileKey,
    task_id: input.taskId,
  }, NO_NETWORK_RETRY);
}

/** Query async import progress. */
export async function getImportProgress(taskId: string): Promise<ImportProgress> {
  return docs("manage.import_progress", { task_id: taskId });
}

/** Wait until an async import reaches 100%. */
export async function waitForImport(
  taskId: string,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (progress: ImportProgress) => void;
  } = {},
): Promise<ImportProgress> {
  const pollIntervalMs = Math.max(250, opts.pollIntervalMs ?? DEFAULT_IMPORT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(pollIntervalMs, opts.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS);
  const startedAt = Date.now();
  let lastProgress = -1;

  while (true) {
    const progress = await getImportProgress(taskId);
    if (progress.progress !== lastProgress) {
      opts.onProgress?.(progress);
      lastProgress = progress.progress;
    }
    if ((progress.progress ?? 0) >= 100) return progress;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Import timed out after ${timeoutMs}ms (last progress: ${progress.progress ?? 0}%).`);
    }
    await sleepMs(pollIntervalMs);
  }
}

/** Upload a local file and wait until Tencent Docs finishes importing it. */
export async function importLocalFile(
  filePath: string,
  opts: {
    fileName?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (progress: ImportProgress) => void;
  } = {},
): Promise<ImportResult> {
  const bytes = await readLocalFile(filePath);
  const fileName = opts.fileName ?? basename(filePath);
  const fileSize = bytes.length;
  const fileMd5 = createHash("md5").update(bytes).digest("hex");
  const prepared = await preImportFile(fileName, fileSize, fileMd5);

  await uploadImportBytes(prepared.upload_url, bytes);

  const started = await asyncImportFile({
    fileName,
    fileSize,
    fileMd5,
    fileKey: prepared.file_key,
    taskId: prepared.task_id,
  });
  const progress = await waitForImport(started.task_id, opts);
  return {
    ...progress,
    task_id: started.task_id,
  };
}

/** List spaces available to the current user. */
export async function listSpaces(opts: {
  page?: number;
  scope?: SpaceListScopeInput;
  order?: SpaceListOrderInput;
  descending?: boolean;
} = {}): Promise<{ spaces: SpaceInfo[]; has_next?: boolean; error?: string; trace_id?: string }> {
  return docs("query_space_list", {
    ...(typeof opts.page === "number" ? { num: opts.page } : {}),
    ...(opts.scope !== undefined ? { query_by: normalizeSpaceListScope(opts.scope) } : {}),
    ...(opts.order !== undefined ? { order_by: normalizeSpaceListOrder(opts.order) } : {}),
    ...(typeof opts.descending === "boolean" ? { descending: opts.descending } : {}),
  });
}

/** Create a new space. */
export async function createSpace(title: string, description?: string): Promise<Record<string, unknown>> {
  return docs("create_space", {
    title,
    ...(description ? { description } : {}),
  }, NO_NETWORK_RETRY);
}

/** List nodes under a given space parent. */
export async function listSpaceNodes(
  spaceId: string,
  opts: { parentId?: string; page?: number } = {},
): Promise<{ children: SpaceNode[]; has_next?: boolean; error?: string; trace_id?: string }> {
  return docs("query_space_node", {
    space_id: spaceId,
    ...(opts.parentId ? { parent_id: opts.parentId } : {}),
    ...(typeof opts.page === "number" ? { num: opts.page } : {}),
  });
}

/** Create a folder node inside a space. */
export async function createSpaceFolder(
  spaceId: string,
  title: string,
  opts: { parentId?: string; isBefore?: boolean } = {},
): Promise<Record<string, unknown>> {
  return docs("create_space_node", {
    space_id: spaceId,
    title,
    node_type: "wiki_folder",
    ...(opts.parentId ? { parent_node_id: opts.parentId } : {}),
    ...(typeof opts.isBefore === "boolean" ? { is_before: opts.isBefore } : {}),
    wiki_folder_node: { title },
  }, NO_NETWORK_RETRY);
}

/** Create a document node inside a space. */
export async function createSpaceDocNode(
  spaceId: string,
  title: string,
  type: SpaceDocTypeInput = "smartcanvas",
  opts: { parentId?: string; isBefore?: boolean } = {},
): Promise<Record<string, unknown>> {
  const docType = normalizeSpaceDocType(type);
  return docs("create_space_node", {
    space_id: spaceId,
    title,
    node_type: "wiki_tdoc",
    ...(opts.parentId ? { parent_node_id: opts.parentId } : {}),
    ...(typeof opts.isBefore === "boolean" ? { is_before: opts.isBefore } : {}),
    wiki_tdoc_node: {
      title,
      doc_type: docType,
    },
  }, NO_NETWORK_RETRY);
}

/** Create a link node inside a space. */
export async function createSpaceLinkNode(
  spaceId: string,
  title: string,
  url: string,
  opts: { description?: string; parentId?: string; isBefore?: boolean } = {},
): Promise<Record<string, unknown>> {
  return docs("create_space_node", {
    space_id: spaceId,
    title,
    node_type: "link",
    ...(opts.parentId ? { parent_node_id: opts.parentId } : {}),
    ...(typeof opts.isBefore === "boolean" ? { is_before: opts.isBefore } : {}),
    link_node: {
      title,
      link_url: url,
      ...(opts.description ? { link_description: opts.description } : {}),
    },
  }, NO_NETWORK_RETRY);
}

/** Delete a space node. */
export async function removeSpaceNode(
  spaceId: string,
  nodeId: string,
  removeType: "current" | "all" = "current",
): Promise<Record<string, unknown>> {
  return docs("delete_space_node", {
    space_id: spaceId,
    node_id: nodeId,
    ...(removeType !== "current" ? { remove_type: removeType } : {}),
  });
}

/** Move a file into a space. */
export async function moveFileToSpace(
  fileId: string,
  spaceId: string,
  targetParentId?: string,
): Promise<Record<string, unknown>> {
  return docs("manage.move_file_to_space", {
    file_id: fileId,
    space_id: spaceId,
    ...(targetParentId ? { target_parent_id: targetParentId } : {}),
  });
}

/** Read smartcanvas content in MDX format. */
export async function readCanvas(
  fileId: string,
  opts: { pageId?: string; size?: number; nextToken?: string } = {},
): Promise<{ content: string; next_token?: string; error?: string; trace_id?: string }> {
  return docs("smartcanvas.read", {
    file_id: fileId,
    ...(opts.pageId ? { page_id: opts.pageId } : {}),
    ...(typeof opts.size === "number" ? { size: opts.size } : {}),
    ...(opts.nextToken ? { next_token: opts.nextToken } : {}),
  });
}

/** Read an entire smartcanvas document, following next_token pagination. */
export async function readCanvasAll(
  fileId: string,
  opts: { pageId?: string; size?: number; maxPages?: number } = {},
): Promise<string> {
  const maxPages = Math.max(1, opts.maxPages ?? 100);
  let nextToken: string | undefined;
  let pages = 0;
  const chunks: string[] = [];
  do {
    const page = await readCanvas(fileId, { pageId: opts.pageId, size: opts.size, nextToken });
    if (page.error) throw new Error(`MCP smartcanvas.read error: ${page.error}`);
    if (page.content) chunks.push(page.content);
    nextToken = page.next_token;
    pages += 1;
    if (pages >= maxPages) break;
  } while (nextToken);
  return chunks.join("");
}

/** Find matching blocks inside a smartcanvas document. */
export async function findCanvasBlocks(
  fileId: string,
  query: string,
): Promise<{ blocks: CanvasBlock[]; error?: string; trace_id?: string }> {
  return docs("smartcanvas.find", { file_id: fileId, query });
}

/** Edit a smartcanvas document. */
export async function editCanvas(
  fileId: string,
  action: CanvasEditActionInput,
  opts: { id?: string; content?: string } = {},
): Promise<Record<string, unknown>> {
  const normalizedAction = normalizeCanvasEditAction(action);
  assertCanvasEditArgs(normalizedAction, opts);
  const isInsert = normalizedAction === "INSERT_BEFORE" || normalizedAction === "INSERT_AFTER";
  return docs("smartcanvas.edit", {
    file_id: fileId,
    action: normalizedAction,
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.content !== undefined ? { content: opts.content } : {}),
  }, isInsert ? NO_NETWORK_RETRY : undefined);
}

// ── CLI command handlers ──────────────────────────────────────────────────

export function docTypeFromUrl(url: string): string {
  if (url.includes("/sheet/")) return "sheet";
  if (url.includes("/smartsheet/")) return "smartsheet";
  if (url.includes("/slide/")) return "slide";
  if (url.includes("/form/")) return "form";
  if (url.includes("/pdf/")) return "pdf";
  if (url.includes("/mind/")) return "mind";
  if (url.includes("/flowchart/")) return "flowchart";
  return "doc";
}

const DOC_TYPE_EXT: Record<string, string> = {
  doc: ".docx", sheet: ".xlsx", slide: ".pptx", pdf: ".pdf",
  mind: ".mind", flowchart: ".flow", form: ".form",
  smartsheet: ".ssheet", folder: "/",
};

export function docTypeExt(type: string): string {
  return DOC_TYPE_EXT[type] ?? `.${type}`;
}

const dim = (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

export function formatRelativeDate(tsMs: number | string, now = Date.now()): string {
  const ms = typeof tsMs === "string" ? Number(tsMs) : tsMs;
  const diff = now - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

async function fetchDates(ids: string[]): Promise<Map<string, string>> {
  const results = await Promise.allSettled(ids.map(id => getDocInfo(id)));
  const map = new Map<string, string>();
  for (let i = 0; i < ids.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value?.last_modify_time)
      map.set(ids[i], formatRelativeDate(r.value.last_modify_time as number));
  }
  return map;
}

function toRow(id: string, title: string, url: string, stale: boolean, info?: { mtime?: number; owner?: string }) {
  const ext = docTypeExt(docTypeFromUrl(url));
  return { id, title, url, ext, stale, mtime: info?.mtime, owner: info?.owner };
}

export async function cmdDocsLs(opts: { count?: number; page?: number; json?: boolean; folder?: string; dates?: boolean } = {}) {
  if (opts.json) {
    // JSON mode: plain output regardless of TTY
    if (opts.folder !== undefined) {
      const folderId = await resolveFolderId(opts.folder ?? "");
      const { list } = await listFolderContents(folderId);
      console.log(JSON.stringify(list, null, 2));
    } else {
      const files = await listRecent(opts.count ?? 20, opts.page ?? 1);
      console.log(JSON.stringify(files, null, 2));
    }
    return;
  }

  if (isTTY) {
    // SWR: print cache immediately, fetch fresh, cursor-up and rewrite in place (no screen clear)
    const cached = (await loadSyncCache()).map(e => toRow(e.file_id, e.title, e.url, true));
    const printRow = (r: ReturnType<typeof toRow>) => {
      const parts = [`  ${formatLink(r.title, r.url)} ${dim(r.ext)}`];
      if (r.owner) parts.push(dim(r.owner));
      if (r.mtime) parts.push(dim(formatRelativeDate(r.mtime)));
      return parts.join("  ");
    };

    // Phase 1: print stale rows
    const staleLines = cached.length
      ? cached.map(r => dim(printRow(r)))
      : [dim("  (no cache — run qqdocs sync)")];
    for (const l of staleLines) process.stdout.write(l + "\n");
    process.stdout.write(dim("  fetching…") + "\n");
    const printedLines = staleLines.length + 1;

    // Phase 2: fetch fresh list + file info (dates/owner) in parallel
    let freshRows: ReturnType<typeof toRow>[];
    const fetchInfoMap = async (ids: string[]) => {
      const settled = await Promise.allSettled(ids.map(id => getDocInfo(id)));
      const map = new Map<string, { mtime?: number; owner?: string }>();
      for (let i = 0; i < ids.length; i++) {
        const r = settled[i];
        if (r.status === "fulfilled" && r.value) {
          map.set(ids[i], {
            mtime: r.value.last_modify_time as number | undefined,
            owner: r.value.owner_name as string | undefined,
          });
        }
      }
      return map;
    };

    if (opts.folder !== undefined) {
      const folderId = await resolveFolderId(opts.folder ?? "");
      const { list } = await listFolderContents(folderId);
      const docIds = list.filter(i => !i.is_folder).map(i => i.id);
      const infoMap = await fetchInfoMap(docIds);
      freshRows = list.map(i => {
        const url = i.url.startsWith("//") ? `https:${i.url}` : i.url;
        return toRow(i.id, i.title, url, false, infoMap.get(i.id));
      });
    } else {
      const files = await listRecent(opts.count ?? 20, opts.page ?? 1);
      const infoMap = await fetchInfoMap(files.map(f => f.file_id));
      freshRows = files.map(f => toRow(f.file_id, f.file_name, f.file_url, false, infoMap.get(f.file_id)));
    }

    // Phase 3: cursor up, rewrite without clearing screen
    process.stdout.write(`\x1b[${printedLines}A`);
    for (const r of freshRows) process.stdout.write(`\x1b[2K${printRow(r)}\n`);
    // blank any leftover stale lines
    for (let i = freshRows.length; i < staleLines.length; i++) process.stdout.write("\x1b[2K\n");
    process.stdout.write(`\x1b[2K${dim("  ✓ up to date")}\n`);
    return;
  }

  // Plain mode for non-TTY
  if (opts.folder !== undefined) {
    const folderId = await resolveFolderId(opts.folder ?? "");
    const { list, finish } = await listFolderContents(folderId);
    if (!list.length) { console.log("(empty folder)"); return; }
    const dates = opts.dates ? await fetchDates(list.filter(i => !i.is_folder).map(i => i.id)) : new Map();
    for (const item of list) {
      const type = item.is_folder ? "folder" : docTypeFromUrl(item.url);
      const url = item.url.startsWith("//") ? `https:${item.url}` : item.url;
      const date = dates.get(item.id);
      console.log(`  ${formatLink(item.title, url)} ${dim(docTypeExt(type))}${date ? `  ${dim(date)}` : ""}`);
    }
    if (!finish) console.log("  … (more items exist)");
    return;
  }
  const files = await listRecent(opts.count ?? 20, opts.page ?? 1);
  if (!files.length) { console.log("(no recent documents)"); return; }
  const dates = opts.dates ? await fetchDates(files.map(f => f.file_id)) : new Map();
  for (const f of files) {
    const type = docTypeFromUrl(f.file_url);
    const date = dates.get(f.file_id);
    console.log(`  ${formatLink(f.file_name, f.file_url)} ${dim(docTypeExt(type))}${date ? `  ${dim(date)}` : ""}`);
  }
}

export async function cmdDocsSearch(query: string, opts: { json?: boolean } = {}) {
  if (!query) { console.log("Usage: qqdocs search <query>"); return; }
  const files = await searchDocs(query);
  if (opts.json) { console.log(JSON.stringify(files, null, 2)); return; }
  if (!files.length) { console.log(`(no documents matching "${query}")`); return; }
  for (const f of files) {
    const title = (f as any).title ?? f.file_name;
    const url = (f as any).url ?? f.file_url;
    console.log(`  ${formatLink(title, url)}`);
  }
}

export async function cmdDocsRead(fileIdOrUrl: string) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs read <file-id-or-url>"); return; }
  const fileId = await resolveFileId(fileIdOrUrl);
  const [info, content] = await Promise.all([
    getDocInfo(fileId).catch(() => null),
    readDoc(fileId),
  ]);
  const title = (info?.title ?? info?.file_name) as string | undefined;
  const url = (info?.url ?? info?.file_url) as string | undefined;
  if (title && url) console.log(`# ${formatLink(title, url)}\n`);
  console.log(content);
}

export async function cmdDocsRename(fileIdOrUrl: string, title: string) {
  if (!fileIdOrUrl || !title) {
    console.log("Usage: qqdocs rename <file-id-or-url> <new-title>");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  const result = await renameDoc(fileId, title);
  printObject({ file_id: fileId, title: result.title ?? title, trace_id: result.trace_id });
}

export async function cmdDocsCopy(fileIdOrUrl: string, opts: { title?: string } = {}) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs cp <file-id-or-url-or-filename> [--title <new-title>]"); return; }
  const fileId = await resolveFileId(fileIdOrUrl);
  const copy = await copyDoc(fileId);
  let finalTitle = copy.title;
  if (opts.title && opts.title !== copy.title) {
    const renamed = await renameDoc(copy.id, opts.title);
    finalTitle = renamed.title ?? opts.title;
  }
  printObject({ file_id: copy.id, title: finalTitle, url: copy.url, source_file_id: fileId });
}

export async function cmdDocsOpen(fileIdOrUrl: string) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs open <file-id-or-url-or-filename>"); return; }
  const fileId = await resolveFileId(fileIdOrUrl);
  const info = await getDocInfo(fileId);
  const url = (info?.url ?? info?.file_url) as string | undefined;
  if (!url) throw new Error(`No URL returned for file ${fileId}`);
  console.log(url);
  await openUrlInBrowser(url);
}

export async function cmdDocsDelete(
  fileIdOrUrl: string,
  opts: { deleteType?: "origin" | "recent"; confirm?: string } = {},
) {
  if (!fileIdOrUrl) {
    console.log("Usage: qqdocs delete <file-id-or-url> --confirm=<4-digit-code>");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  const [info, contentResult] = await Promise.allSettled([
    getDocInfo(fileId),
    readDoc(fileId),
  ]);
  if (contentResult.status === "rejected") {
    const message = contentResult.reason instanceof Error ? contentResult.reason.message : String(contentResult.reason);
    console.log(`Unable to read document content for confirmation: ${message}`);
    return;
  }
  const content = contentResult.value;
  const expectedConfirmCode = createDeleteConfirmCode(content);
  if (opts.confirm === undefined) {
    const docInfo = info.status === "fulfilled" ? info.value : null;
    const title = (docInfo?.title ?? docInfo?.file_name) as string | undefined;
    const url = (docInfo?.url ?? docInfo?.file_url) as string | undefined;
    if (title) console.log(`  title: ${title}`);
    if (url)   console.log(`  url:   ${url}`);
    console.log(`  id:    ${fileId}`);
    const chars = content.length;
    const snippet = content.replace(/\s+/g, " ").trim().slice(0, 120);
    console.log(`  size:  ${chars.toLocaleString()} chars`);
    if (snippet) console.log(`  preview: ${snippet}${chars > 120 ? "…" : ""}`);
    console.log(`\n⚠  Moves to recycle bin at docs.qq.com/desktop/trash — not restorable via CLI.`);
    console.log(`\nConfirm code: ${expectedConfirmCode}`);
    console.log(`Re-run: ${formatDeleteDocCommand(fileId, expectedConfirmCode)}`);
    return;
  }
  let providedConfirmCode = "";
  try {
    providedConfirmCode = normalizeDeleteConfirmCode(opts.confirm);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(message);
    return;
  }
  if (providedConfirmCode !== expectedConfirmCode) {
    console.log("Confirmation code mismatch for current document content.");
    console.log(`Expected: ${expectedConfirmCode}`);
    console.log(`Re-run: ${formatDeleteDocCommand(fileId, expectedConfirmCode)}`);
    return;
  }
  const result = await deleteDoc(fileId, { deleteType: opts.deleteType });
  printObject({
    file_id: fileId,
    delete_type: opts.deleteType ?? "origin",
    confirm: providedConfirmCode,
    ...result,
  });
  console.log(`\nMoved to recycle bin. Restore at: ${formatLink("docs.qq.com/desktop/trash", "https://docs.qq.com/desktop/trash")}`);
}

export async function cmdDocsInfo(fileIdOrUrl: string, opts: { json?: boolean } = {}) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs info <file-id-or-url>"); return; }
  const fileId = await resolveFileId(fileIdOrUrl);
  const info = await getDocInfo(fileId);
  if (opts.json) { console.log(JSON.stringify(info, null, 2)); return; }
  printObject(info);
}

export async function cmdDocsCreate(
  title: string,
  opts: { type?: string; format?: SmartCanvasContentFormat; content?: string; perm?: string } = {},
) {
  if (!title) {
    console.log("Usage: qqdocs create <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form] [--format mdx|markdown] [--perm private|link-read|link-edit]");
    return;
  }
  const type = (opts.type ?? "smartcanvas") as CreateType;
  const requestedPermission = opts.perm ? parseCreateDocPermissionPolicy(opts.perm) : 0;
  const result = await createDoc(title, type, { content: opts.content, contentFormat: opts.format });
  const checkCommand = formatGetDocPermissionCommand(result.file_id);
  const updateCommand = formatSetDocPermissionCommand(result.file_id);
  console.log(`Created: ${result.title ?? title}`);
  console.log(`URL: ${result.url}`);
  console.log(`ID: ${result.file_id}`);
  try {
    if (requestedPermission !== 0) {
      await setDocPermission(result.file_id, requestedPermission);
    }
    const permission = await getDocPermission(result.file_id);
    console.log(`Policy: ${describeDocPermissionPolicy(permission.policy)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Policy: unavailable (${message})`);
  }
  console.log(`Check: ${checkCommand}`);
  console.log(`Update: ${updateCommand}`);
}

export async function cmdDocsImport(
  filePath: string,
  opts: {
    title?: string;
    perm?: string;
    spaceId?: string;
    parentId?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
  } = {},
) {
  if (!filePath) {
    console.log("Usage: qqdocs import <path> [--title <title>] [--perm private|link-read|link-edit] [--space <space-id>] [--parent <node-id>] [--poll <ms>] [--timeout <ms>]");
    return;
  }
  if (opts.parentId && !opts.spaceId) {
    console.log("--parent requires --space.");
    return;
  }

  const requestedPermission = opts.perm ? parseCreateDocPermissionPolicy(opts.perm) : 0;
  const strategy = detectLocalDocImportStrategy(filePath);
  let fileId = "";
  let url = "";
  let displayTitle = opts.title ?? defaultImportedDocTitle(filePath, strategy);

  if (strategy.kind === "smartcanvas") {
    const content = (await readLocalFile(filePath)).toString("utf8");
    const result = await createDoc(displayTitle, "smartcanvas", {
      content,
      contentFormat: strategy.contentFormat,
    });
    fileId = result.file_id;
    url = result.url ?? "";
    displayTitle = result.title ?? displayTitle;
  } else {
    console.log(`Uploading: ${basename(filePath)}`);
    const imported = await importLocalFile(filePath, {
      pollIntervalMs: opts.pollIntervalMs,
      timeoutMs: opts.timeoutMs,
      onProgress: progress => {
        console.log(`Progress: ${progress.progress}%`);
      },
    });
    fileId = imported.file_id;
    url = imported.file_url ?? "";
    displayTitle = imported.file_name ?? displayTitle;
    if (opts.title && opts.title !== imported.file_name) {
      const renamed = await renameDoc(imported.file_id, opts.title);
      displayTitle = renamed.title ?? opts.title;
    }
  }

  if (opts.spaceId) {
    await moveFileToSpace(fileId, opts.spaceId, opts.parentId);
  }

  const checkCommand = formatGetDocPermissionCommand(fileId);
  const updateCommand = formatSetDocPermissionCommand(fileId);
  console.log(`${strategy.kind === "smartcanvas" ? "Created" : "Imported"}: ${displayTitle}`);
  if (url) console.log(`URL: ${url}`);
  console.log(`ID: ${fileId}`);
  if (opts.spaceId) {
    console.log(`Space: ${opts.spaceId}${opts.parentId ? ` (parent: ${opts.parentId})` : ""}`);
  }
  try {
    if (requestedPermission !== 0) {
      await setDocPermission(fileId, requestedPermission);
    }
    const permission = await getDocPermission(fileId);
    console.log(`Policy: ${describeDocPermissionPolicy(permission.policy)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Policy: unavailable (${message})`);
  }
  console.log(`Check: ${checkCommand}`);
  console.log(`Update: ${updateCommand}`);
}

export async function cmdDocsPermission(fileIdOrUrl: string) {
  if (!fileIdOrUrl) { console.log("Usage: qqdocs perm get <file-id-or-url>"); return; }
  const fileId = await resolveFileId(fileIdOrUrl);
  const permission = await getDocPermission(fileId);
  printObject({
    ...permission,
    policy: describeDocPermissionPolicy(permission.policy),
  });
}

export async function cmdDocsSetPermission(fileIdOrUrl: string, policyInput: string) {
  if (!fileIdOrUrl || !policyInput) {
    console.log("Usage: qqdocs perm set <file-id-or-url> <private|link-read|link-edit>");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  let policy: SetDocPermissionPolicy;
  try {
    policy = parseSetDocPermissionPolicy(policyInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(message);
    return;
  }
  const permission = await setDocPermission(fileId, policy);
  printObject({
    ...permission,
    policy: describeDocPermissionPolicy(policy),
  });
}

export async function cmdTools(pattern?: string) {
  const tools = await listTools(pattern);
  if (!tools.length) {
    if (pattern) console.log(`(no tools matching "${pattern}")`);
    else console.log("(no tools)");
    return;
  }
  for (const tool of tools) {
    console.log(`  ${tool.name}  ${summarizeText(tool.description ?? "")}`);
  }
}

export async function cmdRaw(tool: string, jsonInput = "{}") {
  if (!tool) {
    console.log("Usage: qqdocs raw <tool> [--json '{...}']");
    return;
  }
  const args = parseJsonObject(jsonInput);
  const result = await callTool(tool, args);
  console.log(JSON.stringify(result, null, 2));
}

export async function cmdSpaceList(opts: {
  page?: number;
  scope?: SpaceListScopeInput;
  order?: SpaceListOrderInput;
  descending?: boolean;
} = {}) {
  const result = await listSpaces(opts);
  const spaces = result.spaces ?? [];
  if (!spaces.length) { console.log("(no spaces)"); return; }
  for (const space of spaces) {
    const policy = typeof space.policy === "number" ? describeDocPermissionPolicy(space.policy) : "unknown";
    const owner = space.is_owner ? "owner" : "member";
    console.log(`  [${policy.padEnd(16)}] ${space.title}  ${space.space_id}  files=${space.file_cnt ?? 0} members=${space.member_cnt ?? 0} ${owner}`);
  }
  if (result.has_next) console.log("  has_next: true");
}

export async function cmdSpaceCreate(title: string, opts: { description?: string } = {}) {
  if (!title) {
    console.log("Usage: qqdocs space create <title> [--description <text>]");
    return;
  }
  const result = await createSpace(title, opts.description);
  printObject(result);
}

export async function cmdSpaceLs(spaceId: string, opts: { parentId?: string; page?: number } = {}) {
  if (!spaceId) {
    console.log("Usage: qqdocs space ls <space-id> [--parent <node-id>] [--page <n>]");
    return;
  }
  const result = await listSpaceNodes(spaceId, opts);
  const nodes = result.children ?? [];
  if (!nodes.length) { console.log("(no nodes)"); return; }
  printSpaceNodes(nodes);
  if (result.has_next) console.log("  has_next: true");
}

export async function cmdSpaceMkdir(spaceId: string, title: string, opts: { parentId?: string; isBefore?: boolean } = {}) {
  if (!spaceId || !title) {
    console.log("Usage: qqdocs space mkdir <space-id> <title> [--parent <node-id>] [--before]");
    return;
  }
  const result = await createSpaceFolder(spaceId, title, opts);
  printCreateNodeResult(result);
}

export async function cmdSpaceMkdoc(
  spaceId: string,
  title: string,
  opts: { type?: SpaceDocTypeInput; parentId?: string; isBefore?: boolean } = {},
) {
  if (!spaceId || !title) {
    console.log("Usage: qqdocs space mkdoc <space-id> <title> [--type smartcanvas|doc|sheet|slide|mind|flowchart|smartsheet|form] [--parent <node-id>] [--before]");
    return;
  }
  const result = await createSpaceDocNode(spaceId, title, opts.type ?? "smartcanvas", opts);
  printCreateNodeResult(result);
}

export async function cmdSpaceLink(
  spaceId: string,
  title: string,
  url: string,
  opts: { description?: string; parentId?: string; isBefore?: boolean } = {},
) {
  if (!spaceId || !title || !url) {
    console.log("Usage: qqdocs space link <space-id> <title> <url> [--description <text>] [--parent <node-id>] [--before]");
    return;
  }
  const result = await createSpaceLinkNode(spaceId, title, url, opts);
  printCreateNodeResult(result);
}

export async function cmdSpaceRm(spaceId: string, nodeId: string, opts: { all?: boolean } = {}) {
  if (!spaceId || !nodeId) {
    console.log("Usage: qqdocs space rm <space-id> <node-id> [--all]");
    return;
  }
  const result = await removeSpaceNode(spaceId, nodeId, opts.all ? "all" : "current");
  printObject({
    space_id: spaceId,
    node_id: nodeId,
    remove_type: opts.all ? "all" : "current",
    ...result,
  });
}

export async function cmdSpaceMove(fileIdOrUrl: string, spaceId: string, opts: { parentId?: string } = {}) {
  if (!fileIdOrUrl || !spaceId) {
    console.log("Usage: qqdocs space move <file-id-or-url> <space-id> [--parent <node-id>]");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  const result = await moveFileToSpace(fileId, spaceId, opts.parentId);
  printObject({
    file_id: fileId,
    space_id: spaceId,
    ...result,
  });
}

export async function cmdCanvasRead(fileIdOrUrl: string, opts: { pageId?: string; size?: number; nextToken?: string; all?: boolean } = {}) {
  if (!fileIdOrUrl) {
    console.log("Usage: qqdocs canvas read <file-id-or-url> [--page <page-id>] [--size <n>] [--next <token>] [--all]");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  if (opts.all) {
    const content = await readCanvasAll(fileId, { pageId: opts.pageId, size: opts.size });
    console.log(content);
    return;
  }
  const result = await readCanvas(fileId, opts);
  console.log(result.content ?? "");
  if (result.next_token) console.log(`Next: ${result.next_token}`);
}

export async function cmdCanvasFind(fileIdOrUrl: string, query: string) {
  if (!fileIdOrUrl || !query) {
    console.log("Usage: qqdocs canvas find <file-id-or-url> <query>");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  const result = await findCanvasBlocks(fileId, query);
  const blocks = result.blocks ?? [];
  if (!blocks.length) { console.log("(no matching blocks)"); return; }
  printCanvasBlocks(blocks);
}

export async function cmdCanvasEdit(fileIdOrUrl: string, action: CanvasEditActionInput, opts: { id?: string; content?: string } = {}) {
  if (!fileIdOrUrl || !action) {
    console.log("Usage: qqdocs canvas edit <file-id-or-url> <insert-before|insert-after|append|update|delete> [--id <block-id>] [--content <mdx>]");
    return;
  }
  const fileId = await resolveFileId(fileIdOrUrl);
  const normalizedAction = normalizeCanvasEditAction(action);
  const result = await editCanvas(fileId, normalizedAction, opts);
  printObject({
    file_id: fileId,
    action: normalizedAction,
    ...result,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Extract file_id from a docs.qq.com URL, or null if not URL-shaped. */
export function tryExtractFileIdFromUrl(input: string): string | null {
  const m = input.match(/docs\.qq\.com\/(?:doc|sheet|slide|smartsheet|form|pdf|mind|flowchart|aio)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  const m2 = input.match(/docs\.qq\.com\/[^/]+\/([A-Za-z0-9]+)/);
  if (m2) return m2[1];
  return null;
}

/** Extract file_id from a docs.qq.com URL, or pass through a raw ID. */
export function extractFileId(input: string): string {
  return tryExtractFileIdFromUrl(input) ?? input;
}

/** Heuristic: does the input look like a bare Tencent Docs file_id? */
export function looksLikeFileId(input: string): boolean {
  return /^[A-Za-z0-9]{10,}$/.test(input.trim());
}

/** Pick exactly one file from a search result set; throw with a candidate list when ambiguous. */
export function pickFileFromSearchResults<T extends { file_id: string; file_name?: string; file_url?: string }>(
  name: string,
  results: T[],
): T {
  const titleOf = (f: any) => f.file_name ?? f.title ?? "";
  const urlOf = (f: any) => f.file_url ?? f.url ?? "";
  const exact = results.filter(f => titleOf(f) === name);
  const pool = exact.length ? exact : results;
  if (pool.length === 0) throw new Error(`No document named "${name}".`);
  if (pool.length > 1) {
    const lines = pool.map(f => `  ${titleOf(f)}  ${urlOf(f)}  (id: ${f.file_id})`).join("\n");
    throw new Error(`Multiple documents named "${name}":\n${lines}\nPass a file ID or URL, or rename to disambiguate.`);
  }
  return pool[0];
}

/** Resolve URL / raw ID / filename to a file_id. Searches by filename when needed. */
export async function resolveFileId(input: string): Promise<string> {
  const fromUrl = tryExtractFileIdFromUrl(input);
  if (fromUrl) return fromUrl;
  const trimmed = input.trim();
  if (looksLikeFileId(trimmed)) return trimmed;
  const hits = await searchDocs(trimmed);
  return pickFileFromSearchResults(trimmed, hits as any).file_id;
}

export function describeDocPermissionPolicy(policy: number): string {
  return DOC_PERMISSION_LABELS[policy as DocPermissionPolicy] ?? "unknown";
}

export function normalizeSpaceListScope(input: SpaceListScopeInput): SpaceListScope {
  if (input === 0 || input === 1 || input === 2) return input;
  const value = `${input}`.trim().toLowerCase();
  if (value === "all") return 0;
  if (value === "mine") return 1;
  if (value === "joined") return 2;
  throw new Error('Unsupported space scope. Use "all", "mine", or "joined".');
}

export function normalizeSpaceListOrder(input: SpaceListOrderInput): SpaceListOrder {
  if (input === 1 || input === 2 || input === 3) return input;
  const value = `${input}`.trim().toLowerCase();
  if (value === "preview") return 1;
  if (value === "edited") return 2;
  if (value === "created") return 3;
  throw new Error('Unsupported space order. Use "preview", "edited", or "created".');
}

export function normalizeSpaceDocType(input: SpaceDocTypeInput): SpaceDocType {
  const value = `${input}`.trim().toLowerCase();
  if (value === "doc") return "word";
  if (value === "sheet") return "excel";
  if (["word", "excel", "form", "slide", "smartcanvas", "smartsheet", "mind", "flowchart"].includes(value)) {
    return value as SpaceDocType;
  }
  throw new Error('Unsupported space document type. Use "smartcanvas", "doc", "sheet", "slide", "mind", "flowchart", "smartsheet", or "form".');
}

export function normalizeCanvasEditAction(input: CanvasEditActionInput): CanvasEditAction {
  const value = `${input}`.trim().toUpperCase();
  if (value === "INSERT_BEFORE" || value === "INSERT-BEFORE" || value === "BEFORE") return "INSERT_BEFORE";
  if (value === "INSERT_AFTER" || value === "INSERT-AFTER" || value === "AFTER" || value === "APPEND") return "INSERT_AFTER";
  if (value === "UPDATE") return "UPDATE";
  if (value === "DELETE") return "DELETE";
  throw new Error('Unsupported canvas action. Use "insert-before", "insert-after", "append", "update", or "delete".');
}

export function normalizeSmartCanvasContentFormat(input: SmartCanvasContentFormat | string): SmartCanvasContentFormat {
  const value = `${input}`.trim().toLowerCase() as SmartCanvasContentFormat;
  if (SMARTCANVAS_CONTENT_FORMATS.has(value)) return value;
  throw new Error('Unsupported smartcanvas format. Use "mdx" or "markdown".');
}

export function detectLocalDocImportStrategy(filePath: string): LocalDocImportStrategy {
  const extension = extname(filePath).toLowerCase();
  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) return { kind: "smartcanvas", contentFormat: "markdown" };
  if (MDX_FILE_EXTENSIONS.has(extension)) return { kind: "smartcanvas", contentFormat: "mdx" };
  if (IMPORTABLE_FILE_EXTENSIONS.has(extension.replace(/^\./, ""))) return { kind: "import" };
  throw new Error(`Unsupported local file type "${extension || "(no extension)"}". Use Markdown (.md, .markdown, .mdx) or Tencent import formats: ${Array.from(IMPORTABLE_FILE_EXTENSIONS).join(", ")}.`);
}

export function defaultImportedDocTitle(filePath: string, strategy = detectLocalDocImportStrategy(filePath)): string {
  return strategy.kind === "smartcanvas"
    ? basename(filePath, extname(filePath))
    : basename(filePath);
}

export function parseSetDocPermissionPolicy(input: string | number): SetDocPermissionPolicy {
  const value = `${input}`.trim().toLowerCase();
  if (["private", "owner", "me", "default"].includes(value)) {
    throw new Error('Setting "private" is not supported by Tencent Docs MCP. New documents default to private.');
  }
  if (["link-read", "read", "view", "viewer", "readonly", "read-only"].includes(value)) return 2;
  if (["link-edit", "edit", "write", "editor", "editable", "readwrite", "read-write"].includes(value)) return 3;
  throw new Error('Unsupported permission policy. Use "private", "link-read", or "link-edit".');
}

export function normalizeSetDocPermissionPolicy(input: SetDocPermissionInput): SetDocPermissionPolicy {
  if (input === 2 || input === 3) return input;
  return parseSetDocPermissionPolicy(input);
}

export function parseCreateDocPermissionPolicy(input: string | number): CreateDocPermissionPolicy {
  const value = `${input}`.trim().toLowerCase();
  if (["private", "owner", "me", "default"].includes(value)) return 0;
  if (["link-read", "read", "view", "viewer", "readonly", "read-only"].includes(value)) return 2;
  if (["link-edit", "edit", "write", "editor", "editable", "readwrite", "read-write"].includes(value)) return 3;
  throw new Error('Unsupported create permission. Use "private", "link-read", or "link-edit".');
}

export function formatGetDocPermissionCommand(fileId: string): string {
  return `qqdocs perm get ${fileId}`;
}

export function formatSetDocPermissionCommand(fileId: string): string {
  return `qqdocs perm set ${fileId} <private|link-read|link-edit>`;
}

export function normalizeDeleteConfirmCode(input: string | number): string {
  const value = `${input}`.trim();
  if (new RegExp(`^\\d{${DELETE_CONFIRM_CODE_DIGITS}}$`).test(value)) return value;
  throw new Error(`Delete confirmation code must be exactly ${DELETE_CONFIRM_CODE_DIGITS} digits.`);
}

export function formatDeleteDocCommand(fileId: string, confirmCode = `<${DELETE_CONFIRM_CODE_DIGITS}-digit-code>`): string {
  return `qqdocs delete ${fileId} --confirm=${confirmCode}`;
}

export function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("JSON arguments must be an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "JSON arguments must be an object.") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON arguments: ${message}`);
  }
}

function assertCanvasEditArgs(action: CanvasEditAction, opts: { id?: string; content?: string }) {
  if ((action === "UPDATE" || action === "DELETE") && !opts.id) {
    throw new Error(`Canvas action ${action} requires --id.`);
  }
  if ((action === "INSERT_BEFORE" || action === "INSERT_AFTER" || action === "UPDATE") && opts.content === undefined) {
    throw new Error(`Canvas action ${action} requires --content.`);
  }
}

function describeSpaceNodeKind(node: SpaceNode): string {
  if (node.node_type === "wiki_folder") return "folder";
  if (node.node_type === "wiki_file") return node.doc_type || "file";
  return node.node_type;
}

function printSpaceNodes(nodes: SpaceNode[]) {
  for (const node of nodes) {
    const kind = describeSpaceNodeKind(node);
    const suffix = node.has_child ? " +" : "";
    console.log(`  [${kind.padEnd(10)}] ${node.title}${suffix}  ${node.node_id}${node.url ? `  ${node.url}` : ""}`);
  }
}

function printCanvasBlocks(blocks: CanvasBlock[]) {
  for (const [index, block] of blocks.entries()) {
    console.log(`ID: ${block.id}`);
    console.log(block.content);
    if (index < blocks.length - 1) console.log("");
  }
}

function printCreateNodeResult(result: Record<string, unknown>) {
  const node = (result.node_info ?? null) as SpaceNode | null;
  if (node) {
    console.log(`Created: ${node.title}`);
    console.log(`Node ID: ${node.node_id}`);
    if (node.url) console.log(`URL: ${node.url}`);
    if (node.node_type) console.log(`Type: ${describeSpaceNodeKind(node)}`);
  }
  printObject({
    error: result.error,
    trace_id: result.trace_id,
  });
}

function summarizeText(text: string, maxLength = 100): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

async function uploadImportBytes(uploadUrl: string, bytes: Uint8Array) {
  const res = await fetchWithRetry(uploadUrl, {
    method: "PUT",
    body: bytes,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const suffix = body ? `: ${summarizeText(body, 160)}` : "";
    throw new Error(`Import upload failed with ${res.status} ${res.statusText}${suffix}`);
  }
}

const isTTY = Boolean(process.stdout.isTTY);

/** OSC 8 hyperlink for TTY; `[text](url)` markdown for non-TTY. */
export function formatLink(text: string, url: string): string {
  if (isTTY) return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
  return `[${text}](${url})`;
}

function printObject(obj: Record<string, unknown>) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
}

export type SyncCacheEntry = { file_id: string; title: string; url: string; mtime?: number };

export function syncCachePath(): string {
  return resolvePath(homedir(), ".qqdocs", "cache.json");
}

export async function loadSyncCache(): Promise<SyncCacheEntry[]> {
  try {
    const raw = await readFile(syncCachePath(), "utf-8");
    return JSON.parse(raw) as SyncCacheEntry[];
  } catch {
    return [];
  }
}

/** Fetch all recent docs + root folder contents and write to ~/.qqdocs/cache.json. */
export async function syncDocs(): Promise<SyncCacheEntry[]> {
  const [recentFiles, { list: folderItems }] = await Promise.all([
    listRecent(100),
    listFolderContents(undefined),
  ]);
  const seen = new Set<string>();
  const entries: SyncCacheEntry[] = [];
  for (const f of recentFiles) {
    if (seen.has(f.file_id)) continue;
    seen.add(f.file_id);
    entries.push({ file_id: f.file_id, title: f.file_name, url: f.file_url });
  }
  for (const item of folderItems) {
    if (item.is_folder || seen.has(item.id)) continue;
    seen.add(item.id);
    const url = item.url.startsWith("//") ? `https:${item.url}` : item.url;
    entries.push({ file_id: item.id, title: item.title, url });
  }
  const dir = resolvePath(homedir(), ".qqdocs");
  await mkdir(dir, { recursive: true });
  await writeFile(syncCachePath(), JSON.stringify(entries, null, 2));
  return entries;
}

export async function cmdDocsSync() {
  process.stdout.write("Syncing…");
  const entries = await syncDocs();
  process.stdout.write(`\r✓ Synced ${entries.length} documents to ${syncCachePath()}\n`);
}

export function browserOpenCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: (url: string) => string[] } {
  if (platform === "darwin") return { cmd: "open", args: url => [url] };
  if (platform === "win32") return { cmd: "cmd", args: url => ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: url => [url] };
}

async function openUrlInBrowser(url: string): Promise<void> {
  const { cmd, args } = browserOpenCommand();
  const child = spawn(cmd, args(url), { detached: true, stdio: "ignore" });
  child.on("error", err => {
    console.log(`Could not open browser (${cmd}): ${err.message}`);
  });
  child.unref();
}

function isRetryableFetchStatus(status: number): boolean {
  return RETRYABLE_FETCH_STATUS_CODES.has(status);
}

function computeRetryDelayMs(attempt: number, opts: RetryDelayOptions = {}): number {
  const retryAfterMs = parseRetryAfterMs(opts.retryAfterHeader, opts.now);
  if (retryAfterMs !== null) return retryAfterMs;

  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? DEFAULT_FETCH_RETRY_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? DEFAULT_FETCH_RETRY_MAX_DELAY_MS);
  const backoffDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const random = opts.random ?? Math.random;
  const jitterRangeMs = Math.round(backoffDelayMs * FETCH_RETRY_JITTER_RATIO);
  return backoffDelayMs + Math.floor(random() * (jitterRangeMs + 1));
}

function parseRetryAfterMs(value: string | null | undefined, now: () => number = Date.now): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) return Math.max(0, Number(normalized) * 1000);

  const retryAt = Date.parse(normalized);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - now());
}

function parseJsonResponseBody(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMcpErrorMessage(payload: unknown): string | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  const error = (payload as { error?: { data?: { message?: unknown }; message?: unknown } }).error;
  const message = error?.data?.message ?? error?.message;
  return message === undefined || message === null ? null : `${message}`;
}
