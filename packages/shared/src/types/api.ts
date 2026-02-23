export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

// ── Auth ──

export interface LoginBody {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshBody {
  refreshToken: string;
}

// ── Work Requests ──

export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  slackChannel?: string;
}

export interface CreateWorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
}

// ── Epics (Phase 3) ──

export interface CreateEpicBody {
  externalTicketId: string;
  description: string;
  repoIds: string[];
  dependencyGraph: { repoId: string; dependsOn: string[] }[];
}

export interface CreateEpicResponse {
  epicWorkflowId: string;
  childWorkflowIds: Record<string, string>;
}

// ── Webhooks ──

export interface GitWebhookBody {
  action: string;
  pull_request?: {
    number: number;
    merged: boolean;
    head: { sha: string; ref: string };
    base: { repo: { full_name: string } };
  };
  repository: { full_name: string };
}

export interface CIWebhookBody {
  action: string;
  check_run?: {
    head_sha: string;
    conclusion: string;
    html_url: string;
  };
  repository: { full_name: string };
}
