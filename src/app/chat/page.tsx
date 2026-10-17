'use client';
import { useRouter } from 'next/navigation';
import ChatWindow from '@/components/ChatWindow';

// 新对话页（/chat，无会话 ID）：欢迎屏。
// 发送首条消息时 ChatWindow 创建会话，onNewConversation 回调携带新 ID，
// 这里 router.replace('/chat/{id}')：
//   - replace 不新增历史条目 → 浏览器"返回"干净回到 /chat 之前的页面（BUG-002/003）
//   - Next.js 路由真正导航，/chat/{id} 正常渲染会话，无需手动刷新（BUG-001）
export default function ChatPage() {
  const router = useRouter();
  return (
    <ChatWindow
      conversationId={null}
      onNewConversation={(id) => router.replace(`/chat/${id}`)}
    />
  );
}
