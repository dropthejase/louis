/**
 * Louis API client — all requests to the AWS backend.
 * API Gateway calls use Cognito id token Bearer JWT (validated by native Cognito authorizer).
 * AgentCore calls use the same Bearer JWT (AgentCore JWT inbound authorizer).
 * File uploads go via multipart POST to API Gateway Lambda.
 */

import { getIdToken, getAccessToken } from "@/lib/aws/amplify-auth";
import { API_URL, AGENTCORE_URL, AGENTCORE_TABULAR_URL } from "@/lib/aws/config";
import { getCurrentUserId } from "@/lib/aws/amplify-auth";
import type {
    AssistantEvent,
    MikeChat,
    MikeChatDetailOut,
    MikeCitationAnnotation,
    MikeDocument,
    MikeFolder,
    MikeMessage,
    MikeProject,
    MikeWorkflow,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: MikeCitationAnnotation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: MikeChat;
    messages: ServerMessage[];
}

const API_BASE = API_URL;

async function getAuthHeader(): Promise<string> {
    const token = await getIdToken();
    return `Bearer ${token}`;
}

async function uploadViaPresignedUrl(
    url: string,
    file: File,
    onProgress?: (percent: number) => void,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
        if (onProgress) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
            };
        }
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`S3 upload failed: ${xhr.status}`)));
        xhr.onerror = () => reject(new Error("S3 upload network error"));
        xhr.send(file);
    });
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeader = await getAuthHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            Authorization: authHeader,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<MikeProject[]> {
    return apiRequest<MikeProject[]>("/projects");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
): Promise<MikeProject> {
    return apiRequest<MikeProject>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function getProject(projectId: string): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        shared_with?: string[];
    },
): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface MikeDocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    display_name: string | null;
}

export async function listDocumentVersions(
    documentId: string,
): Promise<{
    current_version_id: string | null;
    versions: MikeDocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    displayName?: string,
): Promise<MikeDocumentVersion> {
    const authHeader = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        { method: "POST", body: form, headers: { Authorization: authHeader } },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocumentVersion>;
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    displayName: string | null,
): Promise<MikeDocumentVersion> {
    return apiRequest<MikeDocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: displayName }),
        },
    );
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
    onProgress?: (percent: number) => void,
): Promise<MikeDocument> {
    const authHeader = await getAuthHeader();

    const prepareRes = await fetch(`${API_BASE}/projects/${projectId}/documents/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
    });
    if (!prepareRes.ok) throw new Error(await prepareRes.text());
    const { docId, uploadKey, uploadUrl } = await prepareRes.json() as { docId: string; uploadKey: string; uploadUrl: string };

    await uploadViaPresignedUrl(uploadUrl, file, onProgress);

    const registerRes = await fetch(`${API_BASE}/projects/${projectId}/documents/${docId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ upload_key: uploadKey }),
    });
    if (!registerRes.ok) throw new Error(await registerRes.text());
    return registerRes.json() as Promise<MikeDocument>;
}

export async function uploadStandaloneDocument(
    file: File,
    onProgress?: (percent: number) => void,
): Promise<MikeDocument> {
    const authHeader = await getAuthHeader();

    const prepareRes = await fetch(`${API_BASE}/single-documents/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ filename: file.name, size_bytes: file.size }),
    });
    if (!prepareRes.ok) throw new Error(await prepareRes.text());
    const { docId, uploadKey, uploadUrl } = await prepareRes.json() as { docId: string; uploadKey: string; uploadUrl: string };

    await uploadViaPresignedUrl(uploadUrl, file, onProgress);

    const registerRes = await fetch(`${API_BASE}/single-documents/${docId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ upload_key: uploadKey }),
    });
    if (!registerRes.ok) throw new Error(await registerRes.text());
    return registerRes.json() as Promise<MikeDocument>;
}

export async function listStandaloneDocuments(): Promise<MikeDocument[]> {
    return apiRequest<MikeDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    const authHeader = await getAuthHeader();
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>("/chat");
}

export async function listProjectChats(projectId: string): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<MikeChatDetailOut> {
    const [chatRes, messagesRes] = await Promise.all([
        apiRequest<{ chat: MikeChat }>(`/chat/${chatId}`),
        apiRequest<{ messages: MikeMessage[] }>(`/chat/${chatId}/messages`),
    ]);
    return { chat: chatRes.chat, messages: messagesRes.messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

export async function streamChat(payload: {
    prompt: string;
    chatId?: string;
    projectId?: string;
    model?: string;
    runtimeSessionId?: string;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...rest } = payload;
    const [token, userId] = await Promise.all([getAccessToken(), getCurrentUserId()]);
    return fetch(AGENTCORE_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": userId,
        },
        body: JSON.stringify({ ...rest, userId }),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId
        ? `?project_id=${encodeURIComponent(projectId)}`
        : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<MikeDocument> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeader = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { Authorization: authHeader },
    });
}

export async function createTabularChat(reviewId: string): Promise<{ chatId: string }> {
    return apiRequest<{ chatId: string }>(`/tabular-review/${reviewId}/chats`, {
        method: "POST",
    });
}

export async function streamTabularChat(
    reviewId: string,
    chatId: string,
    prompt: string,
    model?: string,
    signal?: AbortSignal,
): Promise<Response> {
    const [token, userId] = await Promise.all([getAccessToken(), getCurrentUserId()]);
    return fetch(AGENTCORE_TABULAR_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": userId,
        },
        body: JSON.stringify({ reviewId, chatId, prompt, model }),
        signal: signal ?? undefined,
    });
}

export async function persistTabularChatMessages(
    reviewId: string,
    chatId: string,
    payload: {
        user_message: string;
        is_first_exchange?: boolean;
        review_title?: string | null;
        project_name?: string | null;
    },
): Promise<{ title: string | null }> {
    return apiRequest<{ title: string | null }>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<TRDisplayMessage[]> {
    return apiRequest<TRDisplayMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = MikeWorkflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<MikeWorkflow[]> {
    return apiRequest<MikeWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
}): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        practice?: string | null;
    },
): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(
    workflowId: string,
): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}
