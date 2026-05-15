import { useState, useEffect } from 'react';
import { Check, ChevronDown, HelpCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUserProfile } from '@/contexts/UserProfileContext';
import { MODELS } from '@/app/components/assistant/ModelToggle';
import { apiRequest } from '@/app/lib/mikeApi';

const TABULAR_MODELS = MODELS.filter((m) =>
  ['claude-sonnet-4-6', 'claude-haiku-4-5'].includes(m.id),
);

interface McpServer {
  id: string;
  url: string;
}

export default function AccountModelsPage() {
  const { profile, updateTabularModel, updateDisabledMcpServers } = useUserProfile();
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpHelpOpen, setMcpHelpOpen] = useState(false);

  useEffect(() => {
    apiRequest<{ servers: McpServer[] }>('/user/mcp-servers')
      .then((data) => setMcpServers(data?.servers ?? []))
      .catch(() => setMcpServers([]));
  }, []);

  const handleMcpToggle = async (serverId: string, enabled: boolean) => {
    if (!profile) return;
    const updated = enabled
      ? profile.disabledMcpServers.filter((id) => id !== serverId)
      : [...profile.disabledMcpServers, serverId];
    await updateDisabledMcpServers(updated);
  };

  return (
    <div className="space-y-8">
      <div className="pb-6">
        <h2 className="text-2xl font-medium font-serif mb-4">Agent Settings</h2>

        <div className="space-y-6">
          <div className="space-y-4 max-w-md">
            <h3 className="text-sm font-medium text-gray-700">Model preferences</h3>
            <div>
              <label className="text-sm text-gray-600 block mb-2">Tabular review model</label>
              <TabularModelDropdown
                value={profile?.tabularModel ?? 'claude-sonnet-4-6'}
                onChange={updateTabularModel}
              />
              <p className="text-xs text-gray-400 mt-1.5">
                Sonnet is more thorough; Haiku is faster and cheaper.
              </p>
            </div>
          </div>

          <div className="space-y-3 max-w-md">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-gray-700">MCP servers</h3>
              <button
                type="button"
                onClick={() => setMcpHelpOpen((v) => !v)}
                className="text-gray-400 hover:text-gray-600 focus:outline-none"
                aria-label="MCP server help"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </div>
            {mcpHelpOpen && (
              <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600 space-y-1.5">
                <p>MCP servers extend the agent with additional tools. Only your AWS administrator can add approved servers.</p>
                <p>Servers are configured in <code className="font-mono bg-gray-100 px-1 rounded">config/mcp.json</code> in the admin S3 bucket using the following format:</p>
                <pre className="font-mono bg-gray-100 rounded p-2 text-[11px] overflow-x-auto">{`{
  "mcpServers": {
    "server-id": {
      "url": "https://example.com/mcp"
    }
  }
}`}</pre>
              </div>
            )}
            {mcpServers.length === 0 ? (
              <p className="text-sm text-gray-400">No MCP servers configured by your administrator.</p>
            ) : (
              <div className="space-y-2">
                {mcpServers.map((server) => {
                  const isEnabled = !profile?.disabledMcpServers.includes(server.id);
                  return (
                    <div key={server.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                      <p className="text-sm text-gray-900">{server.id}</p>
                      <button
                        type="button"
                        onClick={() => handleMcpToggle(server.id, !isEnabled)}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-black/10 ${isEnabled ? 'bg-gray-900' : 'bg-gray-200'}`}
                        role="switch"
                        aria-checked={isEnabled}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${isEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-gray-400">Changes take effect on your next conversation.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabularModelDropdown({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = TABULAR_MODELS.find((m) => m.id === value);

  return (
    <DropdownMenu onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
        >
          <span className="truncate text-gray-900">{selected?.label ?? 'Select a model'}</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="z-50"
        style={{ width: 'var(--radix-dropdown-menu-trigger-width)' }}
        align="start"
      >
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
          Anthropic (via Bedrock)
        </DropdownMenuLabel>
        {TABULAR_MODELS.map((m) => (
          <DropdownMenuItem key={m.id} className="cursor-pointer" onSelect={() => onChange(m.id)}>
            <span className="flex-1">{m.label}</span>
            {m.id === value && <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
