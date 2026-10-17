'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isLoggedIn } from '@/lib/auth';
import { useAuthStore } from '@/store/authStore';

export default function RegisterPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (user || isLoggedIn()) {
      router.replace('/chat');
    } else {
      // Unified auth UI: skip the entrance animation and land on the auth phase.
      router.replace('/onboarding?phase=auth');
    }
  }, [user]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full anim-spin" />
    </div>
  );
}
