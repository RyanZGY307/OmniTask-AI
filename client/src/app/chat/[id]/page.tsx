'use client';
import ChatWindow from '@/components/ChatWindow';

export default function ChatConversationPage({ params }: { params: { id: string } }) {
  return <ChatWindow conversationId={params.id} />;
}
