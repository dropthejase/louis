"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { MODELS } from "@/app/components/assistant/ModelToggle";

const TABULAR_MODELS = MODELS.filter((m) =>
    ["claude-sonnet-4-6", "claude-haiku-4-5"].includes(m.id),
);

export default function ModelsPage() {
    const { profile, updateTabularModel } = useUserProfile();

    return (
        <div className="space-y-4">
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Tabular review model
                        </label>
                        <TabularModelDropdown
                            value={profile?.tabularModel ?? "claude-sonnet-4-6"}
                            onChange={updateTabularModel}
                        />
                        <p className="text-xs text-gray-400 mt-1.5">
                            Sonnet is more thorough; Haiku is faster and cheaper.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
}: {
    value: string;
    onChange: (id: string) => void;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = TABULAR_MODELS.find((m) => m.id === value);

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="truncate text-gray-900">
                        {selected?.label ?? "Select a model"}
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                    Anthropic (via Bedrock)
                </DropdownMenuLabel>
                {TABULAR_MODELS.map((m) => (
                    <DropdownMenuItem
                        key={m.id}
                        className="cursor-pointer"
                        onSelect={() => onChange(m.id)}
                    >
                        <span className="flex-1">{m.label}</span>
                        {m.id === value && (
                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                        )}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
