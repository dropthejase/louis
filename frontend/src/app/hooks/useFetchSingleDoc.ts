
import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/aws/config";
import { getIdToken } from "@/lib/aws/amplify-auth";

/**
 * /display returns either PDF bytes (when the active version has a PDF
 * rendition) or raw DOCX bytes otherwise. Reporting the type lets the
 * caller swap between DocView (PDF.js) and DocxView (docx-preview)
 * accordingly.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                const token = await getIdToken();
                if (cancelled) return;

                const apiBase = API_URL;
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";

                // Step 1: get presigned URL + type from API
                const metaResp = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
                );
                if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status}`);
                if (cancelled) return;

                const { url, type } = await metaResp.json() as { url: string; type: string; filename: string };

                if (type === "pdf") {
                    // Step 2: fetch PDF bytes directly from S3 (presigned URL is self-authenticating)
                    const pdfResp = await fetch(url);
                    if (!pdfResp.ok) throw new Error(`S3 fetch HTTP ${pdfResp.status}`);
                    const buffer = await pdfResp.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else {
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
