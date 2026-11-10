'use client';
import { useParams } from 'next/navigation';
import ChatWindow from '@/components/ChatWindow';


export default function ChatConversationPage(_props?: { id?: string }) {
  const { id } = useParams<{ id: string }>();
  return <ChatWindow conversationId={id} />;
}
