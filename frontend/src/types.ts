export interface User {
  id: number;
  username: string;
  email: string;
  role: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  user: User;
}

export interface SystemStatus {
  initialized: boolean;
  allow_registration: boolean;
}

export interface Provider {
  id: number;
  name: string;
  base_url: string | null;
  models: string[];
  enabled: boolean;
  is_default: boolean;
  use_thinking: boolean;
  max_tokens: number;
  api_key_masked: string;
}

export interface ModelOption {
  provider_id: number;
  provider: string;
  model: string;
  is_default: boolean;
}

export interface SessionSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ToolEvent {
  name: string;
  path: string;
  version: number;
}

export interface ChatMessage {
  id?: number;
  role: "user" | "assistant" | "error";
  content: string;
  tool_events?: ToolEvent[];
  created_at?: string;
}

export interface ArtifactFile {
  content: string;
  language: string;
}

export interface Artifact {
  version: number;
  files: Record<string, ArtifactFile>;
}
