# Feature Parity: Original (main) → AWS Migration (feature/aws-migration)

Tracks every API endpoint and key feature from the original Supabase-backed codebase (`d969096`) against the current AWS migration. Use this to confirm nothing is silently dropped.

**Status legend:**
- ✅ Migrated — equivalent functionality present
- ⚠️ Changed — present but behaviour differs (noted below)
- ❌ Not yet migrated — missing
- 🚫 Intentionally skipped — dropped with documented reason

---

## Chat (`/chat`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/` | List user chats | ✅ | |
| POST | `/create` | Create chat row | ✅ | |
| GET | `/:chatId` | Fetch chat + messages + annotations | ✅ | |
| PATCH | `/:chatId` | Update chat metadata | ✅ | |
| DELETE | `/:chatId` | Delete chat | ✅ | Also deletes S3 session objects (AWS addition) |
| POST | `/:chatId/generate-title` | Generate/store title via AI | ✅ | |
| POST | `/` | Stream AI chat (Supabase AI proxy) | ⚠️ | Original proxied to Supabase AI edge function. Migration: frontend calls AgentCore Runtime directly with Cognito JWT. Backend `POST /` removed — not needed in AWS arch |
| GET | `/:chatId/messages` | Fetch messages for a chat | ✅ | Added in migration (was embedded in GET /:chatId in original) |
| GET | `/:chatId/session-id` | Fetch AgentCore session ID | ✅ | New endpoint specific to AWS AgentCore session continuity |
| PUT | `/:chatId/session-id` | Store AgentCore session ID | ✅ | New endpoint specific to AWS AgentCore session continuity |

---

## Single Documents (`/single-documents`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/` | List user documents | ✅ | |
| POST | `/prepare` + `/:documentId/register` | Upload document | ✅ | Frontend calls `/prepare` (creates DB row, returns S3 key), uploads directly to S3 via Amplify `uploadData` (Identity Pool creds), then calls `/register` to create version row. Conversion Lambda handles DOCX→PDF via EventBridge. |
| DELETE | `/:documentId` | Delete document + S3 objects | ✅ | |
| GET | `/:documentId/display` | Fetch display metadata | ✅ | |
| POST | `/download-zip` | Download multiple docs as ZIP | ✅ | |
| GET | `/:documentId/url` | Get presigned URL for doc | ✅ | |
| GET | `/:documentId/docx` | Stream DOCX bytes | ✅ | |
| GET | `/:documentId/versions` | List document versions | ✅ | |
| POST | `/:documentId/versions` | Create new version | ✅ | |
| PATCH | `/:documentId/versions/:versionId` | Update version metadata | ✅ | |
| GET | `/:documentId/tracked-change-ids` | Fetch tracked change IDs | ✅ | |
| POST | `/:documentId/edits/:editId/accept` | Accept tracked change | ✅ | Insertions and single-paragraph deletions work. Cross-paragraph deletions silently fail (see Known Limitations). |
| POST | `/:documentId/edits/:editId/reject` | Reject tracked change | ✅ | Same limitation as accept for cross-paragraph deletions. |

---

## Projects (`/projects`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/` | List user projects | ✅ | |
| POST | `/` | Create project | ✅ | |
| GET | `/:projectId` | Fetch project + members | ✅ | |
| GET | `/:projectId/people` | Fetch project members | ✅ | |
| PATCH | `/:projectId` | Update project metadata | ✅ | |
| DELETE | `/:projectId` | Delete project | ✅ | |
| GET | `/:projectId/documents` | List project documents | ✅ | |
| POST | `/:projectId/documents/prepare` + `/documents/:documentId/register` | Upload doc to project | ✅ | Same direct S3 flow as standalone upload |
| POST | `/:projectId/documents/:documentId` | Add existing doc to project | ✅ | |
| GET | `/:projectId/chats` | List project chats | ✅ | |
| POST | `/:projectId/folders` | Create folder | ✅ | |
| PATCH | `/:projectId/folders/:folderId` | Update folder | ✅ | |
| DELETE | `/:projectId/folders/:folderId` | Delete folder | ✅ | |
| PATCH | `/:projectId/documents/:documentId/folder` | Move doc to folder | ✅ | |

**Project chat (originally in `projectChat.ts`):**

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| POST | `/` (mounted at `/:projectId/chat`) | Stream project AI chat | ⚠️ | Same as `/chat POST /` — frontend now calls AgentCore directly. Route removed; project context passed via AgentCore invocation payload |

---

## Tabular Review (`/tabular-review`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/` | List tabular reviews | ✅ | |
| POST | `/` | Create tabular review | ✅ | |
| POST | `/prompt` | Generate column prompts via AI | ✅ | |
| GET | `/:reviewId` | Fetch review + cells | ✅ | |
| GET | `/:reviewId/people` | Fetch review members | ✅ | |
| PATCH | `/:reviewId` | Update review metadata | ✅ | |
| DELETE | `/:reviewId` | Delete review | ✅ | |
| POST | `/:reviewId/clear-cells` | Clear all cells | ✅ | |
| POST | `/:reviewId/regenerate-cell` | Regenerate single cell | ✅ | |
| POST | `/:reviewId/generate` | Generate all cells | ✅ | |
| GET | `/:reviewId/chats` | List review chats | ✅ | |
| DELETE | `/:reviewId/chats/:chatId` | Delete review chat | ✅ | |
| GET | `/:reviewId/chats/:chatId/messages` | Fetch chat messages | ✅ | |
| POST | `/:reviewId/chat` (original) / `/:reviewId/chats` (migrated) | Create chat + stream (original) | ⚠️ | Original: single endpoint proxied AI and persisted. Migration: `POST /chats` pre-creates row; frontend calls AgentCore directly; `POST /chats/:chatId/messages` persists after `[DONE]` |
| POST | `/:reviewId/chats/:chatId/messages` | Persist chat turn | ✅ | New in migration; handles post-stream persistence |

---

## Workflows (`/workflows`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/` | List workflows | ✅ | |
| POST | `/` | Create workflow | ✅ | |
| PUT / PATCH | `/:workflowId` | Update workflow | ✅ | Both verbs supported |
| DELETE | `/:workflowId` | Delete workflow | ✅ | |
| GET | `/hidden` | List hidden workflows | ✅ | |
| POST | `/hidden` | Hide a workflow | ✅ | |
| DELETE | `/hidden/:workflowId` | Unhide workflow | ✅ | |
| GET | `/:workflowId` | Fetch workflow | ✅ | |
| GET | `/:workflowId/shares` | List workflow shares | ✅ | |
| DELETE | `/:workflowId/shares/:shareId` | Remove share | ✅ | |
| POST | `/:workflowId/share` | Share workflow | ✅ | |

---

## User (`/user`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| POST | `/profile` | Create user profile (post-signup) | ✅ | Also handled by Cognito Post-Confirmation Lambda in AWS; backend endpoint kept for direct calls |
| DELETE | `/account` | Delete account | ✅ | |
| GET | `/profile` | Fetch profile | ✅ | New in migration |
| PUT | `/profile` | Update profile | ✅ | New in migration |

---

## Downloads (`/download`)

| Method | Path | Original | Migrated | Notes |
|--------|------|----------|----------|-------|
| GET | `/:token` | Download file via short-lived token | ⚠️ | Original: HMAC-signed download tokens verified server-side, file streamed through Lambda. Migration: replaced with presigned S3 URLs served via `GET /presigned` and `GET /` — no token system needed |
| GET | `/` | List download history | ✅ | New structure |
| GET | `/presigned` | Get presigned S3 URL | ✅ | Replaces token-based approach |

---

## Key Non-Route Features

| Feature | Original | Migrated | Notes |
|---------|----------|----------|-------|
| Authentication | Supabase Auth (JWT) | ✅ | AWS Cognito User Pool; Amplify Auth v6 on frontend |
| S3 direct upload | No — all uploads proxied through backend | ✅ | `/prepare` returns presigned S3 `PutObject` URL; frontend PUTs directly via XHR with no AWS credentials; Lambda generates URL but never buffers file bytes |
| Document storage | Supabase Storage | ✅ | AWS S3 with per-user IAM prefix enforcement |
| DOCX→PDF conversion | Inline LibreOffice in backend Lambda | ✅ | Offloaded to dedicated Conversion Lambda (x86_64) triggered by EventBridge S3 rule |
| PDF upload passthrough | No — only DOCX/DOC supported | ✅ | Added: Conversion Lambda detects `.pdf`, copies to `converted-pdfs/` prefix, updates DB |
| AI chat | Supabase AI edge function via backend proxy | ✅ | AWS AgentCore Runtime (Strands agent) with SSE streaming; frontend calls AgentCore directly |
| Credits metering | No | ✅ | DynamoDB `credits_used` per userId+month; `AfterModelCallEvent` tracks `totalTokens` |
| Session persistence | No | ✅ | Manual S3 read/write (`conversations/{chatId}/messages.json`); system prompt always fresh from code (SessionManager removed); session cleanup on chat delete |
| Database | Supabase Postgres | ✅ | Aurora Serverless v2 PostgreSQL via RDS Data API |
| Chat history reload | No — original had no tool activity cards | ✅ | Tool activity cards (doc_read, doc_edited, etc.) and reasoning blocks reconstructed from S3 snapshot on history load |
| Real-time / subscriptions | Supabase Realtime | 🚫 | Not used in original codebase (no realtime subscriptions found) |
| `documents.structure_tree` | Written on every upload (heading/section extraction) | 🚫 | Column kept in schema but no longer populated. Extraction wasted CPU on every upload; nothing in frontend, backend, or agents ever reads the column. Can be backfilled via batch job if a future feature needs it. See ARCHITECTURE.md → Database section |

---

## To Test

| Area | Test | Status |
|------|------|--------|
| Document upload | Upload a `.docx` file — verify conversion Lambda fires, PDF available | ✅ Verified |
| Document upload | Upload a `.pdf` file — verify passthrough to `converted-pdfs/`, available in UI | ✅ Verified |
| AI chat | Chat against uploaded documents — verify agent reads doc context | ✅ Verified |
| AI chat — tool spinner | While agent runs tools, spinner should show tool name (not infinite "Working…") | ✅ Verified |
| AI edit | Ask agent to make a tracked change edit to a Word doc — verify edit appears in UI | ✅ Verified |
| Document preview | Open a document — verify PDF renders in the preview panel | ✅ Verified |
| AI chat — generate docx | Ask agent to generate a new DOCX — verify download card appears | ✅ Verified |
| AI chat — history reload | Reopen a chat — verify tool activity cards + reasoning blocks restore | ⬜ Pending deploy |
| AI chat — multi-turn context | Send 2+ turns — verify agent remembers prior context | ⬜ Pending verify |
| Projects | Create project, add documents, navigate project page | ⬜ Not yet tested |
| Tabular Review | Create review, add documents/columns, generate cells | ⬜ Not yet tested |
| Workflows | Create workflow, run it | ⬜ Not yet tested |
| Project chat | Chat within a project — verify project context passed to agent | ⬜ Not yet tested |
| Workflow chat | Invoke workflow from chat — verify workflow runs correctly | ⬜ Not yet tested |

---

## Intentionally Skipped (POC Scope)

| Area | Notes |
|------|-------|
| Sync `organisation` to Cognito on profile update | `custom:organisation` Cognito attribute is set at signup only. When user updates org in Account Settings, only `user_profiles.organisation` is updated — Cognito attribute is not synced. DB is the app's source of truth; Cognito attribute is never read back. Not worth the extra Cognito API call for a POC. |
| Sidebar — user tier display | `main` shows `profile.tier` (e.g. "Free", "Pro") below the user's name. Dev hardcodes `"Free"`. Not worth the plumbing for a POC — tier display is cosmetic. |

---

## Pending / Open Items

| Area | Gap | Notes |
|------|-----|-------|
| Credit enforcement | `main` has pre-flight credit check — requests blocked with 429 when credits exhausted. Dev tracks credits (DynamoDB) but no enforcement gate. | See project TODO. |
| Schema cleanup TBD on implementation — `chat_messages` | `chat_messages` table and `document_edits.chat_message_id` column are dead in dev — messages live in S3 snapshots only. `chat_message_id` was never written to in either branch. | Remove from `000_one_shot_schema.sql`: `chat_messages` table + index, `document_edits.chat_message_id` column + `document_edits_message_id_idx` + FK constraint block. Also strip the `chat_messages` query from `GET /chat/:chatId` backend (returns metadata only). `hydrateEditStatuses` already moved to `/messages` endpoint. |
| Tracked change — cross-paragraph deletion | Agent cannot propose a deletion that spans two `<w:p>` elements. `applyTrackedEdits` searches per-paragraph; a `find` string containing `\n` across paragraphs never matches. Edit is silently skipped — DOCX unmodified, `del_w_id = null`, fake pending card shown. | Workaround: agent should delete within a single paragraph at a time. Full fix requires multi-paragraph span support in `applyTrackedEdits`. |
