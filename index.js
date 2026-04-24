/**
 * DeepToken.fit API - Cloudflare Workers Version
 * Using Hono.js framework (Express-compatible)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { crypto } from 'cloudflare:workers';

// DeepSeek API configuration
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// In-memory token counter (per Worker instance)
// Note: Workers are stateless, this resets on each cold start
// For production, consider using Cloudflare KV or Durable Objects
const tokenStore = {};
const FREE_TIER_TOKENS = 100000;
const STARTER_TIER_TOKENS = 5000000;
const RESET_INTERVAL_MS = 86400000; // 24 hours

// API Keys configuration
const API_KEYS = {
  'free-demo': { tier: 'free', limit: FREE_TIER_TOKENS },
  'starter-demo': { tier: 'starter', limit: STARTER_TIER_TOKENS }
};

// DeepSeek API Key from environment
const DEEPSEEK_API_KEY = DEEPSEEK_API_KEY || '';

function validateApiKey(c) {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!apiKey) {
    return { error: 'Missing API key', status: 401 };
  }
  const keyConfig = API_KEYS[apiKey];
  if (!keyConfig) {
    return { error: 'Invalid API key', status: 401 };
  }
  return { apiKey, keyConfig, error: null };
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function checkRateLimit(apiKey, tokens) {
  if (!tokenStore[apiKey]) {
    tokenStore[apiKey] = { used: 0, resetTime: Date.now() + RESET_INTERVAL_MS };
  }
  const entry = tokenStore[apiKey];
  if (Date.now() > entry.resetTime) {
    entry.used = 0;
    entry.resetTime = Date.now() + RESET_INTERVAL_MS;
  }
  if (entry.used + tokens > entry.limit) {
    return false;
  }
  entry.used += tokens;
  return true;
}

const app = new Hono();

// CORS
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Health check
app.get('/v1/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'DeepToken.fit API',
    timestamp: new Date().toISOString()
  });
});

// List models
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'deepseek-chat',
        object: 'model',
        created: 1677610602,
        owned_by: 'deepseek'
      },
      {
        id: 'deepseek-reasoner',
        object: 'model',
        created: 1677610602,
        owned_by: 'deepseek'
      }
    ]
  });
});

// Chat completions
app.post('/v1/chat/completions', async (c) => {
  const validation = validateApiKey(c);
  if (validation.error) {
    return c.json({ error: validation.error }, validation.status);
  }
  const { apiKey, keyConfig } = validation;

  try {
    const body = await c.req.json();
    const { messages, model = 'deepseek-chat', temperature = 0.7, max_tokens = 2048 } = body;

    // Estimate input tokens
    const inputText = messages.map(m => m.content || '').join('');
    const inputTokens = estimateTokens(inputText);

    // Rate limit check
    if (!checkRateLimit(apiKey, inputTokens)) {
      return c.json({ error: 'Rate limit exceeded. Please upgrade your plan.' }, 429);
    }

    // Check DeepSeek API key
    if (!DEEPSEEK_API_KEY) {
      return c.json({ error: 'DeepSeek API not configured on server.' }, 500);
    }

    // Forward to DeepSeek
    const deepseekModel = model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: deepseekModel,
        messages,
        temperature,
        max_tokens
      })
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('DeepSeek API Error:', responseData);
      return c.json({
        error: 'DeepSeek API error',
        message: responseData.error?.message || response.statusText
      }, response.status);
    }

    // Estimate output tokens
    const outputText = responseData.choices?.[0]?.message?.content || '';
    const outputTokens = estimateTokens(outputText);

    return c.json({
      id: `deeptoken-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: responseData.model,
      choices: responseData.choices,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    });

  } catch (error) {
    console.error('Proxy Error:', error);
    return c.json({
      error: 'Internal server error',
      message: error.message
    }, 500);
  }
});

// Usage check
app.get('/v1/usage', (c) => {
  const validation = validateApiKey(c);
  if (validation.error) {
    return c.json({ error: validation.error }, validation.status);
  }
  const { apiKey, keyConfig } = validation;

  const entry = tokenStore[apiKey] || { used: 0, resetTime: Date.now() + RESET_INTERVAL_MS };

  return c.json({
    used: entry.used,
    limit: keyConfig.limit,
    remaining: Math.max(0, keyConfig.limit - entry.used),
    resetTime: new Date(entry.resetTime).toISOString()
  });
});

// 404 catch-all
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;
