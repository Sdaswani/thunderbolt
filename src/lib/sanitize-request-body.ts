/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// 3.1 Pipe-to-shell: replaces only the shell name after a pipe, preserving the URL.
const pipeToShell =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?s?bin\/)?)(sh|bash|zsh|ash|dash|ksh|fish|tcsh|csh)\b/gi

// 3.2 Pipe-to-interpreter: install-script idiom (CRS 932120).
const pipeToInterpreter =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?bin\/)?)(python(?:[23](?:\.\d+)?)?|perl|ruby|node|php)\b/gi

// 3.3 Process substitution into shell: `<(curl ...)` / `<(wget ...)`.
const processSubstitutionFetch = /<\(\s*(?:curl|wget)\b[^)]*\)/gi

// 3.5 `eval "$(curl ...)"` and friends.
const evalNetworkFetch = /eval\s+"?\$\(\s*(?:curl|wget)\b[^)]*\)"?/gi

// 3.6 `bash -c "$(curl ...)"` / `sh -c "$(curl ...)"`.
const shellDashCNetworkFetch = /(\b(?:sh|bash|zsh)\s+-c\s+)"?\$\(\s*(?:curl|wget)\b[^)]*\)"?/gi

// 3.7 Reverse shell via `>& /dev/tcp/HOST/PORT` (with optional `bash -i`/`sh -i` prefix).
const reverseShellDevTcp = /(?:\b(?:sh|bash)\s+-i\s+)?>\s*&\s*\/dev\/tcp\/[^\s]+/gi

// 3.8 Reverse shell via `nc -e /bin/sh` / `ncat -e /bin/bash`.
// Note: spec section 3.8 regex `\bn(?:cat)?\b...` doesn't match `nc` (no word
// boundary between `n` and `c`); matching the spec's intent (the table lists
// both `nc` and `ncat`) requires `\bnc(?:at)?\b`.
const reverseShellNc = /\bnc(?:at)?\b[^|;\n]{0,120}-e\s+\/(?:usr\/)?bin\/(?:sh|bash)\b/gi

// 3.9 Language one-liner reverse shells (each requires both the language flag
// and specific networking keywords, so prose mentioning the language won't match).
const reverseShellPython = /python[23]?(?:\.\d+)?\s+-c\s+['"][^'"]*\bsocket\b[^'"]*\bsubprocess\b[^'"]*['"]/gi
const reverseShellPerl = /perl\s+-e\s+['"][^'"]*\buse\s+Socket\b[^'"]*['"]/gi
const reverseShellPhp = /php\s+-r\s+['"][^'"]*\bfsockopen\b[^'"]*['"]/gi
const reverseShellRuby = /ruby\s+-rsocket\s+-e\s+['"][^'"]*['"]/gi

/**
 * Sanitize a request body string by redacting shell-injection patterns that
 * trip Cloudflare's "Command Injection — Common Attack Commands" WAF rule.
 *
 * Broader patterns (whole-construct redactions) are applied first so they don't
 * get partially overwritten by the narrower pipe-to-shell rule.
 *
 * Spec: `.team/thu-445/sanitizer-spec.md`.
 */
export const sanitizeRequestBody = (body: string): string =>
  body
    .replace(shellDashCNetworkFetch, '$1"{{redacted-network-exec}}"')
    .replace(evalNetworkFetch, 'eval {{redacted-network-eval}}')
    .replace(processSubstitutionFetch, '<({{redacted-network-fetch}})')
    .replace(reverseShellDevTcp, '{{redacted-reverse-shell}}')
    .replace(reverseShellNc, '{{redacted-reverse-shell}}')
    .replace(reverseShellPython, '{{redacted-python-reverse-shell}}')
    .replace(reverseShellPerl, '{{redacted-perl-reverse-shell}}')
    .replace(reverseShellPhp, '{{redacted-php-reverse-shell}}')
    .replace(reverseShellRuby, '{{redacted-ruby-reverse-shell}}')
    .replace(pipeToShell, '$1{{redacted-shell}}')
    .replace(pipeToInterpreter, '$1{{redacted-interpreter}}')
