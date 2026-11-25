// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { McpServersList } from './McpServersList';

describe('McpServersList', () => {
  it('flags http as supported and stdio as unsupported, with the mapping sentence', () => {
    render(
      <McpServersList
        servers={[
          { name: 'docs', supported: true, transport: 'http', url: 'https://mcp.example.com/x' },
          { name: 'local', supported: false, transport: 'stdio', url: null },
        ]}
      />
    );
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('https://mcp.example.com/x')).toBeTruthy();
    expect(screen.getByText('Supported')).toBeTruthy();
    expect(screen.getByText('Unsupported')).toBeTruthy();
    expect(screen.getByText(/can map each supported server to an/)).toBeTruthy();
  });

  it('says when there are none', () => {
    render(<McpServersList servers={[]} />);
    expect(screen.getByText('The plugin declares no MCP servers.')).toBeTruthy();
  });
});
