import { useCallback, useState } from "react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type {
    MikeCitationAnnotation,
    MikeEditAnnotation,
    MikeMessage,
} from "../shared/types";

interface MessageListProps {
    messages: MikeMessage[];
    isResponseLoading: boolean;
    minHeight: string;
    onCitationClick?: (citation: MikeCitationAnnotation) => void;
    onEditViewClick?: (ann: MikeEditAnnotation, filename: string) => void;
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
    onWorkflowClick?: (id: string) => void;
    /** Called when an edit error occurs — parent can surface warnings on tabs. */
    onEditError?: (args: {
        editId?: string;
        documentId: string;
        versionId?: string | null;
        message: string;
    }) => void;
    /** Called when edit resolve completes — parent can trigger doc reload. */
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    isDocReloading?: (documentId: string) => boolean;
    latestUserMessageRef?: React.RefObject<HTMLDivElement>;
    messagesEndRef?: React.RefObject<HTMLDivElement>;
}

export function MessageList({
    messages,
    isResponseLoading,
    minHeight,
    onCitationClick,
    onEditViewClick,
    onOpenDocument,
    onWorkflowClick,
    onEditError,
    onEditResolved,
    isDocReloading,
    latestUserMessageRef,
    messagesEndRef,
}: MessageListProps) {
    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );

    const handleEditResolveStart = useCallback(
        (args: { editId: string; documentId: string; verb: "accept" | "reject" }) => {
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            invalidateDocxBytes(args.documentId);
            onEditResolved?.(args);
        },
        [onEditResolved],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
            onEditError?.(args);
        },
        [onEditError],
    );

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");

    return (
        <>
            {messages.map((msg, i) =>
                msg.role === "user" ? (
                    <div
                        key={i}
                        ref={i === lastUserIdx ? latestUserMessageRef : null}
                    >
                        <UserMessage
                            content={msg.content ?? ""}
                            files={(msg as any).files}
                            workflow={(msg as any).workflow}
                        />
                    </div>
                ) : (
                    <AssistantMessage
                        key={i}
                        content={msg.content ?? ""}
                        events={msg.events}
                        isStreaming={i === messages.length - 1 && isResponseLoading}
                        isError={!!(msg as any).error}
                        errorMessage={
                            typeof (msg as any).error === "string"
                                ? (msg as any).error
                                : undefined
                        }
                        annotations={msg.annotations}
                        onCitationClick={onCitationClick}
                        minHeight={i === lastAssistantIdx ? minHeight : "0px"}
                        onWorkflowClick={onWorkflowClick}
                        onEditViewClick={onEditViewClick}
                        onOpenDocument={onOpenDocument}
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        isDocReloading={isDocReloading}
                        isEditReloading={(editId) => reloadingEditIds.has(editId)}
                        resolvedEditStatuses={resolvedEditStatuses}
                    />
                ),
            )}
            {messagesEndRef && <div ref={messagesEndRef} />}
        </>
    );
}
