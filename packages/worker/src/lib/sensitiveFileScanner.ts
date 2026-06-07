interface SensitiveRule {
  label: string;
  pattern: RegExp;
}

const SENSITIVE_RULES: SensitiveRule[] = [
  { label: '.env files', pattern: /^\.env(\..+)?$/ },
  { label: 'PEM certificates', pattern: /\.(pem|crt|cer|p7b|p7c)$/i },
  { label: 'Private key files', pattern: /\.(key|pk8|p12|pfx|jks|pkcs12|keystore)$/i },
  { label: 'SSH private keys', pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/ },
  { label: 'Google service account JSON', pattern: /(service[_-]?account)\.json$/i },
  { label: 'Credentials file', pattern: /credentials\.(json|ya?ml)$/i },
];

/**
 * Checks a file path against the hardcoded sensitive-file blocklist.
 * Returns a block message if the path is sensitive, null if clean.
 * Checks both the full path and the basename so patterns work regardless
 * of directory depth.
 */
export function checkSensitiveFilePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;

  for (const { label, pattern } of SENSITIVE_RULES) {
    if (pattern.test(basename) || pattern.test(normalized)) {
      return (
        `Write blocked: '${filePath}' matches sensitive file pattern [${label}].\n` +
        'Store secrets in environment variables or a secrets manager, not in source files.'
      );
    }
  }
  return null;
}
