/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  contextLengthFromModelInfo,
  isLikelyOllamaBaseUrl,
  mapOllamaTagToAvailableModel,
  resolveOllamaOrigin,
} from './ollama-catalog'

describe('resolveOllamaOrigin', () => {
  it('strips the OpenAI-compat /v1 suffix', () => {
    expect(resolveOllamaOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(resolveOllamaOrigin('http://localhost:11434/v1/')).toBe('http://localhost:11434')
  })

  it('adds /v1 before stripping when the user omitted it', () => {
    expect(resolveOllamaOrigin('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('returns null for malformed URLs', () => {
    expect(resolveOllamaOrigin('not a url')).toBeNull()
  })
})

describe('isLikelyOllamaBaseUrl', () => {
  it('matches the default Ollama port', () => {
    expect(isLikelyOllamaBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLikelyOllamaBaseUrl('http://192.168.1.10:11434')).toBe(true)
  })

  it('matches ollama hostnames on other ports', () => {
    expect(isLikelyOllamaBaseUrl('http://ollama.local/v1')).toBe(true)
  })

  it('rejects unrelated custom endpoints', () => {
    expect(isLikelyOllamaBaseUrl('http://localhost:1234/v1')).toBe(false)
    expect(isLikelyOllamaBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLikelyOllamaBaseUrl(undefined)).toBe(false)
  })
})

describe('mapOllamaTagToAvailableModel', () => {
  it('maps tools + context from a Qwen 2.5 style tag', () => {
    expect(
      mapOllamaTagToAvailableModel({
        name: 'qwen2.5:14b',
        details: { context_length: 32_768, family: 'qwen2' },
        capabilities: ['completion', 'tools'],
      }),
    ).toEqual({
      id: 'qwen2.5:14b',
      name: 'qwen2.5:14b',
      supports_tools: true,
      supports_thinking: false,
      supports_vision: false,
      context_window: 32_768,
    })
  })

  it('maps thinking models', () => {
    const mapped = mapOllamaTagToAvailableModel({
      name: 'qwen3:1.7b',
      details: { context_length: 40_960 },
      capabilities: ['completion', 'tools', 'thinking'],
    })
    expect(mapped.supports_thinking).toBe(true)
    expect(mapped.supports_tools).toBe(true)
    expect(mapped.context_window).toBe(40_960)
  })

  it('maps vision without tools', () => {
    const mapped = mapOllamaTagToAvailableModel({
      name: 'llava:7b',
      capabilities: ['completion', 'vision'],
    })
    expect(mapped.supports_vision).toBe(true)
    expect(mapped.supports_tools).toBe(false)
    expect(mapped.context_window).toBeNull()
  })
})

describe('contextLengthFromModelInfo', () => {
  it('reads architecture-prefixed context_length keys', () => {
    expect(contextLengthFromModelInfo({ 'qwen2.context_length': 32_768, 'general.architecture': 'qwen2' })).toBe(32_768)
    expect(contextLengthFromModelInfo({ 'llama.context_length': 8192 })).toBe(8192)
  })

  it('returns null when absent', () => {
    expect(contextLengthFromModelInfo(undefined)).toBeNull()
    expect(contextLengthFromModelInfo({ 'general.architecture': 'qwen2' })).toBeNull()
  })
})
