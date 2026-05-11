import { useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAssistantChat } from '@/app/hooks/useAssistantChat';
import { useChatHistoryContext } from '@/app/contexts/ChatHistoryContext';
import { ChatView } from '@/app/components/assistant/ChatView';
import type { MikeMessage } from '@/app/components/shared/types';

// Wrapper forces full unmount/remount when chat ID changes by using id as key.
export default function AssistantChatPageWrapper() {
  const { id } = useParams<{ id: string }>();
  return <AssistantChatPage key={id} id={id!} />;
}

function AssistantChatPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as { runtimeSessionId?: string; pendingMessage?: MikeMessage } | null;
  const { setCurrentChatId, newChatMessages, setNewChatMessages } = useChatHistoryContext();

  const initialMessages = newChatMessages ?? [];
  const { messages, isResponseLoading, handleChat, cancel } = useAssistantChat({
    initialMessages,
    chatId: id,
    initialRuntimeSessionId: routeState?.runtimeSessionId,
  });

  const autoSubmittedRef = useRef(false);

  useEffect(() => {
    setCurrentChatId(id);
  }, [id, setCurrentChatId]);

  // Clear newChatMessages after consuming them
  useEffect(() => {
    if (initialMessages.length > 0 && newChatMessages) {
      setNewChatMessages(null);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-submit the first message when navigating from a new chat creation.
  // Covers two paths: direct navigate with pendingMessage in state (AssistantPage),
  // and workflow modal which sets newChatMessages before navigating.
  useEffect(() => {
    if (autoSubmittedRef.current) return;
    const pending = routeState?.pendingMessage ?? (initialMessages.length === 1 ? initialMessages[0] : undefined);
    if (!pending) return;
    autoSubmittedRef.current = true;
    void handleChat(pending);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // If messages loaded empty (deleted/invalid chat), go back to /assistant
  useEffect(() => {
    // Give the hook time to load; only redirect if still empty after load settles
    const t = setTimeout(() => {
      if (messages.length === 0 && !isResponseLoading && initialMessages.length === 0) {
        navigate('/assistant', { replace: true });
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [messages.length, isResponseLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ChatView
      messages={messages}
      isResponseLoading={isResponseLoading}
      handleChat={handleChat}
      cancel={cancel}
    />
  );
}
