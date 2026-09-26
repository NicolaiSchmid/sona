-- 0009_auth: invite-only authentication, sessions, TOTP, and scoped API tokens.
--
-- Nothing here stores a plaintext secret. Passwords are scrypt PHC strings,
-- invite/session/API tokens are SHA-256 digests, TOTP secrets are AES-GCM
-- ciphertext, recovery codes are digests. Same portable SQL subset as
-- 0001_core (TEXT ids/timestamps, INTEGER counters).

-- Per-user password credential, separate from `users` so the identity row
-- never carries a hash.
CREATE TABLE IF NOT EXISTS user_credentials (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  password_hash  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- One TOTP enrollment per user. `last_used_step` is the replay guard: a code
-- is accepted only if its RFC 6238 step is strictly greater.
CREATE TABLE IF NOT EXISTS user_totp_enrollments (
  user_id            TEXT PRIMARY KEY REFERENCES users(id),
  secret_ciphertext  TEXT NOT NULL,
  last_used_step     INTEGER NOT NULL DEFAULT -1,
  created_at         TEXT NOT NULL,
  confirmed_at       TEXT
);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON user_recovery_codes(user_id);

-- Admin-created, single-use, expiring invites. `accepted_at` is set by a
-- conditional update so two concurrent accepts cannot both succeed. The
-- claim happens before the new user row exists (claim-first fails safe), so
-- `accepted_by_user_id` deliberately carries no foreign key.
CREATE TABLE IF NOT EXISTS workspace_invites (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  email                TEXT NOT NULL,
  role                 TEXT NOT NULL,
  token_hash           TEXT NOT NULL UNIQUE,
  created_by_user_id   TEXT NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  accepted_at          TEXT,
  accepted_by_user_id  TEXT,
  revoked_at           TEXT,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id, created_at);

-- Opaque session tokens (hashed) with sliding and absolute expiry.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  token_hash           TEXT NOT NULL UNIQUE,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  absolute_expires_at  TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  revoked_at           TEXT,
  client_label         TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, created_at);

-- Workspace-bound agent tokens. Scopes are a JSON array of the literal scope
-- vocabulary; effective rights are further capped by the creator's role at
-- resolution time.
CREATE TABLE IF NOT EXISTS api_tokens (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  name                TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,
  scopes_json         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  last_used_at        TEXT,
  revoked_at          TEXT,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_workspace ON api_tokens(workspace_id, created_at);
