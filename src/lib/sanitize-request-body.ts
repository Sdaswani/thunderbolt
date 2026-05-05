/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// 3.1 Pipe-to-shell: replaces only the shell name after a pipe, preserving the URL.
const PIPE_TO_SHELL =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?s?bin\/)?)(sh|bash|zsh|ash|dash|ksh|fish|tcsh|csh)\b/gi

// 3.2 Pipe-to-interpreter: install-script idiom (CRS 932120).
const PIPE_TO_INTERPRETER =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?bin\/)?)(python(?:[23](?:\.\d+)?)?|perl|ruby|node|php)\b/gi

// 3.3 Process substitution into shell: `<(curl ...)` / `<(wget ...)`.
const PROCESS_SUBSTITUTION_FETCH = /<\(\s*(?:curl|wget)\b[^)]*\)/gi

// 3.5 `eval "$(curl ...)"` and friends.
const EVAL_NETWORK_FETCH = /eval\s+"?\$\(\s*(?:curl|wget)\b[^)]*\)"?/gi

// 3.6 `bash -c "$(curl ...)"` / `sh -c "$(curl ...)"`.
const SHELL_DASH_C_NETWORK_FETCH = /(\b(?:sh|bash|zsh)\s+-c\s+)"?\$\(\s*(?:curl|wget)\b[^)]*\)"?/gi

// 3.7 Reverse shell via `>& /dev/tcp/HOST/PORT` (with optional `bash -i`/`sh -i` prefix).
const REVERSE_SHELL_DEV_TCP = /(?:\b(?:sh|bash)\s+-i\s+)?>\s*&\s*\/dev\/tcp\/[^\s]+/gi

// 3.8 Reverse shell via `nc -e /bin/sh` / `ncat -e /bin/bash`.
// Note: spec section 3.8 regex `\bn(?:cat)?\b...` doesn't match `nc` (no word
// boundary between `n` and `c`); matching the spec's intent (the table lists
// both `nc` and `ncat`) requires `\bnc(?:at)?\b`.
const REVERSE_SHELL_NC = /\bnc(?:at)?\b[^|;\n]{0,120}-e\s+\/(?:usr\/)?bin\/(?:sh|bash)\b/gi

// 3.9 Language one-liner reverse shells (each requires both the language flag
// and specific networking keywords, so prose mentioning the language won't match).
const REVERSE_SHELL_PYTHON = /python[23]?(?:\.\d+)?\s+-c\s+['"][^'"]*\bsocket\b[^'"]*\bsubprocess\b[^'"]*['"]/gi
const REVERSE_SHELL_PERL = /perl\s+-e\s+['"][^'"]*\buse\s+Socket\b[^'"]*['"]/gi
const REVERSE_SHELL_PHP = /php\s+-r\s+['"][^'"]*\bfsockopen\b[^'"]*['"]/gi
const REVERSE_SHELL_RUBY = /ruby\s+-rsocket\s+-e\s+['"][^'"]*['"]/gi

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
    .replace(SHELL_DASH_C_NETWORK_FETCH, '$1"{{redacted-network-exec}}"')
    .replace(EVAL_NETWORK_FETCH, 'eval {{redacted-network-eval}}')
    .replace(PROCESS_SUBSTITUTION_FETCH, '<({{redacted-network-fetch}})')
    .replace(REVERSE_SHELL_DEV_TCP, '{{redacted-reverse-shell}}')
    .replace(REVERSE_SHELL_NC, '{{redacted-reverse-shell}}')
    .replace(REVERSE_SHELL_PYTHON, '{{redacted-python-reverse-shell}}')
    .replace(REVERSE_SHELL_PERL, '{{redacted-perl-reverse-shell}}')
    .replace(REVERSE_SHELL_PHP, '{{redacted-php-reverse-shell}}')
    .replace(REVERSE_SHELL_RUBY, '{{redacted-ruby-reverse-shell}}')
    .replace(PIPE_TO_SHELL, '$1{{redacted-shell}}')
    .replace(PIPE_TO_INTERPRETER, '$1{{redacted-interpreter}}')
