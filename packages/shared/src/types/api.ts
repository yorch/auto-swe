export interface ApiResponse<T> {
  data: T;
  error?: { code: string; message: string };
}

export interface CreateWorkRequestBody {
  externalTicketId: string;
  description: string;           // Human-readable description of what to implement
  repoIds: string[];
}

export interface CreateWorkRequestResponse {
  workRequestId: string;
  workflowIds: string[];
}

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
