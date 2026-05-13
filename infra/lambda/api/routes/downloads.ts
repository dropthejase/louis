/**
 * Download routes — serve stored files directly or via presigned S3 URLs.
 *
 * Both endpoints verify document ownership by looking up the storage_path in
 * document_versions and then checking access on the parent document row.
 * This prevents arbitrary S3 key enumeration — callers must present a path
 * that resolves to a document the user can access.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { queryOne } from "../lib/db";
import { ensureDocAccess } from "../lib/access";
import { getSignedUrl } from "../lib/storage";

export const downloadsRouter = Router();


async function resolveDocAccess(
    storagePath: string,
    userId: string,
    userEmail: string | undefined,
): Promise<boolean> {
    const version = await queryOne<{ document_id: string }>(
        `SELECT document_id FROM document_versions WHERE storage_path = :path`,
        [{ name: "path", value: { stringValue: storagePath } }],
    );
    if (!version) return false;

    const doc = await queryOne<{ id: string; user_id: string; project_id: string | null }>(
        `SELECT id, user_id, project_id FROM documents WHERE id = :docId`,
        [{ name: "docId", value: { stringValue: version.document_id } }],
    );
    if (!doc) return false;

    const access = await ensureDocAccess(doc, userId, userEmail);
    return access.ok;
}

// GET /download?path=<storage_path>&filename=<filename>
// Returns a presigned S3 URL — browser downloads directly from S3.
downloadsRouter.get("/", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const storagePath = req.query.path as string | undefined;
        const filename = req.query.filename as string | undefined;

        if (!storagePath || !filename) {
            return void res.status(400).json({ detail: "path and filename are required" });
        }

        const allowed = await resolveDocAccess(storagePath, userId, userEmail);
        if (!allowed) return void res.status(404).json({ detail: "File not found" });

        const url = await getSignedUrl(storagePath, 900, filename);
        if (!url) return void res.status(404).json({ detail: "File not found" });

        res.json({ url });
    } catch (err) {
        console.error("[downloads] GET / error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// GET /download/presigned?path=<storage_path>&filename=<filename>
// Returns a 15-min presigned S3 URL
downloadsRouter.get("/presigned", requireAuth, async (req, res) => {
    try {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const storagePath = req.query.path as string | undefined;
        const filename = req.query.filename as string | undefined;

        if (!storagePath || !filename) {
            return void res.status(400).json({ detail: "path and filename are required" });
        }

        const allowed = await resolveDocAccess(storagePath, userId, userEmail);
        if (!allowed) return void res.status(404).json({ detail: "File not found" });

        const url = await getSignedUrl(storagePath, 900, filename);
        if (!url) return void res.status(404).json({ detail: "File not found" });

        res.json({ url });
    } catch (err) {
        console.error("[downloads] GET /presigned error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});
