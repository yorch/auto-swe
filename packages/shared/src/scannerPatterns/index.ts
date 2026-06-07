export interface BuiltinScannerPatternDef {
  flags: string;
  label: string;
  pattern: string;
  type: 'INJECTION' | 'EXFILTRATION';
}

/**
 * Built-in scanner patterns seeded into the scanner_patterns table on yarn db:seed.
 * All are isBuiltIn=true and cannot be deleted via the admin UI (only disabled).
 *
 * Safe flag subset: i, m, s, u, v — g/y are rejected at the API layer.
 */
export const BUILTIN_SCANNER_PATTERNS: BuiltinScannerPatternDef[] = [
  // ── Injection patterns ────────────────────────────────────────────────────
  // Direct instruction override attempts
  {
    flags: 'i',
    label: 'ignore-previous-instructions',
    pattern: 'ignore\\s+(all\\s+)?previous\\s+instructions',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'forget-instructions',
    pattern: 'forget\\s+(everything|all\\s+instructions)',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'disregard-guidelines',
    pattern: 'disregard\\s+(your\\s+)?(guidelines|instructions|rules)',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'new-instructions',
    pattern: '---\\s*new\\s+instructions\\s*---',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'system-prompt-override',
    pattern: '\\[SYSTEM\\]|\\bSYSTEM\\s*PROMPT\\b',
    type: 'INJECTION',
  },

  // Persona / role-play jailbreaks
  {
    flags: 'i',
    label: 'you-are-now',
    pattern: 'you\\s+are\\s+now\\s+(a|an)\\s+\\w',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'act-as-override',
    pattern: 'act\\s+as\\s+(a|an)\\s+\\w',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'pretend-to-be',
    pattern: '\\bpretend\\s+(you\\s+are|to\\s+be)\\b|\\broleplay\\s+as\\b|\\bsimulate\\s+being\\b',
    type: 'INJECTION',
  },
  {
    flags: 'i',
    label: 'jailbreak-persona',
    pattern: '\\bDAN\\b|developer\\s+mode|jailbreak|do\\s+anything\\s+now',
    type: 'INJECTION',
  },

  // Safety system bypass
  {
    flags: 'i',
    label: 'safety-bypass',
    pattern:
      '\\b(bypass|disable|remove|override)\\s+(your\\s+)?(safety|ethical|content)\\s+(guidelines|filters|restrictions|rules)\\b',
    type: 'INJECTION',
  },

  // Reframing the agent's purpose
  {
    flags: 'i',
    label: 'true-instructions',
    pattern: 'your\\s+(real|true|actual|hidden)\\s+(instructions?|purpose|task|goal)',
    type: 'INJECTION',
  },

  // Low-level token manipulation (no i flag — these are literal token sequences)
  {
    flags: '',
    label: 'token-injection',
    pattern: '<\\|im_(start|end)\\|>|<\\|endoftext\\|>|<\\/s>|<\\|end\\|>',
    type: 'INJECTION',
  },

  // Template engine injection (Jinja / Mustache — no i flag needed)
  {
    flags: '',
    label: 'template-injection',
    pattern: '\\{\\{|\\{%',
    type: 'INJECTION',
  },

  // ── Exfiltration patterns ─────────────────────────────────────────────────
  // Network destinations
  {
    flags: 'i',
    label: 'http-url-in-instruction',
    pattern: 'https?:\\/\\/[^\\s]+',
    type: 'EXFILTRATION',
  },
  {
    flags: 'i',
    label: 'webhook-services',
    pattern:
      '\\b(webhook\\.site|requestbin|hookbin|beeceptor|pipedream\\.net|ngrok\\.io)\\b',
    type: 'EXFILTRATION',
  },
  {
    // AWS / GCP / Azure instance metadata — one hit = IAM key exposure
    flags: '',
    label: 'cloud-metadata-endpoint',
    pattern: '169\\.254\\.169\\.254',
    type: 'EXFILTRATION',
  },

  // Network tools available in the agent workspace shell
  {
    flags: 'i',
    label: 'curl-wget',
    pattern: '\\b(curl|wget)\\s+',
    type: 'EXFILTRATION',
  },
  {
    flags: 'i',
    label: 'network-tools',
    pattern: '\\b(nc|netcat|nmap|nslookup|dig|host)\\s+',
    type: 'EXFILTRATION',
  },
  {
    flags: 'i',
    label: 'ssh-scp-rsync',
    pattern: '\\b(scp|sftp|rsync)\\s+',
    type: 'EXFILTRATION',
  },

  // Shell-level data exfiltration
  {
    flags: 'i',
    label: 'shell-redirect',
    pattern: '>\\s*\\/dev\\/|>\\s*\\|(curl|wget|nc)',
    type: 'EXFILTRATION',
  },
  {
    flags: 'i',
    label: 'send-to-external',
    pattern: '\\b(exfiltrat|send\\s+to\\s+(http|ftp)|transmit\\s+(to|via))\\b',
    type: 'EXFILTRATION',
  },

  // Secret and credential leakage
  {
    flags: 'i',
    label: 'env-secret-leak',
    pattern:
      '\\b(print|echo|output|reveal|leak|expose)\\s+(your\\s+)?(env|api[\\s_-]?key|secret|token|password|credentials?)\\b',
    type: 'EXFILTRATION',
  },

  // System file access (agent workspace is Docker but paths are still meaningful targets)
  {
    flags: '',
    label: 'system-file-access',
    pattern: '\\/etc\\/(passwd|shadow|hosts|sudoers)|\\/proc\\/[a-z]',
    type: 'EXFILTRATION',
  },

  // Encoded payload delivery
  {
    flags: 'm',
    label: 'base64-block',
    pattern: '(?:^|[\\s"`\'])[A-Za-z0-9+/]{60,}={0,2}(?:$|[\\s"`\'])',
    type: 'EXFILTRATION',
  },
];
