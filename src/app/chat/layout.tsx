'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import { useSettingsStore, applyAppearanceClasses } from '@/store/settingsStore';
import Sidebar from '@/components/Sidebar';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { loadUser } = useAuthStore();
  const { appearance, language } = useSettingsStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    loadUser();
    if (!isLoggedIn()) { router.replace('/onboarding'); return; }
    setMounted(true);
  }, []);

  useEffect(() => {
    applyAppearanceClasses(appearance);
  }, [appearance]);

  useEffect(() => {
    const openSidebar = () => setSidebarOpen(true);
    window.addEventListener('open-chat-sidebar', openSidebar);
    return () => window.removeEventListener('open-chat-sidebar', openSidebar);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    if (language) document.documentElement.lang = language;
  }, [language, mounted]);

  if (!mounted) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-bg" style={{ height: '100dvh' }}>
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex-1 flex flex-col min-w-0 relative">
        {children}
      </main>
    </div>
  );
}
