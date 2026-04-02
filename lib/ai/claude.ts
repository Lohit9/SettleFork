import Anthropic from '@anthropic-ai/sdk'

// CRITICAL: This file is server-side only. NEVER import in client components.
// ANTHROPIC_API_KEY must never appear in client bundles.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4096
): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }
  return textBlock.text
}

/**
 * Streaming variant — required by the Anthropic SDK when max_tokens is large enough
 * that the estimated generation time could exceed 10 minutes (non-streaming threshold).
 * Use this for long-form generation like compartmentalized SQL packages.
 */
export async function callClaudeStreaming(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 32000
): Promise<string> {
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })

  const message = await stream.finalMessage()

  const textBlock = message.content.find((block) => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }
  return textBlock.text
}
