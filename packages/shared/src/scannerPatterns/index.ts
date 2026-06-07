export interface BuiltinScannerPatternDef {
  flags: string;
  label: string;
  pattern: string;
  type: 'INJECTION' | 'EXFILTRATION' | 'SHELL_COMMAND' | 'CODE_SECURITY';
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
    pattern: '\\b(webhook\\.site|requestbin|hookbin|beeceptor|pipedream\\.net|ngrok\\.io)\\b',
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

  // ── Shell command patterns ─────────────────────────────────────────────────
  // Checked before each bash tool invocation; soft-block returns an error to the
  // agent so it can self-correct. Patterns target destructive or persistence ops
  // that have no legitimate use inside the agent's Docker workspace.

  // Destructive filesystem operations on system paths
  {
    flags: 'i',
    label: 'shell-rm-system-paths',
    pattern: 'rm\\s+-[rRfF]{1,4}\\s+\\/(?:etc|usr|var|bin|lib|boot|root|home|sys|proc)(?:\\s|$)',
    type: 'SHELL_COMMAND',
  },
  // World-writable chmod — security misconfiguration
  {
    flags: 'i',
    label: 'shell-chmod-world-writable',
    pattern: 'chmod\\s+(?:o\\+[rwx]*w[rwx]*|[0-7]*7[0-7][0-7])\\s',
    type: 'SHELL_COMMAND',
  },
  // Crontab modification — persistence mechanism
  {
    flags: 'i',
    label: 'shell-crontab-write',
    pattern: '\\bcrontab\\s+-e\\b|\\(\\s*crontab\\s+-l',
    type: 'SHELL_COMMAND',
  },
  // Systemctl enable/mask — service persistence
  {
    flags: 'i',
    label: 'shell-systemctl-persist',
    pattern: '\\bsystemctl\\s+(?:enable|mask|unmask)\\s',
    type: 'SHELL_COMMAND',
  },
  // Kill PID 1 / init — container or host process termination
  {
    flags: 'i',
    label: 'shell-kill-init',
    pattern: '\\bkill\\s+(?:-9\\s+)?1\\b|\\bpkill\\s+.*\\binit\\b',
    type: 'SHELL_COMMAND',
  },
  // dd to/from raw device — disk overwrite
  {
    flags: 'i',
    label: 'shell-dd-device',
    pattern: '\\bdd\\s+(?:if|of)=/dev/',
    type: 'SHELL_COMMAND',
  },
  // mkfs — format a filesystem
  {
    flags: 'i',
    label: 'shell-mkfs',
    pattern: '\\bmkfs\\b',
    type: 'SHELL_COMMAND',
  },
  // iptables -F / ufw disable — drop all firewall rules
  {
    flags: 'i',
    label: 'shell-iptables-flush',
    pattern: '\\biptables\\s+(?:-F\\b|--flush\\b)|\\bufw\\s+disable\\b',
    type: 'SHELL_COMMAND',
  },
  // Fork bomb — :(){ :|:& };:
  {
    flags: '',
    label: 'shell-fork-bomb',
    pattern: ':\\s*\\(\\s*\\)\\s*\\{',
    type: 'SHELL_COMMAND',
  },
  // xargs rm — mass deletion piped from another command
  {
    flags: 'i',
    label: 'shell-xargs-rm',
    pattern: 'xargs\\s+rm\\s+-[rRfF]',
    type: 'SHELL_COMMAND',
  },

  // ── Code security patterns ─────────────────────────────────────────────────
  // Checked against added lines in the final diff. Findings are advisory —
  // they are passed to the security reviewer agent as structured context.
  // The pre-write security check (preWriteSecurityCheck.ts) is the hard gate;
  // these patterns provide a second pass at the diff level.

  // XSS — React dangerouslySetInnerHTML
  {
    flags: 'i',
    label: 'code-dangerouslysetinnerhtml',
    pattern: 'dangerouslySetInnerHTML',
    type: 'CODE_SECURITY',
  },
  // XSS — direct innerHTML assignment
  {
    flags: 'i',
    label: 'code-innerhtml-assignment',
    pattern: '\\.innerHTML\\s*=(?!\\s*["\']\\s*["\'])',
    type: 'CODE_SECURITY',
  },
  // Command injection — Python subprocess with shell=True
  {
    flags: 'i',
    label: 'code-subprocess-shell-true',
    pattern: 'subprocess\\.(?:call|run|Popen)\\s*\\([^)]*shell\\s*=\\s*True',
    type: 'CODE_SECURITY',
  },
  // TLS bypass — various languages and frameworks
  {
    flags: 'i',
    label: 'code-tls-skip-verify',
    pattern:
      'InsecureSkipVerify\\s*:\\s*true|verify\\s*=\\s*False|InsecureRequestWarning|rejectUnauthorized\\s*:\\s*false',
    type: 'CODE_SECURITY',
  },
  // Dynamic code execution
  {
    flags: 'i',
    label: 'code-eval-exec',
    pattern: '(?:^|[^.\\w])eval\\s*\\(|new\\s+Function\\s*\\(',
    type: 'CODE_SECURITY',
  },
  // Weak cryptographic hash algorithms
  {
    flags: 'i',
    label: 'code-weak-crypto',
    pattern: 'createHash\\s*\\(\\s*[\'"](?:md5|sha1)[\'"]',
    type: 'CODE_SECURITY',
  },
  // CORS wildcard origin — allows any origin
  {
    flags: 'i',
    label: 'code-cors-wildcard',
    pattern: 'origin\\s*:\\s*[\'"`]\\*[\'"`]',
    type: 'CODE_SECURITY',
  },
  // Open redirect — req.query/body/params used directly in redirect
  {
    flags: 'i',
    label: 'code-open-redirect',
    pattern: '\\.redirect\\s*\\([^)]*req\\.(?:query|body|params)\\.',
    type: 'CODE_SECURITY',
  },
  // Hardcoded credential assignment
  {
    flags: 'i',
    label: 'code-hardcoded-credential',
    pattern:
      '(?:secret|password|passwd|api_key|apikey|access_token|auth_token)\\s*[:=]\\s*[\'"`](?!process\\.env)[^\'"`\\n]{8,}[\'"`]',
    type: 'CODE_SECURITY',
  },
  // JWT signed with hardcoded secret string literal
  {
    flags: 'i',
    label: 'code-jwt-hardcoded-secret',
    pattern: 'jwt\\.sign\\s*\\([^)]*,\\s*[\'"][^\'"]{8,}[\'"]',
    type: 'CODE_SECURITY',
  },
];
