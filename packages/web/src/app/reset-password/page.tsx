'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
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

  const backToSignIn = (
    <ButtonLink href="/login" size="sm" variant="ghost">
      <Icon name="arrowLeft" size={14} />
      Back to sign in
    </ButtonLink>
  );

  if (done) {
    return (
      <AuthLayout>
        <AuthHeading
          icon="checkCircle"
          kicker="Password reset"
          kickerTone="moss"
          title="Password updated"
        >
          Taking you to sign in with your new password…
        </AuthHeading>
        <ButtonLink className="w-full" href="/login" size="lg" variant="primary">
          Sign in now
        </ButtonLink>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout footer={backToSignIn}>
      <AuthHeading icon="lock" kicker="Reset password" title="Choose a new password">
        Use 8 to 128 characters. Once it is saved, you will sign in with it.
      </AuthHeading>

      {!token && (
        <Alert
          action={
            <ButtonLink href="/login" size="sm">
              Request a link
            </ButtonLink>
          }
          className="mb-5"
          title="This link has no reset token"
          variant="warning"
        >
          Request a fresh link from the sign-in page with Forgot password.
        </Alert>
      )}
      {error && (
        <Alert className="mb-5" variant="error">
          {error}
        </Alert>
      )}

      <form className="space-y-5" onSubmit={handleSubmit}>
        <Input
          autoComplete="new-password"
          error={passwordError || undefined}
          hint="At least 8 characters"
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
    </AuthLayout>
  );
}
