/** Response of GET /api/health. Shared by the server and the web UI. */
export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  db: "ok" | "error";
  /** Number of applied database migrations. */
  migrations: number;
}

/** Response of GET /api/meta. Public, unauthenticated. */
export interface MetaResponse {
  name: "Muny";
  version: string;
  /** Link to the source code, required by AGPL-3.0 §13. */
  sourceUrl: string;
  license: "AGPL-3.0-only";
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "owner" | "member";
}

/** Response of GET /api/auth/status. */
export interface AuthStatusResponse {
  /** True on first run, before the owner account exists. */
  setupRequired: boolean;
  user: CurrentUser | null;
}

/** Standard error body for 4xx/5xx responses. */
export interface ApiErrorBody {
  error: string;
  issues?: { path: string; message: string }[];
}
