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
  compileStatus(token: string, projectId: string, branch: string): Promise<any>;
}
