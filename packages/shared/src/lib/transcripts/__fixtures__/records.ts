/**
 * Realistic captured transcript records (the `request`/`response` shapes the
 * recorder writes after JSON.parse), one streamed and one plain variant per
 * provider.
 */

export const anthropicJson = {
  kind: 'http_call',
  path: '/v1/messages',
  request: {
    max_tokens: 1024,
    messages: [
      { content: [{ text: 'Fix the bug', type: 'text' }], role: 'user' },
      {
        content: [
          {
            content: [{ text: 'it worked', type: 'text' }],
            is_error: false,
            tool_use_id: 'toolu_1',
            type: 'tool_result',
          },
        ],
        role: 'user',
      },
    ],
    model: 'claude-opus-5-5',
    system: 'You are an implementer.',
    tools: [
      {
        description: 'Run a shell command',
        input_schema: { properties: { command: { type: 'string' } }, type: 'object' },
        name: 'bash',
      },
    ],
  },
  response: {
    body: {
      content: [
        { text: 'Running the test.', type: 'text' },
        { id: 'toolu_2', input: { command: 'yarn test' }, name: 'bash', type: 'tool_use' },
      ],
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      type: 'message',
      usage: { input_tokens: 120, output_tokens: 30 },
    },
    contentType: 'application/json',
  },
};

export const anthropicSse = {
  kind: 'http_call',
  path: '/v1/messages',
  request: anthropicJson.request,
  response: {
    body: [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5-5","usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":40,"cache_creation_input_tokens":5}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me see"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"bash"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"yarn t"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"est\\"}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n'),
    contentType: 'text/event-stream',
  },
};

export const openaiResponsesJson = {
  kind: 'http_call',
  path: '/v1/responses',
  request: {
    input: [
      {
        content: [{ text: 'Summarize this diff', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      {
        call_id: 'call_1',
        output: 'the test passed',
        type: 'function_call_output',
      },
    ],
    instructions: 'Be concise.',
    model: 'gpt-5.5',
    tools: [
      {
        description: 'Run tests',
        name: 'run_tests',
        parameters: { properties: {}, type: 'object' },
        type: 'function',
      },
    ],
  },
  response: {
    body: {
      model: 'gpt-5.5',
      object: 'response',
      output: [
        {
          content: [{ text: 'The diff renames two functions.', type: 'output_text' }],
          role: 'assistant',
          type: 'message',
        },
        {
          arguments: '{}',
          call_id: 'call_2',
          name: 'run_tests',
          type: 'function_call',
        },
      ],
      status: 'completed',
      usage: {
        input_tokens: 200,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens: 40,
      },
    },
    contentType: 'application/json',
  },
};

export const openaiResponsesSse = {
  kind: 'http_call',
  path: '/v1/responses',
  request: openaiResponsesJson.request,
  response: {
    body: [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"The diff renames"}',
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ response: openaiResponsesJson.response.body, type: 'response.completed' })}`,
      '',
    ].join('\n'),
    contentType: 'text/event-stream',
  },
};

export const openaiChatJson = {
  kind: 'http_call',
  path: '/v1/chat/completions',
  request: {
    messages: [
      { content: 'You are a reviewer.', role: 'system' },
      { content: 'Review this PR.', role: 'user' },
    ],
    model: 'litellm-gpt',
    tools: [
      {
        function: {
          description: 'Leave a comment',
          name: 'comment',
          parameters: { properties: { body: { type: 'string' } }, type: 'object' },
        },
        type: 'function',
      },
    ],
  },
  response: {
    body: {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{"body":"looks good"}', name: 'comment' },
                id: 'call_1',
                type: 'function',
              },
            ],
          },
        },
      ],
      model: 'litellm-gpt',
      usage: { completion_tokens: 12, prompt_tokens: 80 },
    },
    contentType: 'application/json',
  },
};

export const openaiChatSse = {
  kind: 'http_call',
  path: '/v1/chat/completions',
  request: openaiChatJson.request,
  response: {
    body: [
      'data: {"id":"chatcmpl-1","model":"litellm-gpt","choices":[{"index":0,"delta":{"role":"assistant","content":"Looks"}}]}',
      '',
      'data: {"id":"chatcmpl-1","model":"litellm-gpt","choices":[{"index":0,"delta":{"content":" good"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
    contentType: 'text/event-stream',
  },
};

export const googleJson = {
  kind: 'http_call',
  path: '/v1beta/models/gemini-3-pro:generateContent?alt=json',
  request: {
    contents: [
      { parts: [{ text: 'Describe the repo' }], role: 'user' },
      {
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { content: 'file contents' },
            },
          },
        ],
        role: 'function',
      },
    ],
    systemInstruction: { parts: [{ text: 'You explore code.' }] },
    tools: [
      {
        functionDeclarations: [
          {
            description: 'Read a file',
            name: 'read_file',
            parameters: { properties: { path: { type: 'string' } }, type: 'object' },
          },
        ],
      },
    ],
  },
  response: {
    body: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { args: { path: 'README.md' }, name: 'read_file' } }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      modelVersion: 'gemini-3-pro',
      usageMetadata: {
        candidatesTokenCount: 20,
        promptTokenCount: 300,
      },
    },
    contentType: 'application/json',
  },
};

export const googleSse = {
  kind: 'http_call',
  path: '/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse',
  request: googleJson.request,
  response: {
    body: [
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'Reading the file now.' }], role: 'model' },
          },
        ],
        modelVersion: 'gemini-3-pro',
      })}`,
      '',
      `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'Done.' }], role: 'model' },
            finishReason: 'STOP',
          },
        ],
        modelVersion: 'gemini-3-pro',
        usageMetadata: {
          candidatesTokenCount: 25,
          promptTokenCount: 300,
          thoughtsTokenCount: 5,
        },
      })}`,
      '',
    ].join('\n'),
    contentType: 'text/event-stream',
  },
};

export const harnessAssistant = {
  kind: 'harness_message',
  message: {
    message: {
      content: [
        { text: 'Checking the tests.', type: 'text' },
        { id: 'toolu_1', input: { command: 'yarn test' }, name: 'Bash', type: 'tool_use' },
      ],
      id: 'msg_1',
      model: 'claude-opus-5-5',
    },
    type: 'assistant',
  },
};

/** A non-proxied Claude Code turn's session-file delta, as the harness writes it. */
export const harnessSessionFile = {
  bytes: 4096,
  kind: 'harness_session_file',
  lines: [
    {
      isSidechain: false,
      message: { content: 'Make the failing test pass.', role: 'user' },
      sessionId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9',
      type: 'user',
      uuid: 'u-1',
    },
    {
      isSidechain: false,
      message: {
        content: [
          { text: 'Running the tests first.', type: 'text' },
          { id: 'toolu_1', input: { command: 'yarn test' }, name: 'Bash', type: 'tool_use' },
        ],
        id: 'msg_1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        usage: {
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 40,
          input_tokens: 120,
          output_tokens: 30,
        },
      },
      parentUuid: 'u-1',
      type: 'assistant',
      uuid: 'a-1',
    },
    {
      isSidechain: false,
      message: {
        content: [
          { content: '1 failed', is_error: true, tool_use_id: 'toolu_1', type: 'tool_result' },
        ],
        role: 'user',
      },
      parentUuid: 'a-1',
      toolUseResult: { stdout: '1 failed' },
      type: 'user',
      uuid: 'u-2',
    },
    {
      isSidechain: true,
      message: {
        content: [{ text: 'Subagent: searching the codebase.', type: 'text' }],
        id: 'msg_side',
        model: 'claude-haiku-4-5-20251001',
        role: 'assistant',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      type: 'assistant',
      uuid: 's-1',
    },
    { leafUuid: 'a-1', summary: 'Fixing a failing test', type: 'summary' },
    '{"truncated line',
  ],
  offset: 0,
  path: '/workspace/.harness/home/.claude/projects/-workspace-target-repo/0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9.jsonl',
  runtime: 'claude-code',
  sessionId: '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9',
  truncated: false,
};
