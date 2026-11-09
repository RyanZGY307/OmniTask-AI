'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';
import AdminSidebar from '@/components/AdminSidebar';
import AdminPinGate from '@/components/admin/AdminPinGate';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { loadUser, user } = useAuthStore();
  const [mounted, setMounted] = useState(false);
  const [pinOk, setPinOk] = useState(false);

  useEffect(() => {
    loadUser();
    if (!isLoggedIn()) { router.replace('/onboarding'); return; }
    setPinOk(sessionStorage.getItem('cortex_admin_pin_ok') === '1');
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && user && user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') router.replace('/chat');
  }, [mounted, user]);

  if (!mounted || !user) return <div className="h-screen flex items-center justify-center bg-bg"><div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" /></div>;

  // 第二道门槛：管理员身份之外，还需输入环境变量中的六位管理密码（会话级）
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    if (!pinOk) return <AdminPinGate onOk={() => setPinOk(true)} />;
  }

  return (
    <div className="h-screen flex bg-bg">
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto pt-12 lg:pt-0">
        <div className="max-w-6xl mx-auto px-3 sm:px-5 lg:px-6 py-5 sm:py-6 lg:py-8">{children}</div>
      </main>
    </div>
  );
}