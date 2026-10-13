export interface AldineUser {
  id: string;
  name: string;
  email: string | null;
}

export interface Identity {
  authEnabled: boolean;
  user: AldineUser;
  /** Only the `aldine_session` cookie, forwarded to Aldine for this request; never stored. */
  cookie: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  rootFile: string | null;
  branches: string[];
}

export interface ReviewComment {
  id: string;
  branch: string;
  file: string;
  anchor: { from: number; to: number; quote: string };
  author: string;
  body: string;
  suggestion?: string;
  resolved: boolean;
  createdAt: string;
  replies: { author: string; body: string; createdAt?: string }[];
}

export interface ToolCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A tool refusal from Aldine (isError result): a sentence meant for the model or the user. */
export class AldineToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AldineToolError';
  }
}

/** Everything the gateway needs from Aldine. HttpAldine talks to a real server; tests use a fake. */
export interface AldineApi {
  /** null when Aldine has auth on and the cookie is missing or expired. */
  whoami(cookie: string): Promise<Identity | null>;
  /** null when the project does not exist or this user may not open it. */
  project(identity: Identity, projectId: string): Promise<ProjectInfo | null>;
  /** A bearer credential acting as this user on this project only. */
  credential(identity: Identity, projectId: string): Promise<string>;
  callTool(token: string, name: string, args: Record<string, unknown>, opts?: ToolCallOptions): Promise<any>;
  /** Whether Aldine's tool `name` declares input parameter `param` (an older server would ignore, not refuse, an unknown one). */
  toolHasParam(token: string, name: string, param: string): Promise<boolean>;
  compileStatus(token: string, projectId: string, branch: string): Promise<any>;
  /** Review comments on a branch (Aldine's Review tab). */
  listComments(token: string, projectId: string, branch: string): Promise<ReviewComment[]>;
  /** Posts a reply as "<user> (via <agent label>)". */
  replyComment(token: string, projectId: string, commentId: string, body: string): Promise<void>;
  resolveComment(token: string, projectId: string, commentId: string): Promise<void>;
  /** A project file's bytes (images for view_image); null when it does not exist. */
  readBinary(token: string, projectId: string, branch: string, path: string): Promise<{ mediaType: string; data: Buffer } | null>;
}
