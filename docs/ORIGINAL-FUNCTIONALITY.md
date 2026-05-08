# Original Functionality (main branch)

Reference for ensuring feature parity in the AWS migration.

---

## Auth

| Feature | Original | AWS branch | Status |
|---|---|---|---|
| Login / signup | Supabase Auth | Cognito User Pool (Amplify Auth v6) | ✅ Done |
| TOTP MFA | Not present | Cognito TOTP | ✅ Done |
| Password policy | Supabase default | min 8, upper+lower+digit+symbol | ✅ Done |
| Create user profile on signup | Supabase trigger `on_auth_user_created` | Post Confirmation Lambda | ✅ Done |
| Delete user account | `DELETE /user/account` → `supabase.auth.admin.deleteUser` | Needs Cognito `AdminDeleteUser` | ❌ Not done |
| Cleanup on user delete | Supabase cascade from `auth.users` | Post Deletion Lambda (EventBridge + CloudTrail) | ✅ Done |
| Create profile if missing | `POST /user/profile` (upsert) | Route still exists, Lambda is primary | ✅ Done |

---

## Models

Original supported two providers. User stored personal API keys in `user_profiles`.

| Original model | Provider | Tier | AWS branch |
|---|---|---|---|
| `gemini-3-flash-preview` | Gemini | Main + tabular default | ❌ Dropped |
| `gemini-3.1-pro-preview` | Gemini | Main | ❌ Dropped |
| `gemini-3.1-flash-lite-preview` | Gemini | Title generation | ❌ Dropped |
| `claude-opus-4-7` | Claude | Main | ✅ Bedrock |
| `claude-sonnet-4-6` | Claude | Main + tabular | ✅ Bedrock |
| `claude-haiku-4-5` | Claude | Title generation | ✅ Bedrock |

**Title model logic (original):** cheapest available — Gemini Flash Lite if Gemini key set, else Claude Haiku.
**AWS branch:** all models via Bedrock, no user API keys, title model should always be Claude Haiku.

**Tabular model:** user-selectable in account settings, stored in `user_profiles.tabular_model`.
Currently still references Gemini models — needs updating to Bedrock-only model list. ❌ Not done.

**`userSettings.ts`:** reads `claude_api_key`, `gemini_api_key`, `tabular_model` from DB and passes to chat/tabular routes. Dead code now columns are dropped. ✅ Cleaned up — returns Bedrock defaults, no DB reads.

---

## Credits / Usage Metering

| Feature | Original | AWS branch |
|---|---|---|
| `message_credits_used` counter | Client-side increment per message | ❌ Dropped from schema |
| `credits_reset_date` rolling 30-day window | Client-side reset check | ❌ Dropped from schema |
| `tier` (Free/paid) | Stored in `user_profiles` | ❌ Dropped from schema |
| Hard gate enforcement | None (limit was 999999, effectively unlimited) | N/A |
| Cost visibility | None | Bedrock Model Invocation Logging + `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` header |

---

## API Routes

### Chat (`/chat`)

| Route | Description | Status |
|---|---|---|
| `GET /` | List user's chats + chats in owned projects | ✅ |
| `POST /create` | Create chat | ✅ |
| `GET /:chatId` | Get chat detail with messages, edits, annotations | ✅ |
| `PATCH /:chatId` | Rename chat | ✅ |
| `DELETE /:chatId` | Delete chat | ✅ |
| `POST /:chatId/generate-title` | Generate title via LLM | ✅ |
| `GET /:chatId/messages` | Load messages from AgentCore S3 snapshot | ✅ |
| `GET /:chatId/session-id` | Get AgentCore session ID for turn continuity | ✅ Added |
| `POST /` | Main chat endpoint — ran full LLM + tool loop inline | Moved to AgentCore |

### Documents (`/single-documents`)

| Route | Description | Status |
|---|---|---|
| `POST /:projectId/documents` | Upload document | ✅ |
| `GET /:documentId` | Get document detail | ✅ |
| `GET /:documentId/display` | Serve PDF or DOCX bytes | ✅ |
| `GET /:documentId/docx` | Serve raw DOCX bytes | ✅ |
| `GET /:documentId/versions` | List tracked-change versions | ✅ |
| `POST /:documentId/accept` | Accept tracked changes | ✅ |
| `POST /:documentId/reject` | Reject tracked changes | ✅ |

### Projects (`/projects`)

| Route | Description | Status |
|---|---|---|
| `GET /` | List projects | ✅ |
| `POST /` | Create project | ✅ |
| `GET /:projectId` | Get project detail | ✅ |
| `PATCH /:projectId` | Update project | ✅ |
| `DELETE /:projectId` | Delete project | ✅ |
| Sharing (`shared_with` jsonb) | Share project with user by email | ✅ |
| Subfolders | Create/delete/rename subfolders | ✅ |
| Per-project chats | `GET /projects/:projectId/chats` etc | ✅ |
| Per-project documents | `GET /projects/:projectId/documents` etc | ✅ |

### Tabular Review (`/tabular-review`)

| Route | Description | Status |
|---|---|---|
| CRUD reviews | Create, list, get, delete | ✅ |
| Run AI analysis | Per-cell LLM analysis using `tabular_model` | ✅ Fixed — uses Bedrock `DEFAULT_TABULAR_MODEL` |
| Per-review chats | Chat within a review | ✅ |
| Workflows | Apply workflow to review | ✅ |

### Workflows (`/workflows`)

| Route | Description | Status |
|---|---|---|
| `GET /` | List system + user + shared workflows | ✅ |
| `POST /` | Create workflow | ✅ |
| `PATCH /:id` | Update workflow | ✅ |
| `DELETE /:id` | Delete workflow | ✅ |
| Share workflow | Share with user by email | ✅ |

### User (`/user`)

| Route | Description | Status |
|---|---|---|
| `POST /user/profile` | Upsert user profile (fallback if Lambda fails) | ✅ |
| `DELETE /user/account` | Delete account | ❌ Needs Cognito AdminDeleteUser |

### Downloads (`/download`)

| Route | Description | Status |
|---|---|---|
| Token-based download URLs | Time-limited, no auth header needed | ✅ |

---

## Outstanding gaps

1. `DELETE /user/account` — must call Cognito `AdminDeleteUser` instead of `supabase.auth.admin.deleteUser`
2. `userSettings.ts` — remove dead `claude_api_key`/`gemini_api_key` reads; simplify to Bedrock-only model resolution
3. Tabular model selector — ✅ Removed from UI; model held as local state in TRChatPanel, backend uses `DEFAULT_TABULAR_MODEL`
4. `UserProfileContext.tsx` — ✅ Stripped to `displayName` + `organisation` only; all dead fields removed
5. Task #7 — rename `MikeMessage`, `MikeCitationAnnotation`, `MikeIcon`, `mikeApi.ts`, drag MIME types
