import { useNavigate } from 'react-router-dom';
import { useAssistantChat } from '@/app/hooks/useAssistantChat';
import { InitialView } from '@/app/components/assistant/InitialView';
import { ChatView } from '@/app/components/assistant/ChatView';
import { getCurrentUserId } from '@/lib/aws/amplify-auth';
import type { MikeMessage } from '@/app/components/shared/types';

export default function AssistantPage() {
  const navigate = useNavigate();
  const { messages, isResponseLoading, handleChat, handleNewChat, cancel } =
    useAssistantChat();

  async function handleInitialSubmit(message: MikeMessage) {
    const chatId = await handleNewChat(message);
    if (chatId) {
      const userId = await getCurrentUserId().catch(() => 'unknown');
      const runtimeSessionId = `${userId}-${chatId}`;
      navigate(`/assistant/chat/${chatId}`, { state: { runtimeSessionId, pendingMessage: message } });
    }
  }

  if (messages.length === 0) {
    return <InitialView onSubmit={(message) => void handleInitialSubmit(message)} />;
  }

  return (
    <ChatView
      messages={messages}
      isResponseLoading={isResponseLoading}
      handleChat={handleChat}
      cancel={cancel}
    />
  );
}
