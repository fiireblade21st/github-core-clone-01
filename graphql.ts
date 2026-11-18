// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: queries, mutations, aliases, variables, inline
// input objects, inline fragments, __type introspection and batched arrays.

import {
  VIEWER_LOGIN,
  commentGlobalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'var' | 'eof';

interface Tok {
  kind: TokKind;
  text: string;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'spread', text: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      toks.push({ kind: 'var', text: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', text: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      toks.push({ kind: 'name', text: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      toks.push({ kind: 'punct', text: c });
      i += 1;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(c)}`);
  }
  toks.push({ kind: 'eof', text: '' });
  return toks;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.pos] as Tok;
  }

  private next(): Tok {
    const t = this.toks[this.pos] as Tok;
    this.pos += 1;
    return t;
  }

  private expectPunct(text: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.text !== text) throw new Error(`graphql: expected ${text}, got ${t.text}`);
  }

  private expectName(text?: string): string {
    const t = this.next();
    if (t.kind !== 'name' || (text !== undefined && t.text !== text)) throw new Error(`graphql: expected name ${text ?? ''}, got ${t.text}`);
    return t.text;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().text === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().text === '(') this.parseArgs();
    }
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.text === '{') {
        doc.operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.text === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        doc.fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
      } else if (t.kind === 'name' && (t.text === 'query' || t.text === 'mutation' || t.text === 'subscription')) {
        const kind = this.next().text as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().text;
        const varDefs: OperationNode['varDefs'] = [];
        if (this.peek().kind === 'punct' && this.peek().text === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().text === ')')) {
            const varTok = this.next();
            if (varTok.kind !== 'var') throw new Error('graphql: expected variable in var defs');
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | undefined;
            if (this.peek().kind === 'punct' && this.peek().text === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            varDefs.push({ name: varTok.text, defaultValue });
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        doc.operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`graphql: unexpected token ${t.text}`);
      }
    }
    return doc;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().text === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().text === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().text === '}')) {
      if (this.peek().kind === 'eof') throw new Error('graphql: unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().text === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', name: null, typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition: null, selections: [] };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().text === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().text === '(' ? this.parseArgs() : [];
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().text === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const out: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().text === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'variable', name: t.text };
    if (t.kind === 'string') return { kind: 'string', value: t.text };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.text) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.text) };
    if (t.kind === 'name') {
      if (t.text === 'true') return { kind: 'boolean', value: true };
      if (t.text === 'false') return { kind: 'boolean', value: false };
      if (t.text === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.text };
    }
    if (t.kind === 'punct' && t.text === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().text === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.text === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().text === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`graphql: unexpected value token ${t.text}`);
  }
}

function valueOf(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema knowledge (for introspection and error messages)
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'closedAt', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'labels', 'branches', 'stargazerCount'];
const USER_FIELDS = ['id', 'login', 'name', 'email'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: USER_FIELDS,
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  __Type: ['name', 'fields', 'enumValues', 'kind'],
  __Field: ['name'],
  __EnumValue: ['name'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: SEARCH_TYPE_VALUES,
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
}

type Parent =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; login: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; filesNodes?: Parent[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: Parent }
  | { __typename: 'CloseIssuePayload'; issue: Parent }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: Parent }
  | { __typename: 'MergePullRequestPayload'; pullRequest: Parent }
  | { __typename: 'AddCommentPayload'; commentEdge: Parent }
  | { __typename: 'CommentEdge'; node: Parent }
  | { __typename: 'IssueComment'; id: string; body: string };

function argMap(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, ctx.vars);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^issue:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field on a parent object. Returns undefined when unknown. */
function resolveField(parent: Parent, field: FieldNode, ctx: Ctx): unknown {
  const { store } = ctx;
  const args = argMap(field, ctx);
  switch (parent.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        const repo = store.getRepoById(parsed.repoId);
        if (repo === undefined) return null;
        if (parsed.kind === 'R') return { __typename: 'Repository', repo };
        if (parsed.kind === 'I') {
          const issue = repo.issues.get(parsed.number);
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        if (parsed.kind === 'P') {
          const pull = repo.pulls.get(parsed.number);
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined || TYPE_ENUMS[name] !== undefined) return { __typename: '__Type', name };
        return null;
      }
      if (field.name === '__schema') return null;
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(args, ctx);
      if (field.name === 'closeIssue') return mutateCloseIssue(args, ctx);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(args, ctx);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(args, ctx);
      if (field.name === 'addComment') return mutateAddComment(args, ctx);
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.states;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((s) => String(s)));
            list = list.filter((i) => wanted.has(issueStateGql(i)));
          }
          const orderBy = args.orderBy;
          let desc = false;
          if (orderBy !== null && typeof orderBy === 'object') {
            const dir = (orderBy as Record<string, unknown>).direction;
            desc = dir === 'DESC';
          }
          list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
          const after = numberFromCursor(args.after);
          if (after !== null) list = desc ? list.filter((i) => i.number < after) : list.filter((i) => i.number > after);
          const first = typeof args.first === 'number' ? args.first : list.length;
          const page = list.slice(0, Math.max(0, first));
          const hasNextPage = list.length > page.length;
          const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
          return { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const first = typeof args.first === 'number' ? args.first : list.length;
          list.sort((a, b) => a.number - b.number);
          return { __typename: 'PullRequestConnection', repo, pulls: list.slice(0, Math.max(0, first)) };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(parent.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueStateGql(issue);
        case 'body':
          return issue.body;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(parent.repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'state':
          return pullStateGql(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable':
          return store.mergeableState(parent.repo, pull);
        case 'files': {
          const headSha = parent.repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
          const baseSha = parent.repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
          const files = store.diffFiles(parent.repo, baseSha, headSha);
          const first = typeof args.first === 'number' ? args.first : files.length;
          const nodes = files.slice(0, Math.max(0, first)).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename }) as Parent);
          return { __typename: 'PullRequestConnection', repo: parent.repo, pulls: [], filesNodes: nodes };
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return `U_${parent.login === VIEWER_LOGIN ? 1000 : 0}`;
      if (field.name === 'name') return parent.login === VIEWER_LOGIN ? 'ada iversen' : parent.login;
      return undefined;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.issues.map((i) => ({ __typename: 'Issue', repo: parent.repo, issue: i }) as Parent);
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor };
      }
      if (field.name === 'totalCount') return parent.issues.length;
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        if (parent.filesNodes !== undefined) return parent.filesNodes;
        return parent.pulls.map((p) => ({ __typename: 'PullRequest', repo: parent.repo, pull: p }) as Parent);
      }
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (field.name === 'totalCount') return parent.pulls.length;
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path;
      return undefined;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return undefined;
    }
    case '__Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return TYPE_ENUMS[parent.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[parent.name] ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }) as unknown as Parent);
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUMS[parent.name] ?? [];
        return names.map((n) => ({ __typename: '__EnumValue', name: n }) as unknown as Parent);
      }
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return parent.commentEdge;
      return undefined;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return parent.node;
      return undefined;
    }
    case 'IssueComment': {
      if (field.name === 'id') return parent.id;
      if (field.name === 'body') return parent.body;
      return undefined;
    }
  }
  return undefined;
}

// __Field / __EnumValue parents are handled by a small shim in executeSelections.
type AnyParent = Parent | { __typename: '__Field'; name: string } | { __typename: '__EnumValue'; name: string };

function executeSelections(parent: AnyParent, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      let fragSelections: SelectionNode[] = sel.selections;
      if (sel.name !== null) {
        const frag = ctx.fragments.get(sel.name);
        if (frag === undefined) continue;
        fragSelections = frag.selections;
      }
      if (sel.typeCondition !== null && sel.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, fragSelections, ctx));
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    let value: unknown;
    if (parent.__typename === '__Field' || parent.__typename === '__EnumValue') {
      value = sel.name === 'name' ? parent.name : undefined;
    } else {
      value = resolveField(parent as Parent, sel, ctx);
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parent.__typename}".` });
      continue;
    }
    out[responseKey] = executeValue(value, sel.selections, ctx);
  }
  return out;
}

function executeValue(value: unknown, selections: SelectionNode[], ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => executeValue(v, selections, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (selections.length === 0) return value;
    return executeSelections(value as AnyParent, selections, ctx);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function mutateCreateIssue(args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = inputOf(args);
  const parsed = parseGlobalId(String(input.repositoryId ?? ''));
  if (parsed === null || parsed.kind !== 'R') {
    ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.repoId);
  if (repo === undefined) {
    ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
    return null;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
    state: 'open',
    labels: [],
    comments: [],
    seq: number,
  };
  repo.issues.set(number, issue);
  return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
}

function mutateCloseIssue(args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = inputOf(args);
  const parsed = parseGlobalId(String(input.issueId ?? ''));
  if (parsed === null || parsed.kind !== 'I') {
    ctx.errors.push({ message: 'closeIssue: unknown issueId' });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.repoId);
  const issue = repo?.issues.get(parsed.number);
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'closeIssue: unknown issueId' });
    return null;
  }
  issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
}

function mutateCreatePullRequest(args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = inputOf(args);
  const parsed = parseGlobalId(String(input.repositoryId ?? ''));
  if (parsed === null || parsed.kind !== 'R') {
    ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.repoId);
  if (repo === undefined) {
    ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
    return null;
  }
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) {
    ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
    return null;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
      return null;
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    title: String(input.title ?? ''),
    body: String(input.body ?? ''),
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
}

function mutateMergePullRequest(args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = inputOf(args);
  const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
  if (parsed === null || parsed.kind !== 'P') {
    ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.repoId);
  const pull = repo?.pulls.get(parsed.number);
  if (repo === undefined || pull === undefined) {
    ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
    return null;
  }
  if (pull.state === 'closed') {
    ctx.errors.push({ message: 'mergePullRequest: pull request is already closed' });
    return null;
  }
  const sha = ctx.store.squashMerge(repo, pull);
  if (sha === null) {
    ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
    return null;
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  const { ts } = ctx.store.nextIdentity();
  pull.mergedAt = ctx.store.isoTs(ts);
  return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
}

function mutateAddComment(args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = inputOf(args);
  const parsed = parseGlobalId(String(input.subjectId ?? ''));
  if (parsed === null || parsed.kind !== 'I') {
    ctx.errors.push({ message: 'addComment: unknown subjectId' });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.repoId);
  const issue = repo?.issues.get(parsed.number);
  if (repo === undefined || issue === undefined) {
    ctx.errors.push({ message: 'addComment: unknown subjectId' });
    return null;
  }
  const comment = { id: repo.nextCommentId, body: String(input.body ?? ''), user: VIEWER_LOGIN };
  repo.nextCommentId += 1;
  issue.comments.push(comment);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'CommentEdge',
      node: { __typename: 'IssueComment', id: commentGlobalId(repo, issue, comment), body: comment.body },
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(store: Store, doc: DocumentNode, op: OperationNode, vars: Record<string, unknown>): GqlResult {
  const ctx: Ctx = { store, vars, errors: [], fragments: doc.fragments };
  // Apply variable defaults.
  for (const def of op.varDefs) {
    if (ctx.vars[def.name] === undefined && def.defaultValue !== undefined) ctx.vars[def.name] = valueOf(def.defaultValue, {});
  }
  const root: Parent = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(root, op.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Execute one {query, variables, operationName?} body. */
export function executeGraphQL(store: Store, body: unknown): GqlResult | GqlResult[] | { errors: Array<{ message: string }> } {
  if (Array.isArray(body)) {
    return body.map((entry) => executeGraphQL(store, entry) as GqlResult);
  }
  if (body === null || typeof body !== 'object') return { errors: [{ message: 'GraphQL request body must be an object' }] };
  const query = (body as Record<string, unknown>).query;
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'GraphQL request needs a query string' }] };
  const variables = (body as Record<string, unknown>).variables;
  const vars: Record<string, unknown> =
    variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
  }
  const operationName = (body as Record<string, unknown>).operationName;
  let op: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    op = doc.operations.find((o) => o.name === operationName);
  } else {
    op = doc.operations[0];
  }
  if (op === undefined) return { errors: [{ message: 'GraphQL operation not found' }] };
  return executeOperation(store, doc, op, vars);
}
