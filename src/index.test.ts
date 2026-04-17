import { describe, expect, test } from "bun:test";

import {
  browserOpenCommand,
  createDeleteConfirmCode,
  defaultImportedDocTitle,
  detectLocalDocImportStrategy,
  describeDocPermissionPolicy,
  docTypeFromUrl,
  extractFileId,
  fetchWithRetry,
  looksLikeFileId,
  pickFileFromSearchResults,
  formatDeleteDocCommand,
  formatGetDocPermissionCommand,
  formatSetDocPermissionCommand,
  normalizeDeleteConfirmCode,
  normalizeCanvasEditAction,
  normalizeSmartCanvasContentFormat,
  normalizeSpaceDocType,
  normalizeSpaceListOrder,
  normalizeSpaceListScope,
  parseJsonObject,
  parseCreateDocPermissionPolicy,
  parseSetDocPermissionPolicy,
} from "./index";

describe("extractFileId", () => {
  test("extracts ids from Tencent Docs URLs", () => {
    expect(extractFileId("https://docs.qq.com/doc/DExampleFileId123")).toBe("DExampleFileId123");
    expect(extractFileId("https://docs.qq.com/sheet/ABC123")).toBe("ABC123");
  });

  test("passes raw ids through unchanged", () => {
    expect(extractFileId("dExampleRawId123")).toBe("dExampleRawId123");
  });

  test("extracts ids from /aio/ URLs", () => {
    expect(extractFileId("https://docs.qq.com/aio/DZExqQkJCUmpMekhR")).toBe("DZExqQkJCUmpMekhR");
  });
});

describe("doc type detection", () => {
  test("derives type from docs.qq.com url segment", () => {
    expect(docTypeFromUrl("https://docs.qq.com/sheet/ABC")).toBe("sheet");
    expect(docTypeFromUrl("https://docs.qq.com/smartsheet/ABC")).toBe("smartsheet");
    expect(docTypeFromUrl("https://docs.qq.com/slide/ABC")).toBe("slide");
    expect(docTypeFromUrl("https://docs.qq.com/form/ABC")).toBe("form");
    expect(docTypeFromUrl("https://docs.qq.com/pdf/ABC")).toBe("pdf");
    expect(docTypeFromUrl("https://docs.qq.com/mind/ABC")).toBe("mind");
    expect(docTypeFromUrl("https://docs.qq.com/flowchart/ABC")).toBe("flowchart");
    expect(docTypeFromUrl("https://docs.qq.com/aio/ABC")).toBe("doc");
    expect(docTypeFromUrl("https://docs.qq.com/doc/ABC")).toBe("doc");
  });
});

describe("browser open", () => {
  test("picks a platform-specific opener", () => {
    expect(browserOpenCommand("darwin").cmd).toBe("open");
    expect(browserOpenCommand("linux").cmd).toBe("xdg-open");
    expect(browserOpenCommand("win32").cmd).toBe("cmd");
    expect(browserOpenCommand("win32").args("https://x")).toEqual(["/c", "start", "", "https://x"]);
  });
});

describe("file id resolution", () => {
  test("looksLikeFileId rejects Chinese filenames and short strings", () => {
    expect(looksLikeFileId("账本")).toBe(false);
    expect(looksLikeFileId("short")).toBe(false);
    expect(looksLikeFileId("DZFJhVkJHSUdJcENR")).toBe(true);
  });

  test("pickFileFromSearchResults prefers exact title match", () => {
    const results = [
      { file_id: "A", file_name: "账本副本", file_url: "u1" },
      { file_id: "B", file_name: "账本", file_url: "u2" },
    ];
    expect(pickFileFromSearchResults("账本", results).file_id).toBe("B");
  });

  test("pickFileFromSearchResults throws a listing when ambiguous", () => {
    const results = [
      { file_id: "A", file_name: "账本", file_url: "u1" },
      { file_id: "B", file_name: "账本", file_url: "u2" },
    ];
    expect(() => pickFileFromSearchResults("账本", results)).toThrow(/Multiple documents named "账本"[\s\S]*id: A[\s\S]*id: B/);
  });

  test("pickFileFromSearchResults throws on no match", () => {
    expect(() => pickFileFromSearchResults("missing", [])).toThrow('No document named "missing".');
  });
});

describe("delete helpers", () => {
  test("creates stable 6-digit content-derived confirmation codes", () => {
    expect(createDeleteConfirmCode("hello")).toMatch(/^\d{6}$/);
    expect(createDeleteConfirmCode("hello")).toBe(createDeleteConfirmCode("hello"));
    expect(createDeleteConfirmCode("hello")).not.toBe(createDeleteConfirmCode("hello!"));
  });

  test("normalizes and formats delete confirmation commands", () => {
    expect(normalizeDeleteConfirmCode("012345")).toBe("012345");
    expect(() => normalizeDeleteConfirmCode("12345")).toThrow("Delete confirmation code must be exactly 6 digits.");
    expect(() => normalizeDeleteConfirmCode("abcdef")).toThrow("Delete confirmation code must be exactly 6 digits.");
    expect(formatDeleteDocCommand("dExampleRawId123")).toBe("qqdocs delete dExampleRawId123 --confirm=<6-digit-code>");
    expect(formatDeleteDocCommand("dExampleRawId123", "012345")).toBe("qqdocs delete dExampleRawId123 --confirm=012345");
  });
});

describe("permission helpers", () => {
  test("describes known policies", () => {
    expect(describeDocPermissionPolicy(0)).toBe("private");
    expect(describeDocPermissionPolicy(2)).toBe("link-read");
    expect(describeDocPermissionPolicy(3)).toBe("link-edit");
  });

  test("parses supported set-policy aliases", () => {
    expect(parseSetDocPermissionPolicy("link-read")).toBe(2);
    expect(parseSetDocPermissionPolicy("read")).toBe(2);
    expect(parseSetDocPermissionPolicy("link-edit")).toBe(3);
    expect(parseSetDocPermissionPolicy("edit")).toBe(3);
  });

  test("parses supported create-policy aliases", () => {
    expect(parseCreateDocPermissionPolicy("private")).toBe(0);
    expect(parseCreateDocPermissionPolicy("link-read")).toBe(2);
    expect(parseCreateDocPermissionPolicy("read")).toBe(2);
    expect(parseCreateDocPermissionPolicy("link-edit")).toBe(3);
    expect(parseCreateDocPermissionPolicy("edit")).toBe(3);
  });

  test("rejects unsupported set-policy aliases", () => {
    expect(() => parseSetDocPermissionPolicy("2")).toThrow('Unsupported permission policy. Use "private", "link-read", or "link-edit".');
    expect(() => parseSetDocPermissionPolicy("3")).toThrow('Unsupported permission policy. Use "private", "link-read", or "link-edit".');
    expect(() => parseSetDocPermissionPolicy("private")).toThrow('Setting "private" is not supported by Tencent Docs MCP. New documents default to private.');
    expect(() => parseCreateDocPermissionPolicy("0")).toThrow('Unsupported create permission. Use "private", "link-read", or "link-edit".');
  });

  test("formats the permission update command", () => {
    expect(formatGetDocPermissionCommand("dExampleRawId123")).toBe("qqdocs perm get dExampleRawId123");
    expect(formatSetDocPermissionCommand("dExampleRawId123")).toBe("qqdocs perm set dExampleRawId123 <private|link-read|link-edit>");
  });
});

describe("space helpers", () => {
  test("normalizes space list scope", () => {
    expect(normalizeSpaceListScope("all")).toBe(0);
    expect(normalizeSpaceListScope("mine")).toBe(1);
    expect(normalizeSpaceListScope("joined")).toBe(2);
  });

  test("normalizes space list order", () => {
    expect(normalizeSpaceListOrder("preview")).toBe(1);
    expect(normalizeSpaceListOrder("edited")).toBe(2);
    expect(normalizeSpaceListOrder("created")).toBe(3);
  });

  test("normalizes space document types", () => {
    expect(normalizeSpaceDocType("doc")).toBe("word");
    expect(normalizeSpaceDocType("sheet")).toBe("excel");
    expect(normalizeSpaceDocType("smartcanvas")).toBe("smartcanvas");
  });
});

describe("canvas helpers", () => {
  test("normalizes canvas edit actions", () => {
    expect(normalizeCanvasEditAction("insert-before")).toBe("INSERT_BEFORE");
    expect(normalizeCanvasEditAction("append")).toBe("INSERT_AFTER");
    expect(normalizeCanvasEditAction("update")).toBe("UPDATE");
    expect(normalizeCanvasEditAction("delete")).toBe("DELETE");
  });

  test("normalizes smartcanvas content formats", () => {
    expect(normalizeSmartCanvasContentFormat("mdx")).toBe("mdx");
    expect(normalizeSmartCanvasContentFormat("MARKDOWN")).toBe("markdown");
    expect(() => normalizeSmartCanvasContentFormat("html")).toThrow('Unsupported smartcanvas format. Use "mdx" or "markdown".');
  });
});

describe("local import helpers", () => {
  test("detects Markdown and MDX files as smartcanvas sources", () => {
    expect(detectLocalDocImportStrategy("notes.md")).toEqual({ kind: "smartcanvas", contentFormat: "markdown" });
    expect(detectLocalDocImportStrategy("notes.MDX")).toEqual({ kind: "smartcanvas", contentFormat: "mdx" });
  });

  test("detects Tencent importable files", () => {
    expect(detectLocalDocImportStrategy("report.PDF")).toEqual({ kind: "import" });
    expect(detectLocalDocImportStrategy("slides.pptx")).toEqual({ kind: "import" });
  });

  test("derives default document titles from local paths", () => {
    expect(defaultImportedDocTitle("/tmp/notes.md")).toBe("notes");
    expect(defaultImportedDocTitle("/tmp/report.pdf")).toBe("report.pdf");
  });

  test("rejects unsupported local file types", () => {
    expect(() => detectLocalDocImportStrategy("archive.zip")).toThrow('Unsupported local file type ".zip".');
  });
});

describe("raw helper", () => {
  test("parses object json only", () => {
    expect(parseJsonObject("{\"a\":1}")).toEqual({ a: 1 });
    expect(() => parseJsonObject("[]")).toThrow("JSON arguments must be an object.");
    expect(() => parseJsonObject("{")).toThrow("Invalid JSON arguments:");
  });
});

describe("fetch retry helper", () => {
  test("retries retryable HTTP responses and respects Retry-After", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("busy", {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", { method: "POST" }, {
      maxAttempts: 2,
      fetchImpl,
      sleep: async ms => {
        delays.push(ms);
      },
      random: () => 0,
    });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  test("retries fetch failures with exponential backoff", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("socket hang up");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", { method: "PUT" }, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      fetchImpl,
      sleep: async ms => {
        delays.push(ms);
      },
      random: () => 0,
    });

    expect(response.status).toBe(200);
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test("does not retry network failures when retryNetworkErrors=false", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.com", { method: "POST" }, {
        maxAttempts: 4,
        retryNetworkErrors: false,
        fetchImpl,
        sleep: async () => {},
        random: () => 0,
      }),
    ).rejects.toThrow("socket hang up");
    expect(attempts).toBe(1);
  });

  test("does not retry non-retryable HTTP responses", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const fetchImpl = (async () => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", { method: "GET" }, {
      maxAttempts: 3,
      fetchImpl,
      sleep: async ms => {
        delays.push(ms);
      },
      random: () => 0,
    });

    expect(response.status).toBe(400);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });
});
