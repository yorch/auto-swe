'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { errMsg } from '@/lib/errors';
import { useAuthStore } from '@/stores/authStore';

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

/** The server's wording for a token it will not accept, whether expired, used or forged. */
const REJECTED_TOKEN = /invalid|expired|not valid|already been used/i;

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
  const searchParams = useSearchParams();
  const resetPassword = useAuthStore((s) => s.resetPassword);

  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirmError, setConfirmError] = useState('');
  const [tokenRejected, setTokenRejected] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPasswordError('');
    setConfirmError('');
    if (!token) {
      return;
    }
    if (password.length < MIN_LENGTH) {
      setPasswordError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password.length > MAX_LENGTH) {
      setPasswordError(`Use at most ${MAX_LENGTH} characters.`);
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
    } catch (err: unknown) {
      const message = errMsg(err, 'Failed to reset password');
      if (REJECTED_TOKEN.test(message)) {
        setTokenRejected(true);
      } else {
        setError(message);
      }
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
        <div role="status">
          <AuthHeading icon="checkCircle" title="Password updated" tone="success">
            Your password has been saved. Sign in with it to continue.
          </AuthHeading>
        </div>
        <ButtonLink className="w-full" href="/login" size="lg" variant="primary">
          Sign in now
        </ButtonLink>
      </AuthLayout>
    );
  }

  // No usable link: the form would only fail, so the page says so and offers the next step.
  if (!token || tokenRejected) {
    return (
      <AuthLayout footer={backToSignIn}>
        <div role="alert">
          <AuthHeading icon="warning" title="This reset link is not valid" tone="warning">
            {tokenRejected
              ? 'The link has expired or has already been used. Reset links work once.'
              : 'The link is incomplete, so it cannot reset your password.'}
          </AuthHeading>
        </div>
        <ButtonLink className="w-full" href="/login" size="lg" variant="primary">
          Go to sign in
        </ButtonLink>
        <p className="mt-4 text-sm leading-relaxed text-paper-500">
          On the sign-in page, use Forgot password to get a new link.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout footer={backToSignIn}>
      <AuthHeading icon="lock" title="Choose a new password">
        Use {MIN_LENGTH} to {MAX_LENGTH} characters. Once it is saved, you will sign in with it.
      </AuthHeading>

      {error && (
        <Alert className="mb-5" variant="error">
          {error}
        </Alert>
      )}

      {/* noValidate: the field messages below are the validation, not the browser's bubbles. */}
      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <Input
          autoComplete="new-password"
          error={passwordError || undefined}
          label="New password"
          maxLength={MAX_LENGTH}
          name="password"
          onChange={(e) => {
            setPassword(e.target.value);
            setPasswordError('');
          }}
          placeholder="••••••••••"
          required
          type={showPasswords ? 'text' : 'password'}
          value={password}
        />
        <Input
          autoComplete="new-password"
          error={confirmError || undefined}
          label="Confirm new password"
          maxLength={MAX_LENGTH}
          name="confirm"
          onBlur={() => {
            if (confirm && confirm !== password) {
              setConfirmError('The passwords do not match.');
            }
          }}
          onChange={(e) => {
            setConfirm(e.target.value);
            setConfirmError('');
          }}
          placeholder="••••••••••"
          required
          type={showPasswords ? 'text' : 'password'}
          value={confirm}
        />
        <Checkbox
          checked={showPasswords}
          label="Show passwords"
          onChange={(e) => setShowPasswords(e.target.checked)}
        />
        <Button className="w-full" disabled={loading} size="lg" type="submit" variant="primary">
          {loading ? 'Saving…' : 'Save new password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
