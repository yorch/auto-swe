'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { errMsg } from '@/lib/errors';
import { useAuthStore } from '@/stores/authStore';

export default function ResetPasswordPage() {
  // useSearchParams() needs a Suspense boundary above it for static
  // prerender. Same pattern the login page uses.
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resetPassword = useAuthStore((s) => s.resetPassword);

  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPasswordError('');
    setConfirmError('');
    if (!token) {
      setError('This link has no reset token. Request a new reset link.');
      return;
    }
    if (password.length < 8) {
      setPasswordError('Use at least 8 characters.');
      return;
    }
    if (password.length > 128) {
      setPasswordError('Use at most 128 characters.');
      return;
    }
    if (password !== confirm) {
      setConfirmError('The passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await resetPassword(token, password);
      setDone(true);
      // Tiny pause so the user sees the success state, then send them to sign in.
      setTimeout(() => router.replace('/login'), 1500);
    } catch (err: unknown) {
      setError(errMsg(err, 'Failed to reset password'));
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <AuthLayout className="text-center">
        <AuthHeading kicker="Password reset" kickerTone="moss" title="Password updated">
          <p className="text-sm text-paper-400">Taking you to sign in with your new password…</p>
        </AuthHeading>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading kicker="Reset password" title="Choose a new password">
        <p className="mb-8 text-sm text-paper-400">
          Enter a new password of 8 to 128 characters. Once it is saved you will sign in with it.
        </p>
      </AuthHeading>

      {!token && (
        <Alert className="mb-4" variant="warning">
          This link has no reset token. Request a fresh link from the sign-in page.
        </Alert>
      )}
      {error && (
        <Alert className="mb-4" variant="error">
          {error}
        </Alert>
      )}

      <form className="space-y-5" onSubmit={handleSubmit}>
        <Input
          autoComplete="new-password"
          error={passwordError || undefined}
          label="New password"
          maxLength={128}
          minLength={8}
          name="password"
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          required
          type="password"
          value={password}
        />
        <Input
          autoComplete="new-password"
          error={confirmError || undefined}
          label="Confirm new password"
          maxLength={128}
          minLength={8}
          name="confirm"
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••••"
          required
          type="password"
          value={confirm}
        />
        <Button
          className="w-full"
          disabled={loading || !token}
          size="lg"
          type="submit"
          variant="primary"
        >
          {loading ? 'Saving…' : 'Save new password'}
        </Button>
      </form>

      <div className="mt-6 text-center">
        <Link className="label-mono transition-colors hover:text-ember-400" href="/login">
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
