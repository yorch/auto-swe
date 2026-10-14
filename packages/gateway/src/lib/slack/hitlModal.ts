import crypto from 'node:crypto';
import { escapeSlackMrkdwn } from '../hitlSlackSync.js';

export const HITL_MODAL_CALLBACK_ID = 'hitl_resolve_modal';
export const HITL_COMMENT_BLOCK = 'hitl_comment_block';
export const HITL_COMMENT_INPUT = 'hitl_comment_input';
/** Same bounds as the dashboard's reject reason. */
export const HITL_COMMENT_MAX = 2000;
/** Slack caps `private_metadata` at 3000 characters. */
export const HITL_MODAL_PRIVATE_METADATA_MAX = 3000;

export interface HitlModalMetadata {
  stepId: string;
  action: 'approve' | 'reject';
  /** The Slack user the modal was opened for; a submission must come from the same one. */
  slackUserId: string;
  /** Where the confirmation goes — presentation only, never consulted for authorization. */
  channelId?: string;
  messageTs?: string;
}

function hmacHex(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(`hitl-modal:${data}`).digest('hex');
}

/**
 * `private_metadata` round-trips through the client, so it is signed with the Slack signing secret
 * and verified on submission. The signature is defence in depth: the step id it names is still
 * re-authorized against the submitter on every submission.
 */
export function signHitlModalMetadata(metadata: HitlModalMetadata, secret: string): string {
  const body = Buffer.from(JSON.stringify(metadata)).toString('base64url');
  return `${body}.${hmacHex(secret, body)}`;
}

export function verifyHitlModalMetadata(
  raw: string | undefined,
  secret: string
): HitlModalMetadata | null {
  const [body, sig, ...rest] = (raw ?? '').split('.');
  if (!body || !sig || rest.length > 0) {
    return null;
  }
  const expected = Buffer.from(hmacHex(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString()
    ) as Partial<HitlModalMetadata>;
    if (
      typeof parsed.stepId !== 'string' ||
      !parsed.stepId ||
      (parsed.action !== 'approve' && parsed.action !== 'reject') ||
      typeof parsed.slackUserId !== 'string'
    ) {
      return null;
    }
    return {
      action: parsed.action,
      slackUserId: parsed.slackUserId,
      stepId: parsed.stepId,
      ...(typeof parsed.channelId === 'string' ? { channelId: parsed.channelId } : {}),
      ...(typeof parsed.messageTs === 'string' ? { messageTs: parsed.messageTs } : {}),
    };
  } catch {
    return null;
  }
}

export function buildHitlCommentModalView(input: {
  action: 'approve' | 'reject';
  stepTitle: string;
  privateMetadata: string;
}): unknown {
  const reject = input.action === 'reject';
  return {
    blocks: [
      {
        text: {
          text: `*${escapeSlackMrkdwn(input.stepTitle).slice(0, 300)}*\n${
            reject
              ? 'Rejecting sends the run down its rejection path.'
              : 'Approving lets the run continue to its next step.'
          }`,
          type: 'mrkdwn',
        },
        type: 'section',
      },
      {
        block_id: HITL_COMMENT_BLOCK,
        element: {
          action_id: HITL_COMMENT_INPUT,
          max_length: HITL_COMMENT_MAX,
          multiline: true,
          type: 'plain_text_input',
        },
        label: { text: reject ? 'Reason' : 'Comment (optional)', type: 'plain_text' },
        optional: !reject,
        type: 'input',
      },
    ],
    callback_id: HITL_MODAL_CALLBACK_ID,
    close: { text: 'Cancel', type: 'plain_text' },
    private_metadata: input.privateMetadata,
    submit: { text: reject ? 'Reject' : 'Approve', type: 'plain_text' },
    title: { text: reject ? 'Reject step' : 'Approve step', type: 'plain_text' },
    type: 'modal',
  };
}
