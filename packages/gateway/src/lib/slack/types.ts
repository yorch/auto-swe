export interface SlackInteractivePayload {
  type?: string;
  actions?: Array<{ action_id: string; value?: string }>;
  user?: { id: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  /** Present on shortcut (`type: 'shortcut'`) + message-action (`message_action`) payloads. */
  callback_id?: string;
  /** Workspace context on shortcut / message-action payloads (the `T…` id). */
  team?: { id?: string };
  message?: { ts?: string; text?: string; thread_ts?: string };
  view?: {
    callback_id?: string;
    state?: {
      values?: Record<
        string,
        Record<string, { selected_option?: { value: string }; value?: string }>
      >;
    };
    private_metadata?: string;
  };
}

export interface SlackEventInner {
  type?: string;
  /** Present on `message.im` events; distinguishes DMs from channel messages. */
  channel_type?: string;
  /** Slack user id (`U…`) of the author. Absent on some system messages. */
  user?: string;
  /** Bot id when authored by a bot/app — used to ignore the bot's own posts. */
  bot_id?: string;
  /** Message subtype (edits, joins, …). Ignored to avoid system-message noise. */
  subtype?: string;
  /** Channel id (`C…` / `D…`). */
  channel?: string;
  /** Message text (with `<@U…>` mention tokens for app_mention). */
  text?: string;
  /** This message's timestamp. */
  ts?: string;
  /** Set when the message is already inside a thread. */
  thread_ts?: string;
  /** Workspace/team id on the event itself (not always present). */
  team?: string;
  /** App Home tab id on `app_home_opened` events (`home` | `messages`). */
  tab?: string;
}

export interface SlackEventCallback {
  type?: string;
  /** url_verification handshake. */
  challenge?: string;
  /** Top-level workspace id for event_callback envelopes. */
  team_id?: string;
  event?: SlackEventInner;
  authorizations?: Array<{ team_id?: string }>;
}
