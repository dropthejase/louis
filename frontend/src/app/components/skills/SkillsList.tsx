import { useCallback, useEffect, useRef, useState } from "react";
import {
    Puzzle,
    Upload,
    Info,
    ChevronDown,
    ChevronRight,
    Folder,
    FileText,
    File,
    Image,
    X,
    Trash2,
} from "lucide-react";
import {
    listSkills,
    listSkillFiles,
    getSkillFileUrl,
    getSkillUploadUrl,
    deleteSkill,
} from "@/app/lib/mikeApi";
import type { MikeSkill, MikeSkillFile } from "@/app/lib/mikeApi";

// ─── File type helpers ───────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const TEXT_EXTS = new Set(["txt", "md", "json", "xml", "html", "csv"]);
const PDF_EXTS = new Set(["pdf"]);

function fileExt(path: string): string {
    return path.split(".").pop()?.toLowerCase() ?? "";
}

function FileIcon({ path }: { path: string }) {
    const ext = fileExt(path);
    if (IMAGE_EXTS.has(ext)) return <Image className="h-3.5 w-3.5 text-purple-400 shrink-0" />;
    if (PDF_EXTS.has(ext)) return <FileText className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    if (ext === "md") return <FileText className="h-3.5 w-3.5 text-blue-400 shrink-0" />;
    return <File className="h-3.5 w-3.5 text-gray-400 shrink-0" />;
}

function canPreview(path: string): boolean {
    const ext = fileExt(path);
    return IMAGE_EXTS.has(ext) || PDF_EXTS.has(ext) || TEXT_EXTS.has(ext);
}

// ─── File viewer modal ───────────────────────────────────────────────────────

interface FileViewerProps {
    skillName: string;
    filePath: string;
    onClose: () => void;
}

function FileViewer({ skillName, filePath, onClose }: FileViewerProps) {
    const [url, setUrl] = useState<string | null>(null);
    const [textContent, setTextContent] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const ext = fileExt(filePath);

    const supported = canPreview(filePath);

    useEffect(() => {
        if (!supported) return;
        getSkillFileUrl(skillName, filePath)
            .then(async (presignedUrl) => {
                if (TEXT_EXTS.has(ext)) {
                    const res = await fetch(presignedUrl);
                    const text = await res.text();
                    setTextContent(text);
                } else {
                    setUrl(presignedUrl);
                }
            })
            .catch(() => setError(true));
    }, [skillName, filePath, ext, supported]);

    const fileName = filePath.split("/").pop() ?? filePath;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div
                className="relative bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden"
                style={{ width: "min(90vw, 900px)", height: "min(90vh, 700px)" }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <FileIcon path={filePath} />
                        <span className="text-sm font-medium text-gray-800 truncate">{fileName}</span>
                        <span className="text-xs text-gray-400 truncate hidden sm:block">— {skillName}</span>
                    </div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 transition-colors shrink-0">
                        <X className="h-4 w-4 text-gray-500" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-auto">
                        {!supported && (
                        <div className="flex items-center justify-center h-full text-sm text-gray-400">
                            Preview not supported for this file format.
                        </div>
                    )}
                    {supported && error && (
                        <div className="flex items-center justify-center h-full text-sm text-gray-400">
                            Failed to load file.
                        </div>
                    )}
                    {supported && !error && !url && !textContent && (
                        <div className="flex items-center justify-center h-full text-sm text-gray-400 animate-pulse">
                            Loading…
                        </div>
                    )}
                    {supported && !error && IMAGE_EXTS.has(ext) && url && (
                        <div className="flex items-center justify-center h-full p-4">
                            <img src={url} alt={fileName} className="max-w-full max-h-full object-contain rounded" />
                        </div>
                    )}
                    {supported && !error && PDF_EXTS.has(ext) && url && (
                        <iframe src={url} className="w-full h-full border-0" title={fileName} />
                    )}
                    {supported && !error && textContent !== null && (
                        <pre className="p-4 text-xs text-gray-700 font-mono whitespace-pre-wrap break-words leading-relaxed">
                            {textContent}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Tree renderer ───────────────────────────────────────────────────────────

type TreeNode =
    | { type: "file"; path: string; name: string; size: number }
    | { type: "dir"; name: string; children: TreeNode[] };

function TreeLevel({ nodes, depth, onFileClick }: { nodes: TreeNode[]; depth: number; onFileClick: (path: string) => void }) {
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
    const indent = 56 + depth * 16; // px-14 base + 16px per level

    function toggleDir(name: string) {
        setExpandedDirs(prev => {
            const next = new Set(prev);
            next.has(name) ? next.delete(name) : next.add(name);
            return next;
        });
    }

    return (
        <>
            {nodes.map(node => {
                if (node.type === "dir") {
                    const open = expandedDirs.has(node.name);
                    return (
                        <div key={node.name}>
                            <div
                                className="flex items-center gap-2 h-8 border-b border-gray-50 cursor-pointer hover:bg-gray-50 transition-colors select-none"
                                style={{ paddingLeft: indent }}
                                onClick={() => toggleDir(node.name)}
                            >
                                {open
                                    ? <ChevronDown className="h-3 w-3 text-gray-400 shrink-0" />
                                    : <ChevronRight className="h-3 w-3 text-gray-400 shrink-0" />
                                }
                                <Folder className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                <span className="text-xs text-gray-600">{node.name}</span>
                            </div>
                            {open && <TreeLevel nodes={node.children} depth={depth + 1} onFileClick={onFileClick} />}
                        </div>
                    );
                }
                return (
                    <div
                        key={node.path}
                        className="flex items-center gap-2 h-8 border-b border-gray-50 last:border-0 transition-colors pr-8 cursor-pointer hover:bg-gray-50"
                        style={{ paddingLeft: indent + 16 }}
                        onClick={() => onFileClick(node.path)}
                    >
                        <FileIcon path={node.path} />
                        <span className="text-xs text-gray-600 truncate flex-1">{node.name}</span>
                        <span className="text-xs text-gray-300 shrink-0 tabular-nums">
                            {node.size > 0 ? `${Math.ceil(node.size / 1024)} KB` : ""}
                        </span>
                    </div>
                );
            })}
        </>
    );
}

// ─── Skill folder row (expandable) ──────────────────────────────────────────

interface SkillRowProps {
    skill: MikeSkill;
    onDelete: (skillName: string) => void;
    deleting: boolean;
}

function SkillRow({ skill, onDelete, deleting }: SkillRowProps) {
    const [expanded, setExpanded] = useState(false);
    const [files, setFiles] = useState<MikeSkillFile[] | null>(null);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [viewer, setViewer] = useState<string | null>(null); // filePath
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!contextMenu) return;
        function handle(e: MouseEvent) {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        }
        document.addEventListener("mousedown", handle);
        return () => document.removeEventListener("mousedown", handle);
    }, [contextMenu]);

    async function toggleExpand() {
        if (!expanded && files === null) {
            setLoadingFiles(true);
            try {
                const result = await listSkillFiles(skill.skillName);
                setFiles(result);
            } catch {
                setFiles([]);
            } finally {
                setLoadingFiles(false);
            }
        }
        setExpanded((v) => !v);
    }

    function handleContextMenu(e: React.MouseEvent) {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
    }

    // Build virtual folder tree from flat S3 paths
    function buildTree(fileList: MikeSkillFile[]): TreeNode[] {
        const root: TreeNode[] = [];
        for (const f of fileList) {
            const parts = f.path.split("/");
            let nodes = root;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    nodes.push({ type: "file", path: f.path, name: part, size: f.size });
                } else {
                    let dir = nodes.find((n): n is Extract<TreeNode, { type: "dir" }> => n.type === "dir" && n.name === part);
                    if (!dir) {
                        dir = { type: "dir", name: part, children: [] };
                        nodes.push(dir);
                    }
                    nodes = dir.children;
                }
            }
        }
        function sortNodes(nodes: TreeNode[]): TreeNode[] {
            return nodes.sort((a, b) => {
                if (a.type !== b.type) return a.type === "dir" ? 1 : -1; // files before dirs at root (SKILL.md first)
                return a.name.localeCompare(b.name);
            }).map(n => n.type === "dir" ? { ...n, children: sortNodes(n.children) } : n);
        }
        // SKILL.md always first at root level
        const skillMd = root.filter(n => n.type === "file" && n.name === "SKILL.md");
        const rest = sortNodes(root.filter(n => !(n.type === "file" && n.name === "SKILL.md")));
        return [...skillMd, ...rest];
    }

    const tree = files ? buildTree(files) : [];

    return (
        <>
            {/* Skill folder row */}
            <div
                className="flex items-start px-8 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors cursor-pointer select-none group min-h-10"
                onClick={toggleExpand}
                onContextMenu={handleContextMenu}
            >
                <div className="flex items-start gap-2 w-64 shrink-0 min-w-0 pt-0.5">
                    <span className="text-gray-400 shrink-0">
                        {expanded
                            ? <ChevronDown className="h-3.5 w-3.5" />
                            : <ChevronRight className="h-3.5 w-3.5" />
                        }
                    </span>
                    <Puzzle className="h-3.5 w-3.5 text-purple-500 shrink-0" />
                    <span className="text-sm text-gray-800 font-medium truncate">{skill.name}</span>
                </div>
                <div className="flex-1 min-w-0 pr-4">
                    {skill.description ? (
                        <span className="text-xs text-gray-500 leading-snug">{skill.description}</span>
                    ) : (
                        <span className="text-xs text-gray-300">—</span>
                    )}
                </div>
            </div>

            {/* Expanded file tree */}
            {expanded && (
                <div className="border-b border-gray-50">
                    {loadingFiles ? (
                        <div className="px-14 py-2">
                            <div className="h-3 w-40 rounded bg-gray-100 animate-pulse" />
                        </div>
                    ) : tree.length === 0 ? (
                        <div className="px-14 py-2 text-xs text-gray-400">No files found.</div>
                    ) : (
                        <TreeLevel nodes={tree} depth={0} onFileClick={(path) => setViewer(path)} />
                    )}
                </div>
            )}

            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="fixed z-50 w-40 rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden text-xs"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    <button
                        disabled={deleting}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 disabled:opacity-50"
                        onClick={() => {
                            setContextMenu(null);
                            onDelete(skill.skillName);
                        }}
                    >
                        <Trash2 className="h-3.5 w-3.5 shrink-0" />
                        {deleting ? "Deleting…" : "Delete skill"}
                    </button>
                </div>
            )}

            {/* File viewer modal */}
            {viewer && (
                <FileViewer
                    skillName={skill.skillName}
                    filePath={viewer}
                    onClose={() => setViewer(null)}
                />
            )}
        </>
    );
}

// ─── Main SkillsList ─────────────────────────────────────────────────────────

export function SkillsList() {
    const [skills, setSkills] = useState<MikeSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [deletingSkill, setDeletingSkill] = useState<string | null>(null);
    const [infoExpanded, setInfoExpanded] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        listSkills()
            .then(setSkills)
            .catch(() => setSkills([]))
            .finally(() => setLoading(false));
    }, []);

    const handleFolderUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        const firstFile = files[0];
        const topFolder = (firstFile.webkitRelativePath || firstFile.name).split("/")[0];
        const skillName = topFolder;

        const fileArray = Array.from(files);

        const skillMdFile = fileArray.find(f => {
            const parts = (f.webkitRelativePath || f.name).split("/");
            return parts.length === 2 && parts[1] === "SKILL.md";
        });
        if (!skillMdFile) {
            setUploadError(`No SKILL.md found in "${skillName}". Make sure you selected the top-level skill folder.`);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }

        // Validate name field in SKILL.md matches folder name
        const skillMdText = await skillMdFile.text();
        const nameMatch = skillMdText.match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
        const declaredName = nameMatch?.[1]?.trim();
        if (!declaredName) {
            setUploadError(`SKILL.md is missing a "name:" field.`);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        if (declaredName !== skillName) {
            setUploadError(`SKILL.md name "${declaredName}" does not match folder name "${skillName}". Update the name field or rename the folder.`);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }

setUploading(true);
        setUploadError(null);

        try {
            for (const file of fileArray) {
                const relativePath = file.webkitRelativePath || file.name;
                const filePath = relativePath.split("/").slice(1).join("/");
                if (!filePath) continue;

                const { url } = await getSkillUploadUrl(skillName, filePath, file.type || "application/octet-stream");
                await fetch(url, {
                    method: "PUT",
                    body: file,
                    headers: { "Content-Type": file.type || "application/octet-stream" },
                });
            }

            const updated = await listSkills();
            setSkills(updated);
        } catch {
            setUploadError("Upload failed. Please try again.");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }, []);

    const handleDelete = useCallback(async (skillName: string) => {
        setDeletingSkill(skillName);
        try {
            await deleteSkill(skillName);
            setSkills((prev) => prev.filter((s) => s.skillName !== skillName));
        } catch {
            // leave list unchanged on error
        } finally {
            setDeletingSkill(null);
        }
    }, []);

    return (
        <div className="flex flex-col flex-1 overflow-hidden bg-white">
            {/* Header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <h1 className="text-2xl font-medium font-serif text-gray-900">Skills</h1>
                <div className="flex items-center gap-2">
                    <input
                        ref={fileInputRef}
                        type="file"
                        // @ts-expect-error webkitdirectory is non-standard
                        webkitdirectory=""
                        multiple
                        className="hidden"
                        onChange={handleFolderUpload}
                        disabled={uploading}
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                        <Upload className="h-3.5 w-3.5" />
                        {uploading ? "Uploading…" : "Upload Skill"}
                    </button>
                </div>
            </div>

            {/* Info banner */}
            <div className="mx-8 mb-4 rounded-lg bg-gray-50 border border-gray-200 shrink-0 overflow-hidden">
                <button
                    onClick={() => setInfoExpanded(v => !v)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-gray-500 hover:bg-gray-100 transition-colors text-left"
                >
                    <Info className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="flex-1">Skills give the assistant on-demand access to specialised instructions and reference files.</span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${infoExpanded ? "rotate-180" : ""}`} />
                </button>
                {infoExpanded && (
                    <div className="px-4 pb-4 pt-1 text-xs text-gray-500 space-y-3 border-t border-gray-200">
                        <p>
                            Upload a folder as a skill. The assistant discovers available skills automatically and loads their full instructions on demand — keeping the context window lean.
                        </p>

                        <div>
                            <p className="font-medium text-gray-700 mb-1">Folder structure</p>
                            <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] leading-relaxed text-gray-600 font-mono">{`my-skill/
├── SKILL.md          ← required
└── references/       ← documents & images
    ├── handbook.pdf
    └── diagram.png`}</pre>
                        </div>

                        <div>
                            <p className="font-medium text-gray-700 mb-1">SKILL.md format</p>
                            <pre className="bg-white border border-gray-200 rounded p-2 text-[11px] leading-relaxed text-gray-600 font-mono">{`---
name: my-skill
description: "One-line description."
---

Full instructions for the assistant go here.`}</pre>
                            <ul className="mt-1.5 space-y-0.5 text-gray-500">
                                <li><span className="font-semibold text-purple-700">name</span> must exactly match the folder name.</li>
                                <li><span className="font-semibold text-purple-700">description</span> must be quoted if it contains a colon.</li>
                            </ul>
                        </div>

                        <div>
                            <p className="font-medium text-gray-700 mb-1">Supported file types <span className="font-normal text-gray-400">(within references/ folder)</span></p>
                            <p>Documents: <span className="font-mono">pdf, docx, doc, xlsx, xls, csv, txt, md, html, json, xml</span></p>
                            <p className="mt-0.5">Images: <span className="font-mono">png, jpg, jpeg, gif, webp</span></p>
                        </div>

                        <div className="rounded bg-amber-50 border border-amber-100 px-2.5 py-2 text-amber-700">
                            <span className="font-medium">Limitation:</span> Scripts inside skills are not executed. The assistant can read reference files and follow instructions, but cannot run code.
                        </div>
                    </div>
                )}
            </div>

            {uploadError && (
                <div className="mx-8 mb-3 rounded-lg bg-red-50 border border-red-100 px-3 py-2 text-xs text-red-600 shrink-0">
                    {uploadError}
                </div>
            )}

            {/* Table */}
            <div className="flex-1 overflow-auto">
                <div className="w-full">
                    {/* Column headers */}
                    <div className="flex items-center h-8 px-8 border-b border-gray-200 text-xs text-gray-500 font-medium select-none">
                        <div className="w-64 shrink-0">Name</div>
                        <div className="flex-1 min-w-0">Description</div>
                    </div>

                    {loading ? (
                        <div>
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="flex items-center h-10 px-8 border-b border-gray-50">
                                    <div className="w-64 shrink-0">
                                        <div className="h-3.5 w-40 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="h-3 w-64 rounded bg-gray-100 animate-pulse" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : skills.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto px-8">
                            <Puzzle className="h-8 w-8 text-gray-300 mb-4" />
                            <p className="text-2xl font-medium font-serif text-gray-900">Skills</p>
                            <p className="mt-1 text-xs text-gray-400 text-left">
                                Upload skill folders to give the assistant specialised instructions and reference materials.
                            </p>
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                                className="mt-4 inline-flex items-center gap-1 rounded-full bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors shadow-md disabled:opacity-50"
                            >
                                + Upload Skill
                            </button>
                        </div>
                    ) : (
                        skills.map((skill) => (
                            <SkillRow
                                key={skill.skillName}
                                skill={skill}
                                deleting={deletingSkill === skill.skillName}
                                onDelete={handleDelete}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
