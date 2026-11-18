// mcp.ts — Model Context Protocol over streamable HTTP (2026-07-28 modern
// era, with a legacy initialize fallback). One POST /mcp endpoint, JSON-RPC
// 2.0 bodies, no session. Tools run against the same Store as REST/GraphQL.

import {
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_NAME = 'forge';
export const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, defined once: tools/list must be byte-identical every time. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function toolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required) {
    const v = args[name];
    if (v === undefined || v === null || v === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = missingRequired(tool, args);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const repoName = asStr(args.name);
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError('Invalid repository name');
      const created = store.createRepo(repoName, args.private === true, asStr(args.description));
      if (created === null) return toolError('Repository already exists');
      return toolResult(repoJson(store, created));
    }
    case 'get_repo': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (repo === undefined) return toolError('Repository not found');
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (repo === undefined) return toolError('Repository not found');
      const title = asStr(args.title);
      if (title === '') return toolError('Missing required argument: title');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = { number, title, body: asStr(args.body), state: 'open', labels: [], comments: [], seq: number };
      repo.issues.set(number, issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (repo === undefined) return toolError('Repository not found');
      const state = asStr(args.state, 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.seq - b.seq);
      return toolResult(list.map((i) => issueJson(store, repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (repo === undefined) return toolError('Repository not found');
      const head = asStr(args.head);
      const base = asStr(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return toolError('A pull request already exists for this head and base');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: Pull = {
        number,
        title: asStr(args.title),
        body: asStr(args.body),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: number,
      };
      repo.pulls.set(number, pull);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(asStr(args.owner), asStr(args.repo));
      if (repo === undefined) return toolError('Repository not found');
      const number = asNum(args.pull_number);
      if (number === null) return toolError('Invalid pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state === 'closed') return toolError('Pull request is already closed');
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return toolError('Merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = sha;
      const { ts } = store.nextIdentity();
      pull.mergedAt = store.isoTs(ts);
      return toolResult(pullJson(store, repo, pull));
    }
    default:
      return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpOutcome {
  /** HTTP status. */
  status: number;
  /** JSON-RPC response object, or null for notifications (no body). */
  rpc: Record<string, unknown> | null;
}

/**
 * Handle one POST /mcp body (already read as text). `id` echoes the request's
 * id verbatim. Returns the HTTP status and the JSON-RPC response (or null
 * for a notification, which gets an empty 202).
 */
export function handleMcp(store: Store, bodyText: string): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      rpc: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      rpc: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};

  // Notifications carry no id: answer 202 with no body.
  if (req.id === undefined) {
    return { status: 202, rpc: null };
  }

  const result = (value: unknown): McpOutcome => ({ status: 200, rpc: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpOutcome => ({ status: 200, rpc: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [...MCP_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const outcome = callTool(store, toolName, args);
    const rpcError = (outcome as Record<string, unknown>).__rpcError;
    if (rpcError !== null && typeof rpcError === 'object') {
      const e = rpcError as { code: number; message: string };
      return error(e.code, e.message);
    }
    return result(outcome);
  }
  return error(-32601, `Method not found: ${method}`);
}

export { VIEWER_LOGIN };
export type { Repo };
