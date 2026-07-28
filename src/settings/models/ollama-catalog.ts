/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { fetch } from '@/lib/fetch'
import { http } from '@/lib/http'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { AvailableModel } from './model-catalog'

/** One row from Ollama `GET /api/tags`. */
export type OllamaTagModel = {
  name: string
  model?: string
  details?: {
    context_length?: number
    family?: string
    parameter_size?: string
  }
  capabilities?: string[]
}

type OllamaTagsResponse = {
  models?: OllamaTagModel[]
}

/**
 * Strips the OpenAI-compat `/v1` suffix so native Ollama routes
 * (`/api/tags`, `/api/show`, `/api/version`) resolve against the same origin
 * the user typed into the Custom URL field.
 */
export const resolveOllamaOrigin = (openAiCompatibleUrl: string): string | null => {
  try {
    const normalized = normalizeOpenAiBaseUrl(openAiCompatibleUrl)
    const origin = normalized.replace(/\/v1$/i, '')
    // Reject empty / scheme-only leftovers from malformed input.
    const parsed = new URL(origin)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? origin : null
  } catch {
    return null
  }
}

/**
 * Heuristic: Custom URLs on the default Ollama port (or an explicit "ollama"
 * host) are worth probing with `/api/tags` before falling back to sparse
 * `/v1/models`. Avoids an extra failed request for every non-Ollama Custom
 * endpoint (llama.cpp, corporate OpenAI-compat gateways, etc.).
 */
export const isLikelyOllamaBaseUrl = (url: string | undefined): boolean => {
  if (!url) {
    return false
  }
  try {
    const parsed = new URL(normalizeOpenAiBaseUrl(url))
    if (parsed.port === '11434') {
      return true
    }
    // Default HTTP port with an ollama-ish hostname (e.g. http://ollama:80/v1).
    return /\bollama\b/i.test(parsed.hostname)
  } catch {
    return false
  }
}

/** Reads `*.context_length` from Ollama `model_info` (architecture-prefixed keys). */
export const contextLengthFromModelInfo = (modelInfo: Record<string, unknown> | undefined): number | null => {
  if (!modelInfo) {
    return null
  }
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return null
}

/** Maps Ollama capability strings + detail fields onto Thunderbolt catalog fields. */
export const mapOllamaTagToAvailableModel = (tag: OllamaTagModel): AvailableModel => {
  const capabilities = new Set((tag.capabilities ?? []).map((capability) => capability.toLowerCase()))
  const contextWindow = tag.details?.context_length
  return {
    id: tag.name,
    name: tag.name,
    supports_tools: capabilities.has('tools'),
    supports_thinking: capabilities.has('thinking'),
    supports_vision: capabilities.has('vision'),
    context_window: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null,
  }
}

/**
 * Fetches the native Ollama model list. Returns `null` when the endpoint is
 * unreachable or not Ollama-shaped so callers can fall back to `/v1/models`.
 */
export const fetchOllamaTagsCatalog = async (origin: string): Promise<AvailableModel[] | null> => {
  try {
    const response = await http.get(`${origin}/api/tags`, { fetch }).json<OllamaTagsResponse>()
    if (!Array.isArray(response.models)) {
      return null
    }
    return response.models.map(mapOllamaTagToAvailableModel).sort((left, right) => left.id.localeCompare(right.id))
  } catch (error) {
    console.error('Ollama /api/tags probe failed:', error)
    return null
  }
}

/**
 * When the Custom URL looks like Ollama, prefer `/api/tags` (tools, thinking,
 * vision, context length). Returns `null` when the probe should be skipped or
 * failed so the OpenAI-compat catalog path can take over.
 */
export const tryFetchOllamaCatalog = async (url: string | undefined): Promise<AvailableModel[] | null> => {
  if (!url || !isLikelyOllamaBaseUrl(url)) {
    return null
  }
  const origin = resolveOllamaOrigin(url)
  if (!origin) {
    return null
  }
  return fetchOllamaTagsCatalog(origin)
}
