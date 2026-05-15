/**
 * Tabular review routes — AI-powered column-based document analysis.
 *
 * A tabular review applies a configurable set of column prompts to one or more
 * documents, storing each cell result in the `tabular_cells` table. Chat is
 * handled by the AgentCore louisTabular agent; this router provides the
 * chat record lifecycle endpoints (create / persist).
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { query, queryOne, execute } from "../lib/db";
import type { SqlParameter } from "@aws-sdk/client-rds-data";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { normalizeDocxZipPaths } from "../lib/convert";
import { completeText, streamChatWithTools } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    listAccessibleProjectIds,
} from "../lib/access";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
    getSessionS3,
    conversationKey,
    readSessionMessages,
    snapshotMessagesToSessionMessages,
} from "../lib/sessions";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

interface ReviewRow {
    id: string;
    project_id: string | null;
    user_id: string;
    title: string | null;
    columns_config: ColumnConfig[] | null;
    workflow_id: string | null;
    practice: string | null;
    shared_with: string[] | null;
    created_at: string;
    updated_at: string;
}

interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
}

interface CellRow {
    id: string;
    review_id: string;
    document_id: string;
    column_index: number;
    content: string | null;
    citations: unknown;
    status: string;
    created_at: string;
}

interface DocumentLite {
    id: string;
    filename: string;
    file_type: string | null;
    page_count?: number | null;
}

export const tabularRouter = Router();

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;

    // Optional ?project_id= scopes results to a single project. Project-page
    // callers pass it; the global tabular-reviews page omits it. We still
    // enforce access via listAccessibleProjectIds so a stranger can't request
    // an arbitrary project_id.
    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    // Visible reviews = user's own + reviews in any accessible project.
    const projectIds = await listAccessibleProjectIds(userId, userEmail);

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
        // No access to that project — also covers "project doesn't exist".
        return void res.json([]);
    }

    const ownParams: SqlParameter[] = [
        { name: "userId", value: { stringValue: userId } },
    ];
    let ownSql = `SELECT * FROM tabular_reviews WHERE user_id = :userId`;
    if (projectIdFilter) {
        ownSql += ` AND project_id = :projectId`;
        ownParams.push({
            name: "projectId",
            value: { stringValue: projectIdFilter },
        });
    }
    ownSql += ` ORDER BY created_at DESC`;

    const sharedProjectIds = projectIdFilter ? [projectIdFilter] : projectIds;

    // Three sources to merge:
    //  - own:           reviews this user created
    //  - sharedProj:    reviews in a project the user has access to
    //  - sharedDirect:  standalone reviews (project_id null) where the
    //                   user's email is in tabular_reviews.shared_with
    const ownPromise = query<ReviewRow>(ownSql, ownParams);

    const sharedPromise: Promise<ReviewRow[]> =
        sharedProjectIds.length > 0
            ? (async () => {
                  const placeholders = sharedProjectIds
                      .map((_, i) => `:pid${i}::uuid`)
                      .join(", ");
                  return query<ReviewRow>(
                      `SELECT * FROM tabular_reviews
                       WHERE project_id IN (${placeholders})
                         AND user_id != :userId
                       ORDER BY created_at DESC`,
                      [
                          ...sharedProjectIds.map((id, i) => ({
                              name: `pid${i}`,
                              value: { stringValue: id },
                          })),
                          { name: "userId", value: { stringValue: userId } },
                      ],
                  );
              })()
            : Promise.resolve([] as ReviewRow[]);

    // Skip the direct-share lookup when the caller is filtering to a
    // specific project — direct shares are inherently project-id-null.
    const sharedDirectPromise: Promise<ReviewRow[]> =
        userEmail && !projectIdFilter
            ? query<ReviewRow>(
                  `SELECT * FROM tabular_reviews
                   WHERE shared_with @> :email::jsonb
                     AND user_id != :userId
                   ORDER BY created_at DESC`,
                  [
                      {
                          name: "email",
                          value: {
                              stringValue: JSON.stringify([userEmail]),
                          },
                      },
                      { name: "userId", value: { stringValue: userId } },
                  ],
              ).catch((err) => {
                  console.warn(
                      "[tabular] shared-by-email query failed:",
                      err?.message ?? err,
                  );
                  return [] as ReviewRow[];
              })
            : Promise.resolve([] as ReviewRow[]);

    let own: ReviewRow[];
    let shared: ReviewRow[];
    let sharedDirect: ReviewRow[];
    try {
        [own, shared, sharedDirect] = await Promise.all([
            ownPromise,
            sharedPromise.catch((err) => {
                console.warn(
                    "[tabular] shared-by-project query failed:",
                    err?.message ?? err,
                );
                return [] as ReviewRow[];
            }),
            sharedDirectPromise,
        ]);
    } catch (err) {
        const message = (err as { message?: string })?.message ?? String(err);
        return void res.status(500).json({ detail: message });
    }

    const seen = new Set<string>();
    const reviews: ReviewRow[] = [];
    for (const r of [...own, ...shared, ...sharedDirect]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        reviews.push(r);
    }

    // Fetch distinct document counts per review
    const reviewIds = reviews.map((r) => r.id);
    const docCounts: Record<string, number> = {};
    if (reviewIds.length > 0) {
        const placeholders = reviewIds.map((_, i) => `:rid${i}::uuid`).join(", ");
        const cells = await query<{
            review_id: string;
            document_id: string;
        }>(
            `SELECT review_id, document_id FROM tabular_cells
             WHERE review_id IN (${placeholders})`,
            reviewIds.map((id, i) => ({
                name: `rid${i}`,
                value: { stringValue: id },
            })),
        );
        const seenPair = new Set<string>();
        for (const cell of cells) {
            const key = `${cell.review_id}:${cell.document_id}`;
            if (!seenPair.has(key)) {
                seenPair.add(key);
                docCounts[cell.review_id] =
                    (docCounts[cell.review_id] ?? 0) + 1;
            }
        }
    }

    res.json(
        reviews.map((r) => ({
            ...r,
            columns_config: typeof r.columns_config === "string"
                ? JSON.parse(r.columns_config)
                : (r.columns_config ?? []),
            shared_with: typeof r.shared_with === "string"
                ? JSON.parse(r.shared_with)
                : (r.shared_with ?? []),
            document_count: docCounts[r.id] ?? 0,
        })),
    );
  } catch (err) {
    console.error("[tabular] GET / error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { title, document_ids, columns_config, workflow_id, project_id } =
        req.body as {
            title?: string;
            document_ids: string[];
            columns_config: ColumnConfig[];
            workflow_id?: string;
            project_id?: string;
        };

    if (project_id) {
        const access = await checkProjectAccess(project_id, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }

    const review = await queryOne<ReviewRow>(
        `INSERT INTO tabular_reviews
           (user_id, title, columns_config, project_id, workflow_id)
         VALUES
           (:userId, :title, :columnsConfig::jsonb, :projectId, :workflowId)
         RETURNING *`,
        [
            { name: "userId", value: { stringValue: userId } },
            {
                name: "title",
                value: title != null ? { stringValue: title } : { isNull: true },
            },
            {
                name: "columnsConfig",
                value: { stringValue: JSON.stringify(columns_config) },
            },
            {
                name: "projectId",
                value: project_id != null
                    ? { stringValue: project_id }
                    : { isNull: true },
            },
            {
                name: "workflowId",
                value: workflow_id != null
                    ? { stringValue: workflow_id }
                    : { isNull: true },
            },
        ],
    );
    if (!review)
        return void res
            .status(500)
            .json({ detail: "Failed to create review" });

    for (const docId of document_ids) {
        for (const col of columns_config) {
            await execute(
                `INSERT INTO tabular_cells
                   (review_id, document_id, column_index, status)
                 VALUES (:reviewId, :documentId, :columnIndex, :status)
                 ON CONFLICT (review_id, document_id, column_index) DO UPDATE
                   SET status = EXCLUDED.status`,
                [
                    { name: "reviewId", value: { stringValue: review.id } },
                    { name: "documentId", value: { stringValue: docId } },
                    { name: "columnIndex", value: { longValue: col.index } },
                    { name: "status", value: { stringValue: "pending" } },
                ],
            );
        }
    }

    res.status(201).json(review);
    } catch (err) {
        console.error("[tabular] POST / error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
  try {
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model } = await getUserModelSettings();
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
  } catch (err) {
    console.error("[tabular] POST /prompt error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await queryOne<ReviewRow>(
        `SELECT * FROM tabular_reviews WHERE id = :id`,
        [{ name: "id", value: { stringValue: reviewId } }],
    );
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const cells = await query<CellRow>(
        `SELECT * FROM tabular_cells WHERE review_id = :reviewId`,
        [{ name: "reviewId", value: { stringValue: reviewId } }],
    );
    const docIds = [...new Set(cells.map((c) => c.document_id))];
    let documents: Record<string, unknown>[] = [];
    if (docIds.length > 0) {
        const placeholders = docIds.map((_, i) => `:did${i}::uuid`).join(", ");
        documents = await query(
            `SELECT * FROM documents WHERE id IN (${placeholders})`,
            docIds.map((id, i) => ({
                name: `did${i}`,
                value: { stringValue: id },
            })),
        );
    } else if (review.project_id) {
        documents = await query(
            `SELECT * FROM documents WHERE project_id = :projectId
             ORDER BY created_at ASC`,
            [{ name: "projectId", value: { stringValue: review.project_id } }],
        );
    }

    res.json({
        review: {
            ...review,
            is_owner: access.isOwner,
            columns_config: typeof review.columns_config === "string"
                ? JSON.parse(review.columns_config)
                : (review.columns_config ?? []),
            shared_with: typeof review.shared_with === "string"
                ? JSON.parse(review.shared_with)
                : (review.shared_with ?? []),
        },
        cells: cells.map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        documents,
    });
    } catch (err) {
        console.error("[tabular] GET /:reviewId error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
//
// With Cognito as the IdP, we don't cheaply enumerate auth users; owner
// info comes from user_profiles, and shared members are addressed by email
// only with display_name: null.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;

        const review = await queryOne<{
            id: string;
            user_id: string;
            project_id: string | null;
            shared_with: string[] | null;
        }>(
            `SELECT id, user_id, project_id, shared_with
             FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const sharedWith: string[] = (
            Array.isArray(review.shared_with) ? review.shared_with : []
        ).map((e) => (e ?? "").toLowerCase());

        const ownerProfile = await queryOne<{ display_name: string | null }>(
            `SELECT display_name FROM user_profiles WHERE user_id = :userId`,
            [{ name: "userId", value: { stringValue: review.user_id } }],
        );

        const isOwner = review.user_id === userId;
        res.json({
            owner: {
                user_id: review.user_id,
                email: isOwner ? (userEmail ?? null) : null,
                display_name: ownerProfile?.display_name ?? null,
            },
            members: sharedWith.map((email) => ({
                email,
                display_name: null as string | null,
            })),
        });
    } catch (err) {
        console.error("[tabular] GET /:reviewId/people error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }

    const existingReview = await queryOne<ReviewRow>(
        `SELECT * FROM tabular_reviews WHERE id = :id`,
        [{ name: "id", value: { stringValue: reviewId } }],
    );
    if (!existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(existingReview, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (sharedWithUpdate !== undefined && !access.isOwner) {
        return void res
            .status(403)
            .json({ detail: "Only the review owner can change sharing" });
    }

    const sets: string[] = [`updated_at = NOW()`];
    const params: SqlParameter[] = [
        { name: "id", value: { stringValue: reviewId } },
    ];
    if (req.body.title != null) {
        sets.push(`title = :title`);
        params.push({
            name: "title",
            value: { stringValue: String(req.body.title) },
        });
    }
    if (req.body.columns_config != null) {
        sets.push(`columns_config = :columnsConfig::jsonb`);
        params.push({
            name: "columnsConfig",
            value: { stringValue: JSON.stringify(req.body.columns_config) },
        });
    }
    if (req.body.project_id !== undefined) {
        sets.push(`project_id = :projectId`);
        params.push({
            name: "projectId",
            value:
                req.body.project_id != null
                    ? { stringValue: String(req.body.project_id) }
                    : { isNull: true },
        });
    }
    if (sharedWithUpdate !== undefined) {
        sets.push(`shared_with = :sharedWith::jsonb`);
        params.push({
            name: "sharedWith",
            value: { stringValue: JSON.stringify(sharedWithUpdate) },
        });
    }

    const updatedReview = await queryOne<ReviewRow>(
        `UPDATE tabular_reviews SET ${sets.join(", ")}
         WHERE id = :id
         RETURNING *`,
        params,
    );
    if (!updatedReview)
        return void res
            .status(500)
            .json({ detail: "Failed to update review" });

    if (
        Array.isArray(req.body.columns_config) ||
        Array.isArray(req.body.document_ids)
    ) {
        const existingCells = await query<{
            document_id: string;
            column_index: number;
        }>(
            `SELECT document_id, column_index FROM tabular_cells
             WHERE review_id = :reviewId`,
            [{ name: "reviewId", value: { stringValue: reviewId } }],
        );
        const existingKeys = new Set(
            existingCells.map(
                (cell) => `${cell.document_id}:${cell.column_index}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(req.body.document_ids)) {
            // document_ids is the new source of truth — delete removed docs' cells
            const newDocIds = req.body.document_ids as string[];
            const existingDocIds = existingCells.map((cell) => cell.document_id);
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                const placeholders = removedDocIds
                    .map((_, i) => `:rid${i}::uuid`)
                    .join(", ");
                await execute(
                    `DELETE FROM tabular_cells
                     WHERE review_id = :reviewId
                       AND document_id IN (${placeholders})`,
                    [
                        { name: "reviewId", value: { stringValue: reviewId } },
                        ...removedDocIds.map((id, i) => ({
                            name: `rid${i}`,
                            value: { stringValue: id },
                        })),
                    ],
                );
            }

            documentIds = newDocIds;
        } else {
            // No document change — derive from existing cells
            documentIds = [
                ...new Set(existingCells.map((cell) => cell.document_id)),
            ];
            if (documentIds.length === 0 && existingReview.project_id) {
                const projectDocs = await query<{ id: string }>(
                    `SELECT id FROM documents WHERE project_id = :projectId`,
                    [
                        {
                            name: "projectId",
                            value: { stringValue: existingReview.project_id },
                        },
                    ],
                );
                documentIds = projectDocs.map((d) => d.id);
            }
        }

        const activeColumns: ColumnConfig[] = Array.isArray(
            req.body.columns_config,
        )
            ? (req.body.columns_config as ColumnConfig[])
            : (updatedReview.columns_config ?? []);

        for (const documentId of documentIds) {
            for (const column of activeColumns) {
                await execute(
                    `INSERT INTO tabular_cells
                       (review_id, document_id, column_index, status)
                     VALUES
                       (:reviewId, :documentId, :columnIndex, :status)
                     ON CONFLICT (review_id, document_id, column_index) DO NOTHING`,
                    [
                        { name: "reviewId", value: { stringValue: reviewId } },
                        { name: "documentId", value: { stringValue: documentId } },
                        {
                            name: "columnIndex",
                            value: { longValue: column.index },
                        },
                        { name: "status", value: { stringValue: "pending" } },
                    ],
                );
            }
        }
    }

    res.json({
        ...updatedReview,
        columns_config: typeof updatedReview.columns_config === "string"
            ? JSON.parse(updatedReview.columns_config)
            : (updatedReview.columns_config ?? []),
        shared_with: typeof updatedReview.shared_with === "string"
            ? JSON.parse(updatedReview.shared_with)
            : (updatedReview.shared_with ?? []),
    });
    } catch (err) {
        console.error("[tabular] PATCH /:reviewId error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const { reviewId } = req.params;
        await execute(
            `DELETE FROM tabular_reviews WHERE id = :id AND user_id = :userId`,
            [
                { name: "id", value: { stringValue: reviewId } },
                { name: "userId", value: { stringValue: userId } },
            ],
        );
        res.status(204).send();
    } catch (err) {
        console.error("[tabular] DELETE /:reviewId error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given document_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_ids } = req.body as { document_ids?: string[] };

        if (!Array.isArray(document_ids) || document_ids.length === 0)
            return void res
                .status(400)
                .json({ detail: "document_ids is required" });

        const review = await queryOne<{
            id: string;
            user_id: string;
            project_id: string | null;
            shared_with?: string[] | null;
        }>(
            `SELECT id, user_id, project_id FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const placeholders = document_ids.map((_, i) => `:did${i}::uuid`).join(", ");
        await execute(
            `UPDATE tabular_cells SET content = NULL, status = 'pending'
             WHERE review_id = :reviewId
               AND document_id IN (${placeholders})`,
            [
                { name: "reviewId", value: { stringValue: reviewId } },
                ...document_ids.map((id, i) => ({
                    name: `did${i}`,
                    value: { stringValue: id },
                })),
            ],
        );
        res.status(204).send();
    } catch (err) {
        console.error("[tabular] POST /:reviewId/clear-cells error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index } = req.body as {
            document_id: string;
            column_index: number;
        };

        if (!document_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "document_id and column_index are required" });

        const review = await queryOne<ReviewRow>(
            `SELECT * FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (review.columns_config ?? []).find(
            (c) => c.index === column_index,
        );
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const doc = await queryOne<{
            id: string;
            filename: string;
            file_type: string | null;
        }>(
            `SELECT id, filename, file_type FROM documents WHERE id = :id`,
            [{ name: "id", value: { stringValue: document_id } }],
        );
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id);

        await execute(
            `UPDATE tabular_cells SET status = 'generating', content = NULL
             WHERE review_id = :reviewId
               AND document_id = :documentId
               AND column_index = :columnIndex`,
            [
                { name: "reviewId", value: { stringValue: reviewId } },
                { name: "documentId", value: { stringValue: document_id } },
                { name: "columnIndex", value: { longValue: column_index } },
            ],
        );

        let markdown = "";
        if (docActive) {
            const buf = await downloadFile(docActive.storage_path);
            if (buf) {
                try {
                    markdown =
                        doc.file_type === "pdf"
                            ? await extractPdfMarkdown(buf)
                            : await extractDocxMarkdown(buf);
                } catch (err) {
                    console.error(
                        `[regenerate-cell] extraction error doc=${document_id}`,
                        err,
                    );
                }
            }
        }

        const { tabular_model } = await getUserModelSettings(userId);
        const result = await queryBedrock(
            tabular_model,
            doc.filename,
            markdown,
            column.prompt,
            column.format,
            column.tags,
        );

        if (!result) {
            await execute(
                `UPDATE tabular_cells SET status = 'error'
                 WHERE review_id = :reviewId
                   AND document_id = :documentId
                   AND column_index = :columnIndex`,
                [
                    { name: "reviewId", value: { stringValue: reviewId } },
                    { name: "documentId", value: { stringValue: document_id } },
                    { name: "columnIndex", value: { longValue: column_index } },
                ],
            );
            return void res.status(500).json({ detail: "Generation failed" });
        }

        await execute(
            `UPDATE tabular_cells SET content = :content, status = 'done'
             WHERE review_id = :reviewId
               AND document_id = :documentId
               AND column_index = :columnIndex`,
            [
                { name: "content", value: { stringValue: JSON.stringify(result) } },
                { name: "reviewId", value: { stringValue: reviewId } },
                { name: "documentId", value: { stringValue: document_id } },
                { name: "columnIndex", value: { longValue: column_index } },
            ],
        );

        res.json(result);
        } catch (err) {
            console.error("[tabular] POST /:reviewId/regenerate-cell error:", err);
            res.status(500).json({ detail: "Internal server error" });
        }
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;

    const review = await queryOne<ReviewRow>(
        `SELECT * FROM tabular_reviews WHERE id = :id`,
        [{ name: "id", value: { stringValue: reviewId } }],
    );
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: ColumnConfig[] = typeof review.columns_config === "string"
        ? JSON.parse(review.columns_config)
        : (review.columns_config ?? []);
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    const cells = await query<CellRow>(
        `SELECT * FROM tabular_cells WHERE review_id = :reviewId`,
        [{ name: "reviewId", value: { stringValue: reviewId } }],
    );
    const cellMap = new Map<string, CellRow>();
    for (const cell of cells)
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);

    const docIds = [...new Set(cells.map((c) => c.document_id))];
    let docs: DocumentLite[] = [];
    if (docIds.length > 0) {
        const placeholders = docIds.map((_, i) => `:did${i}::uuid`).join(", ");
        docs = await query<DocumentLite>(
            `SELECT id, filename, file_type, page_count FROM documents
             WHERE id IN (${placeholders})`,
            docIds.map((id, i) => ({
                name: `did${i}`,
                value: { stringValue: id },
            })),
        );
    } else if (review.project_id) {
        docs = await query<DocumentLite>(
            `SELECT id, filename, file_type, page_count FROM documents
             WHERE project_id = :projectId
             ORDER BY created_at ASC`,
            [{ name: "projectId", value: { stringValue: review.project_id } }],
        );
    }

    const { tabular_model } = await getUserModelSettings(userId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    try {
        await Promise.all(
            docs.map(async (doc) => {
                const docId = doc.id;
                const filename = doc.filename;
                let markdown = "";

                const active = await loadActiveVersion(docId);
                if (active) {
                    const buf = await downloadFile(active.storage_path);
                    if (buf) {
                        try {
                            markdown =
                                doc.file_type === "pdf"
                                    ? await extractPdfMarkdown(buf)
                                    : await extractDocxMarkdown(buf);
                        } catch (err) {
                            console.error(
                                `[tabular/generate] extraction error doc=${docId}`,
                                err,
                            );
                        }
                    }
                }

                // Filter to only columns that need processing
                const columnsToProcess = columns.filter((col) => {
                    const cell = cellMap.get(`${docId}:${col.index}`);
                    return !(cell?.status === "done" && cell?.content);
                });
                if (columnsToProcess.length === 0) return;

                // Mark all as generating upfront
                for (const col of columnsToProcess) {
                    write(
                        `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "generating" })}\n\n`,
                    );
                    await execute(
                        `INSERT INTO tabular_cells
                           (review_id, document_id, column_index, status, content)
                         VALUES
                           (:reviewId, :documentId, :columnIndex, 'generating', NULL)
                         ON CONFLICT (review_id, document_id, column_index) DO UPDATE
                           SET status = 'generating', content = NULL`,
                        [
                            { name: "reviewId", value: { stringValue: reviewId } },
                            { name: "documentId", value: { stringValue: docId } },
                            { name: "columnIndex", value: { longValue: col.index } },
                        ],
                    );
                }

                // Single LLM call for all columns, streaming one JSON line per column
                const receivedColumns = new Set<number>();
                try {
                    await queryBedrockAllColumns(
                        tabular_model,
                        filename,
                        markdown,
                        columnsToProcess,
                        async (columnIndex, result) => {
                            receivedColumns.add(columnIndex);
                            await execute(
                                `UPDATE tabular_cells
                                 SET content = :content, status = 'done'
                                 WHERE review_id = :reviewId
                                   AND document_id = :documentId
                                   AND column_index = :columnIndex`,
                                [
                                    {
                                        name: "content",
                                        value: { stringValue: JSON.stringify(result) },
                                    },
                                    { name: "reviewId", value: { stringValue: reviewId } },
                                    { name: "documentId", value: { stringValue: docId } },
                                    { name: "columnIndex", value: { longValue: columnIndex } },
                                ],
                            );
                            write(
                                `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: columnIndex, content: result, status: "done" })}\n\n`,
                            );
                        },
                    );
                } catch (err) {
                    console.error(
                        `[tabular/generate] queryBedrockAllColumns error doc=${docId}`,
                        err,
                    );
                }

                // Mark any columns the LLM didn't return as error
                for (const col of columnsToProcess) {
                    if (!receivedColumns.has(col.index)) {
                        await execute(
                            `UPDATE tabular_cells SET status = 'error'
                             WHERE review_id = :reviewId
                               AND document_id = :documentId
                               AND column_index = :columnIndex`,
                            [
                                { name: "reviewId", value: { stringValue: reviewId } },
                                { name: "documentId", value: { stringValue: docId } },
                                { name: "columnIndex", value: { longValue: col.index } },
                            ],
                        );
                        write(
                            `data: ${JSON.stringify({ type: "cell_update", document_id: docId, column_index: col.index, content: null, status: "error" })}\n\n`,
                        );
                    }
                }
            }),
        );

        write("data: [DONE]\n\n");
    } catch (err) {
        console.error("[tabular/generate] stream error", err);
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\ndata: [DONE]\n\n`,
            );
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
  } catch (err) {
    console.error("[tabular] POST /:reviewId/generate error:", err);
    if (!res.headersSent) res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;

        // Verify access (owner or shared-project member).
        const review = await queryOne<{
            id: string;
            user_id: string;
            project_id: string | null;
        }>(
            `SELECT id, user_id, project_id FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        // Show every member's chats for the review (collaborative), not just
        // the requester's. Per-chat access is gated above by review access.
        const chats = await query(
            `SELECT id, title, created_at, updated_at, user_id
             FROM tabular_review_chats
             WHERE review_id = :reviewId
             ORDER BY updated_at DESC`,
            [{ name: "reviewId", value: { stringValue: reviewId } }],
        );

        res.json(chats);
    } catch (err) {
        console.error("[tabular] GET /:reviewId/chats error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        try {
            const userId = res.locals.userId as string;
            const { chatId } = req.params;
            // Owner-only delete — sibling collaborators shouldn't be able to wipe
            // each other's threads.
            await execute(
                `DELETE FROM tabular_review_chats
                 WHERE id = :id AND user_id = :userId`,
                [
                    { name: "id", value: { stringValue: chatId } },
                    { name: "userId", value: { stringValue: userId } },
                ],
            );
            // Best-effort S3 cleanup — don't fail the delete if S3 errors.
            const bucket = process.env.SESSIONS_BUCKET_NAME;
            if (bucket) {
                try {
                    await getSessionS3().send(new DeleteObjectCommand({
                        Bucket: bucket,
                        Key: conversationKey(chatId),
                    }));
                } catch (s3Err) {
                    console.error("[tabular] DELETE /:reviewId/chats/:chatId S3 cleanup failed:", s3Err);
                }
            }
            res.status(204).send();
        } catch (err) {
            console.error("[tabular] DELETE /:reviewId/chats/:chatId error:", err);
            res.status(500).json({ detail: "Internal server error" });
        }
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        try {
            const userId = res.locals.userId as string;
            const userEmail = res.locals.userEmail as string | undefined;
            const { reviewId, chatId } = req.params;

            const review = await queryOne<{
                id: string;
                user_id: string;
                project_id: string | null;
            }>(
                `SELECT id, user_id, project_id FROM tabular_reviews WHERE id = :id`,
                [{ name: "id", value: { stringValue: reviewId } }],
            );
            if (!review)
                return void res.status(404).json({ detail: "Review not found" });
            const access = await ensureReviewAccess(review, userId, userEmail);
            if (!access.ok)
                return void res.status(404).json({ detail: "Review not found" });

            const chat = await queryOne<{ id: string; review_id: string }>(
                `SELECT id, review_id FROM tabular_review_chats WHERE id = :id`,
                [{ name: "id", value: { stringValue: chatId } }],
            );
            if (!chat || chat.review_id !== reviewId)
                return void res.status(404).json({ detail: "Chat not found" });

            const rawMessages = await readSessionMessages(chatId);
            res.json(snapshotMessagesToSessionMessages(rawMessages));
        } catch (err) {
            console.error("[tabular] GET /:reviewId/chats/:chatId/messages error:", err);
            res.status(500).json({ detail: "Internal server error" });
        }
    },
);

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chats — create a chat record
// ---------------------------------------------------------------------------

tabularRouter.post("/:reviewId/chats", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;

        const review = await queryOne<{
            id: string;
            user_id: string;
            project_id: string | null;
        }>(
            `SELECT id, user_id, project_id FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const chat = await queryOne<{ id: string }>(
            `INSERT INTO tabular_review_chats (review_id, user_id)
             VALUES (:reviewId, :userId)
             RETURNING id`,
            [
                { name: "reviewId", value: { stringValue: reviewId } },
                { name: "userId", value: { stringValue: userId } },
            ],
        );

        res.status(201).json({ chatId: chat!.id });
    } catch (err) {
        console.error("[tabular] POST /:reviewId/chats error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chats/:chatId/messages — generate chat title on first exchange.
// Message persistence is handled by the tabular agent (AfterInvocationEvent writes to S3).
// ---------------------------------------------------------------------------

tabularRouter.post(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const {
            user_message,
            is_first_exchange,
            review_title,
            project_name,
        } = req.body as {
            user_message: string;
            is_first_exchange?: boolean;
            review_title?: string | null;
            project_name?: string | null;
        };

        // Verify review access
        const review = await queryOne<{
            id: string;
            user_id: string;
            project_id: string | null;
            title: string | null;
        }>(
            `SELECT id, user_id, project_id, title FROM tabular_reviews WHERE id = :id`,
            [{ name: "id", value: { stringValue: reviewId } }],
        );
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        // Verify chat belongs to this review
        const chat = await queryOne<{ id: string; title: string | null }>(
            `SELECT id, title FROM tabular_review_chats
             WHERE id = :id AND review_id = :reviewId`,
            [
                { name: "id", value: { stringValue: chatId } },
                { name: "reviewId", value: { stringValue: reviewId } },
            ],
        );
        if (!chat)
            return void res.status(404).json({ detail: "Chat not found" });

        await execute(
            `UPDATE tabular_review_chats SET updated_at = NOW() WHERE id = :id`,
            [{ name: "id", value: { stringValue: chatId } }],
        );

        // Generate title on first exchange
        let title: string | null = chat.title;
        if (is_first_exchange && !title && user_message) {
            const { title_model } = await getUserModelSettings();
            title = await generateChatTitle(title_model, user_message, {
                reviewTitle: review_title ?? review.title ?? null,
                projectName: project_name ?? null,
            });
            if (title) {
                await execute(
                    `UPDATE tabular_review_chats SET title = :title WHERE id = :id`,
                    [
                        { name: "title", value: { stringValue: title } },
                        { name: "id", value: { stringValue: chatId } },
                    ],
                );
            }
        }

        res.json({ title: title ?? null });
        } catch (err) {
            console.error("[tabular] POST /:reviewId/chats/:chatId/messages error:", err);
            res.status(500).json({ detail: "Internal server error" });
        }
    },
);

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

async function queryBedrock(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
        });
    } catch (err) {
        console.error("[queryBedrock] completion failed", err);
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};

async function queryBedrockAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: ColumnConfig[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
            // malformed line — skip
        }
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        console.error("[queryBedrockAllColumns] stream failed", err);
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
