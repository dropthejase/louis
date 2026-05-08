"use client";

import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ModelOption {
    id: string;
    label: string;
    description: string;
    group: "Anthropic";
}

export const MODELS: ModelOption[] = [
    {
        id: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        group: "Anthropic",
        description: "Most capable — complex reasoning, long documents",
    },
    {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        group: "Anthropic",
        description: "Balanced — fast and capable",
    },
    {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        group: "Anthropic",
        description: "Fastest — lightweight tasks",
    },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

interface Props {
    value: string;
    onChange: (id: string) => void;
}

export function ModelToggle({ value, onChange }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedLabel = selected?.label ?? "Model";

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-700 ${isOpen ? "bg-gray-100 text-gray-700" : ""}`}
                    title="Choose model"
                >
                    <span className="max-w-[140px] truncate">{selectedLabel}</span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64 z-50" side="top" align="start">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                    Anthropic (via Bedrock)
                </DropdownMenuLabel>
                {MODELS.map((m) => (
                    <DropdownMenuItem
                        key={m.id}
                        className="cursor-pointer flex-col items-start"
                        onSelect={() => onChange(m.id)}
                    >
                        <div className="flex w-full items-center">
                            <span className="flex-1">{m.label}</span>
                            {m.id === value && (
                                <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                            )}
                        </div>
                        <span className="text-[11px] text-gray-400 font-normal">
                            {m.description}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
