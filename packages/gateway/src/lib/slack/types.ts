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
