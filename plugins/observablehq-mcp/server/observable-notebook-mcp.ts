#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import { z } from "zod";

const SERVER_NAME = "observable-notebook-mcp";
const SERVER_VERSION = "0.1.0";
const API_BASE_URL =
  process.env.OBSERVABLE_API_BASE_URL ?? "https://api.observablehq.com";
const WS_BASE_URL =
  process.env.OBSERVABLE_WS_BASE_URL ?? "wss://ws.observablehq.com";
const WEB_BASE_URL =
  process.env.OBSERVABLE_WEB_BASE_URL ?? "https://observablehq.com";
const USER_AGENT =
  process.env.OBSERVABLE_USER_AGENT ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_COOKIE = process.env.OBSERVABLE_COOKIE;

type ObservableOwner = {
  id?: string;
  login?: string;
  name?: string;
  type?: string;
};

type ObservableFile = {
  id?: string;
  name: string;
  path?: string;
  size?: number | null;
};

type ObservableNode = {
  id: number;
  mode?: string | null;
  pinned?: boolean;
  value?: string | null;
  name?: string | null;
};

type ObservableEdit = {
  node_id: number;
  value: string;
};

type ObservableDocument = {
  id: string;
  slug?: string;
  title?: string;
  latest_version?: number;
  publish_version?: number;
  version?: number;
  update_time?: string;
  publish_level?: string;
  sharing?: string;
  roles?: string[];
  owner?: ObservableOwner;
  creator?: ObservableOwner;
  nodes?: ObservableNode[];
  edits?: ObservableEdit[];
  files?: ObservableFile[];
};

type MergedCell = {
  index: number;
  nodeId: number;
  name: string | null;
  explicitName: string | null;
  mode: string | null;
  pinned: boolean;
  value: string;
};

type CellSelector = {
  nodeId?: number;
  name?: string;
  index?: number;
};

type ListCellsOptions = {
  includeCode?: boolean;
};

type SaveLoadMessage = {
  type: "load";
  version: number;
  subversion: number;
  events?: unknown[];
  edits?: Array<{ node_id: number; value?: string }>;
};

type SaveConfirmMessage = {
  type: "saveconfirm";
  version: number;
  subversion: number;
};

type WriteAccessInfo = {
  writable: boolean;
  source: "roles" | "websocket-probe" | "none";
};

function asTextResult(text: string, structuredContent?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function normalizeNotebookSpecifier(notebook: string) {
  const trimmed = notebook.trim();
  if (!trimmed) throw new Error("Notebook identifier is required");

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (!url.hostname.endsWith("observablehq.com")) {
      throw new Error(`Unsupported notebook host: ${url.hostname}`);
    }
    return url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildDocumentUrl(notebook: string) {
  const specifier = normalizeNotebookSpecifier(notebook);
  return `${API_BASE_URL}/document/${specifier}`;
}

function getCookieHeader(cookie?: string) {
  return cookie?.trim() || DEFAULT_COOKIE?.trim() || undefined;
}

function buildHeaders(cookie?: string) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };

  const cookieHeader = getCookieHeader(cookie);
  if (cookieHeader) headers.cookie = cookieHeader;

  return headers;
}

function ensureTokenCookie(cookie?: string) {
  const baseCookieHeader = getCookieHeader(cookie)?.trim() ?? "";
  const existingMatch = /(?:^|;)\s*T\s*=\s*([0-9a-f]{32})(?:$|;)/i.exec(
    baseCookieHeader,
  );
  if (existingMatch?.[1]) {
    return {
      token: existingMatch[1],
      cookieHeader: baseCookieHeader,
    };
  }

  const token = randomBytes(16).toString("hex");
  return {
    token,
    cookieHeader: baseCookieHeader
      ? `${baseCookieHeader}; T=${token}`
      : `T=${token}`,
  };
}

async function fetchJson<T>(url: string, cookie?: string): Promise<T> {
  const response = await fetch(url, {
    headers: buildHeaders(cookie),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Observable API request failed (${response.status}) for ${url}: ${text.slice(0, 500)}`,
    );
  }

  return JSON.parse(text) as T;
}

async function fetchDocument(notebook: string, cookie?: string) {
  return await fetchJson<ObservableDocument>(
    buildDocumentUrl(notebook),
    cookie,
  );
}

function inferCellName(value: string, mode: string | null | undefined) {
  if (mode !== "js") return null;

  const patterns = [
    /^\s*viewof\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*mutable\s+([A-Za-z_$][\w$]*)\s*=/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*class\s+([A-Za-z_$][\w$]*)\b/,
    /^\s*([A-Za-z_$][\w$]*)\s*=/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function mergeCells(document: ObservableDocument): MergedCell[] {
  const nodes = document.nodes ?? [];
  const edits = new Map<number, string>(
    (document.edits ?? []).map((edit) => [edit.node_id, edit.value]),
  );

  return nodes.map((node, index) => {
    const value = edits.get(node.id) ?? node.value ?? "";
    const explicitName = node.name ?? null;

    return {
      index,
      nodeId: node.id,
      name: explicitName ?? inferCellName(value, node.mode ?? null),
      explicitName,
      mode: node.mode ?? null,
      pinned: Boolean(node.pinned),
      value,
    };
  });
}

function summarizeCell(cell: MergedCell, options: ListCellsOptions = {}) {
  const preview =
    cell.value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 120) ?? "";

  return {
    index: cell.index,
    nodeId: cell.nodeId,
    name: cell.name,
    explicitName: cell.explicitName,
    mode: cell.mode,
    pinned: cell.pinned,
    lines: cell.value.split("\n").length,
    preview,
    ...(options.includeCode ? { value: cell.value } : {}),
  };
}

function resolveCell(cells: MergedCell[], selector: CellSelector) {
  const selectorCount = [selector.nodeId, selector.name, selector.index].filter(
    (value) => value !== undefined,
  ).length;
  if (selectorCount !== 1) {
    throw new Error("Provide exactly one of nodeId, name, or index");
  }

  if (selector.nodeId !== undefined) {
    const cell = cells.find((item) => item.nodeId === selector.nodeId);
    if (!cell) throw new Error(`No cell found with nodeId ${selector.nodeId}`);
    return cell;
  }

  if (selector.index !== undefined) {
    const cell = cells[selector.index];
    if (!cell) throw new Error(`No cell found at index ${selector.index}`);
    return cell;
  }

  const matches = cells.filter((item) => item.name === selector.name);
  if (matches.length === 0)
    throw new Error(`No cell found with name ${JSON.stringify(selector.name)}`);
  if (matches.length > 1) {
    throw new Error(
      `Multiple cells found with name ${JSON.stringify(selector.name)}: ${matches.map((match) => match.nodeId).join(", ")}`,
    );
  }

  return matches[0]!;
}

function resolveCells(cells: MergedCell[], selectors: CellSelector[]) {
  if (selectors.length === 0) {
    throw new Error("Provide at least one selector");
  }

  return selectors.map((selector) => resolveCell(cells, selector));
}

function replaceText({
  value,
  oldText,
  newText,
  replaceAll,
}: {
  value: string;
  oldText: string;
  newText: string;
  replaceAll: boolean;
}) {
  if (!oldText) throw new Error("oldText must not be empty");

  const occurrences = value.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error("oldText was not found in the selected cell");
  }

  if (!replaceAll && occurrences > 1) {
    throw new Error(
      `oldText matched ${occurrences} times; pass replaceAll=true or use set_cell with an exact value`,
    );
  }

  return {
    occurrences,
    value: replaceAll
      ? value.split(oldText).join(newText)
      : value.replace(oldText, newText),
  };
}

function assertWritable(cookie?: string) {
  if (!getCookieHeader(cookie)) {
    throw new Error(
      "This write operation requires OBSERVABLE_COOKIE in the MCP server environment (or a cookie argument if you extend the server). " +
        "Copy the Cookie request header from an authenticated observablehq.com request in your browser DevTools.",
    );
  }
}

async function openEditSocket(
  documentId: string,
  version: number,
  cookie?: string,
) {
  assertWritable(cookie);

  const url = `${WS_BASE_URL}/document/${documentId}/edit`;
  const { token, cookieHeader } = ensureTokenCookie(cookie);
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Origin: WEB_BASE_URL,
    "User-Agent": USER_AGENT,
  };

  return await new Promise<{ socket: WebSocket; load: SaveLoadMessage }>(
    (resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        socket.close();
        reject(new Error("Timed out opening Observable edit websocket"));
      }, 15_000);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          socket.close();
        } catch {
          // noop
        }
        reject(error);
      };

      const succeed = (load: SaveLoadMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ socket, load });
      };

      socket.on("open", () => {
        socket.send(
          JSON.stringify({ type: "hello", token, version, next: true }),
        );
      });

      socket.on("message", (raw) => {
        try {
          const text = raw.toString();
          const message = JSON.parse(text) as {
            type?: string;
            status?: number;
            message?: string;
          } & SaveLoadMessage;

          if (message.type === "error") {
            fail(
              new Error(
                `Observable websocket error${message.status ? ` (${message.status})` : ""}: ${message.message ?? text}`,
              ),
            );
            return;
          }

          if (message.type === "load") {
            succeed(message);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.on("error", (error) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
      socket.on("close", (code, reason) => {
        if (!settled && code !== 1000) {
          fail(
            new Error(
              `Observable websocket closed unexpectedly (${code}): ${reason.toString()}`,
            ),
          );
        }
      });
    },
  );
}

function getDocumentVersion(document: ObservableDocument) {
  return (
    document.latest_version ?? document.publish_version ?? document.version
  );
}

async function detectWriteAccess(
  document: ObservableDocument,
  cookie?: string,
): Promise<WriteAccessInfo> {
  if (
    (document.roles ?? []).some((role) => role === "editor" || role === "owner")
  ) {
    return { writable: true, source: "roles" };
  }

  if (!getCookieHeader(cookie)) {
    return { writable: false, source: "none" };
  }

  const version = getDocumentVersion(document);
  if (version === undefined) {
    return { writable: false, source: "none" };
  }

  try {
    const { socket } = await openEditSocket(document.id, version, cookie);
    socket.close();
    return { writable: true, source: "websocket-probe" };
  } catch {
    return { writable: false, source: "websocket-probe" };
  }
}

async function saveCellValue(args: {
  notebook: string;
  value: string;
  selector: CellSelector;
  expectedValue?: string;
  cookie?: string;
}) {
  const document = await fetchDocument(args.notebook, args.cookie);
  const cells = mergeCells(document);
  const target = resolveCell(cells, args.selector);

  if (args.expectedValue !== undefined && target.value !== args.expectedValue) {
    throw new Error(
      "Cell value does not match expectedValue; refusing to overwrite",
    );
  }

  const version = getDocumentVersion(document);
  if (version === undefined) {
    throw new Error("Could not determine notebook version");
  }

  const { socket, load } = await openEditSocket(
    document.id,
    version,
    args.cookie,
  );

  try {
    const payload = {
      type: "save",
      events: [
        {
          version: load.version + 1,
          type: "modify_node",
          node_id: target.nodeId,
          new_node_value: args.value,
        },
      ],
      edits: [],
      version: load.version,
      subversion: load.subversion,
    };

    const confirmation = await new Promise<SaveConfirmMessage>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for save confirmation")),
          15_000,
        );

        const onMessage = (raw: WebSocket.RawData) => {
          try {
            const text = raw.toString();
            const message = JSON.parse(text) as SaveConfirmMessage & {
              type?: string;
              status?: number;
              message?: string;
            };

            if (message.type === "error") {
              clearTimeout(timeout);
              socket.off("message", onMessage);
              reject(
                new Error(
                  `Observable save error${message.status ? ` (${message.status})` : ""}: ${message.message ?? text}`,
                ),
              );
              return;
            }

            if (message.type === "saveconfirm") {
              clearTimeout(timeout);
              socket.off("message", onMessage);
              resolve(message);
            }
          } catch (error) {
            clearTimeout(timeout);
            socket.off("message", onMessage);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        };

        socket.on("message", onMessage);
        socket.send(JSON.stringify(payload));
      },
    );

    return {
      notebook: {
        id: document.id,
        slug: document.slug,
        title: document.title,
      },
      cell: summarizeCell({ ...target, value: args.value }),
      previousLength: target.value.length,
      newLength: args.value.length,
      version: confirmation.version,
      subversion: confirmation.subversion,
    };
  } finally {
    socket.close();
  }
}

async function summarizeDocument(
  document: ObservableDocument,
  cookie?: string,
) {
  const cells = mergeCells(document);
  const writeAccess = await detectWriteAccess(document, cookie);

  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    owner: document.owner?.login,
    publishLevel: document.publish_level,
    sharing: document.sharing,
    roles: document.roles ?? [],
    latestVersion: getDocumentVersion(document) ?? null,
    updateTime: document.update_time ?? null,
    cellCount: cells.length,
    fileCount: document.files?.length ?? 0,
    writable: writeAccess.writable,
    writableSource: writeAccess.source,
    files: (document.files ?? []).map((file) => ({
      id: file.id ?? null,
      name: file.name,
      path: file.path ?? null,
      size: file.size ?? null,
    })),
  };
}

export async function getNotebookSummary(notebook: string, cookie?: string) {
  const document = await fetchDocument(notebook, cookie);
  return await summarizeDocument(document, cookie);
}

export async function listNotebookCells(
  notebook: string,
  options: ListCellsOptions = {},
  cookie?: string,
) {
  const document = await fetchDocument(notebook, cookie);
  return {
    notebook: await summarizeDocument(document, cookie),
    cells: mergeCells(document).map((cell) => summarizeCell(cell, options)),
  };
}

export async function getNotebookCell(
  notebook: string,
  selector: CellSelector,
  cookie?: string,
) {
  const document = await fetchDocument(notebook, cookie);
  const cells = mergeCells(document);
  const cell = resolveCell(cells, selector);

  return {
    notebook: {
      id: document.id,
      slug: document.slug,
      title: document.title,
    },
    cell: summarizeCell(cell, { includeCode: true }),
  };
}

export async function getNotebookCells(args: {
  notebook: string;
  selectors: CellSelector[];
  cookie?: string;
}) {
  const document = await fetchDocument(args.notebook, args.cookie);
  const cells = mergeCells(document);
  const selected = resolveCells(cells, args.selectors);

  return {
    notebook: {
      id: document.id,
      slug: document.slug,
      title: document.title,
    },
    cellCount: selected.length,
    cells: selected.map((cell) => summarizeCell(cell, { includeCode: true })),
  };
}

export async function findNotebookCells(args: {
  notebook: string;
  query: string;
  caseSensitive?: boolean;
  cookie?: string;
}) {
  const { notebook, query, caseSensitive = false, cookie } = args;
  if (!query.trim()) throw new Error("query must not be empty");

  const document = await fetchDocument(notebook, cookie);
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const cells = mergeCells(document).filter((cell) => {
    const haystack = `${cell.name ?? ""}\n${cell.value}`;
    return (caseSensitive ? haystack : haystack.toLowerCase()).includes(
      normalizedQuery,
    );
  });

  return {
    notebook: {
      id: document.id,
      slug: document.slug,
      title: document.title,
    },
    query,
    caseSensitive,
    matchCount: cells.length,
    cells: cells.map((cell) => summarizeCell(cell)),
  };
}

export async function setNotebookCell(args: {
  notebook: string;
  value: string;
  selector: CellSelector;
  expectedValue?: string;
  cookie?: string;
}) {
  return await saveCellValue(args);
}

export async function replaceNotebookCellText(args: {
  notebook: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  selector: CellSelector;
  cookie?: string;
}) {
  const document = await fetchDocument(args.notebook, args.cookie);
  const cells = mergeCells(document);
  const target = resolveCell(cells, args.selector);
  const replacement = replaceText({
    value: target.value,
    oldText: args.oldText,
    newText: args.newText,
    replaceAll: Boolean(args.replaceAll),
  });

  const saved = await saveCellValue({
    notebook: args.notebook,
    selector: args.selector,
    value: replacement.value,
    expectedValue: target.value,
    cookie: args.cookie,
  });

  return {
    ...saved,
    replacedOccurrences: replacement.occurrences,
  };
}

function registerTools(server: McpServer) {
  server.registerTool(
    "observable_get_notebook",
    {
      description:
        "Get Observable notebook metadata, permissions, and file attachments.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
      },
    },
    async ({ notebook }) => {
      const result = await getNotebookSummary(notebook);
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_list_cells",
    {
      description:
        "List notebook cells with node ids, names, languages, and previews. Optionally include full source code for each cell.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        includeCode: z
          .boolean()
          .optional()
          .describe("Include full source code for each returned cell"),
      },
    },
    async ({ notebook, includeCode }) => {
      const result = await listNotebookCells(notebook, { includeCode });
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_find_cells",
    {
      description: "Search notebook cells by name or source text.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        query: z
          .string()
          .describe("Substring to search for in cell names and source code"),
        caseSensitive: z
          .boolean()
          .optional()
          .describe("Whether to match with case sensitivity"),
      },
    },
    async ({ notebook, query, caseSensitive }) => {
      const result = await findNotebookCells({
        notebook,
        query,
        caseSensitive,
      });
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_get_cell",
    {
      description: "Read a single notebook cell by nodeId, name, or index.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        nodeId: z
          .number()
          .int()
          .optional()
          .describe("Numeric Observable node id"),
        name: z
          .string()
          .optional()
          .describe("Exact Observable cell name/variable name"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based cell index in notebook order"),
      },
    },
    async ({ notebook, nodeId, name, index }) => {
      const result = await getNotebookCell(notebook, { nodeId, name, index });
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_get_cells",
    {
      description:
        "Read multiple notebook cells in one call. Each selector must include exactly one of nodeId, name, or index.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        selectors: z
          .array(
            z.object({
              nodeId: z
                .number()
                .int()
                .optional()
                .describe("Numeric Observable node id"),
              name: z
                .string()
                .optional()
                .describe("Exact Observable cell name/variable name"),
              index: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Zero-based cell index in notebook order"),
            }),
          )
          .min(1)
          .describe("List of cell selectors to fetch in one call"),
      },
    },
    async ({ notebook, selectors }) => {
      const result = await getNotebookCells({ notebook, selectors });
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_set_cell",
    {
      description:
        "Replace the full source code of a single Observable cell. Requires OBSERVABLE_COOKIE in the server environment.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        nodeId: z
          .number()
          .int()
          .optional()
          .describe("Numeric Observable node id"),
        name: z
          .string()
          .optional()
          .describe("Exact Observable cell name/variable name"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based cell index in notebook order"),
        value: z.string().describe("Full replacement source for the cell"),
        expectedValue: z
          .string()
          .optional()
          .describe(
            "Optional optimistic concurrency check; write only if the current cell matches this exact value",
          ),
      },
    },
    async ({ notebook, nodeId, name, index, value, expectedValue }) => {
      const result = await setNotebookCell({
        notebook,
        selector: { nodeId, name, index },
        value,
        expectedValue,
      });
      return asTextResult(jsonText(result), result);
    },
  );

  server.registerTool(
    "observable_replace_in_cell",
    {
      description:
        "Replace exact text within one Observable cell and save it back. Safer than full-cell overwrite for targeted edits. Requires OBSERVABLE_COOKIE in the server environment.",
      inputSchema: {
        notebook: z
          .string()
          .describe(
            "Observable notebook URL, slug like @user/notebook, or document id",
          ),
        nodeId: z
          .number()
          .int()
          .optional()
          .describe("Numeric Observable node id"),
        name: z
          .string()
          .optional()
          .describe("Exact Observable cell name/variable name"),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Zero-based cell index in notebook order"),
        oldText: z.string().describe("Exact source text to replace"),
        newText: z.string().describe("Replacement text"),
        replaceAll: z
          .boolean()
          .optional()
          .describe(
            "Replace every occurrence instead of requiring a unique match",
          ),
      },
    },
    async ({ notebook, nodeId, name, index, oldText, newText, replaceAll }) => {
      const result = await replaceNotebookCellText({
        notebook,
        selector: { nodeId, name, index },
        oldText,
        newText,
        replaceAll,
      });
      return asTextResult(jsonText(result), result);
    },
  );
}

export async function startServer() {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startServer().catch((error) => {
    console.error(`[${SERVER_NAME}]`, error);
    process.exit(1);
  });
}
