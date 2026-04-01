const { buildEmbeddingConfig } = require('./embeddingService');
const retrievalTestChatPrompts = require('../config/retrievalTestChatPrompts.json');

const GEN_MAX_CHUNKS = 5;
const MAX_CHUNK_CHARS = 2000;

const DEFAULT_SYSTEM_PROMPT =
  '你是知识库助手。只根据用户提供的片段作答，不要使用片段外的推测；回答简洁准确。';

const DEFAULT_USER_PREAMBLE_LINES = [
  '用户问题：{{query}}',
  '',
  '请仅根据下列知识片段回答问题；若片段不足以回答，请明确说明。',
  ''
];

const DEFAULT_CHUNK_HEADER_TEMPLATE =
  '[片段{{index}}] 文件：{{fileName}} | 标题路径：{{headingPath}}';

function renderPromptTemplate(template, vars) {
  const s = String(template ?? '');
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v =
      vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    return String(v);
  });
}

function getRetrievalTestGeneratePromptConfig() {
  return retrievalTestChatPrompts?.retrievalTestGenerate || {};
}

function buildSystemPromptFromConfig() {
  const cfg = getRetrievalTestGeneratePromptConfig();
  const system = cfg.system;
  if (Array.isArray(system) && system.some((line) => String(line || '').trim())) {
    return system.join('\n');
  }
  if (typeof system === 'string' && system.trim()) {
    return renderPromptTemplate(system.trim(), {});
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function chatTemperatureFromConfig() {
  const cfg = getRetrievalTestGeneratePromptConfig();
  const t = Number(cfg.temperature);
  return Number.isFinite(t) ? t : 0.2;
}

function buildRetrievalTestChatRuntimeConfig() {
  const emb = buildEmbeddingConfig();
  const model = String(process.env.KB_RETRIEVAL_TEST_CHAT_MODEL || '').trim();
  const timeoutMs =
    Number(process.env.KB_RETRIEVAL_TEST_CHAT_TIMEOUT_MS || emb.timeoutMs || 30000) || 30000;
  return {
    baseUrl: emb.baseUrl,
    apiKey: emb.apiKey,
    model,
    timeoutMs
  };
}

/**
 * @returns {{ ok: true, config: object } | { ok: false, messageKey: string }}
 */
function validateForGenerate() {
  const c = buildRetrievalTestChatRuntimeConfig();
  if (!c.model) {
    return { ok: false, messageKey: 'kb.retrievalTest.chatModelNotConfigured' };
  }
  if (!c.baseUrl || !c.apiKey) {
    return { ok: false, messageKey: 'kb.retrievalTest.chatEmbeddingNotConfigured' };
  }
  return { ok: true, config: c };
}

function truncateText(s, maxLen) {
  const t = String(s || '');
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

/** OpenAI-compatible `usage` object → stable shape; null if absent or unusable */
function normalizeChatUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const p = usage.prompt_tokens ?? usage.promptTokens;
  const c = usage.completion_tokens ?? usage.completionTokens;
  const t = usage.total_tokens ?? usage.totalTokens;
  const promptTokens = Number(p);
  const completionTokens = Number(c);
  const totalRaw = Number(t);
  const hasPrompt = Number.isFinite(promptTokens);
  const hasCompletion = Number.isFinite(completionTokens);
  const hasTotal = Number.isFinite(totalRaw);
  if (!hasPrompt && !hasCompletion && !hasTotal) return null;
  const pt = hasPrompt ? promptTokens : 0;
  const ct = hasCompletion ? completionTokens : 0;
  const totalTokens = hasTotal ? totalRaw : pt + ct;
  return { promptTokens: pt, completionTokens: ct, totalTokens };
}

function buildUserContent(query, reranked) {
  const cfg = getRetrievalTestGeneratePromptConfig();
  const q = String(query || '').trim();
  let preamble;
  const up = cfg.userPreamble;
  if (Array.isArray(up) && up.length) {
    preamble = renderPromptTemplate(up.join('\n'), { query: q });
  } else if (typeof up === 'string' && up.trim()) {
    preamble = renderPromptTemplate(up.trim(), { query: q });
  } else {
    preamble = renderPromptTemplate(DEFAULT_USER_PREAMBLE_LINES.join('\n'), { query: q });
  }

  const chunkHeaderTpl = String(
    cfg.chunkHeaderTemplate || DEFAULT_CHUNK_HEADER_TEMPLATE
  ).trim() || DEFAULT_CHUNK_HEADER_TEMPLATE;

  const lines = [preamble, ''];
  const top = (reranked || []).slice(0, GEN_MAX_CHUNKS);
  top.forEach((item, i) => {
    const path = Array.isArray(item.headingPath) ? item.headingPath.join(' / ') : '';
    const header = renderPromptTemplate(chunkHeaderTpl, {
      index: String(i + 1),
      fileName: item.fileName || '-',
      headingPath: path || '-'
    });
    lines.push(header);
    lines.push(truncateText(item.content || '', MAX_CHUNK_CHARS));
    lines.push('');
  });
  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * @param {{ query: string, reranked: array, config: { baseUrl: string, apiKey: string, model: string, timeoutMs: number } }} args
 */
async function generateFromReranked({ query, reranked, config }) {
  const list = Array.isArray(reranked) ? reranked : [];
  if (!list.length) {
    return { ok: false, messageKey: 'kb.retrievalTest.noCandidates' };
  }

  const { baseUrl, apiKey, model, timeoutMs } = config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: chatTemperatureFromConfig(),
        messages: [
          {
            role: 'system',
            content: buildSystemPromptFromConfig()
          },
          {
            role: 'user',
            content: buildUserContent(String(query || '').trim(), list)
          }
        ]
      })
    });
    clearTimeout(timer);
    const timingMs = Date.now() - startedAt;

    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        messageKey: 'kb.retrievalTest.chatUpstreamFailed',
        upstreamStatus: response.status,
        detail: truncateText(text, 240)
      };
    }

    const body = await response.json();
    const answer = body?.choices?.[0]?.message?.content;
    if (answer == null || String(answer).trim() === '') {
      return { ok: false, messageKey: 'kb.retrievalTest.chatEmptyAnswer' };
    }

    const usage = normalizeChatUsage(body?.usage);

    return {
      ok: true,
      answer: String(answer).trim(),
      model,
      timingMs,
      ...(usage ? { usage } : {})
    };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      return { ok: false, messageKey: 'kb.retrievalTest.chatTimeout' };
    }
    return {
      ok: false,
      messageKey: 'kb.retrievalTest.chatUpstreamFailed',
      detail: String(e?.message || e || '').slice(0, 240)
    };
  }
}

module.exports = {
  GEN_MAX_CHUNKS,
  MAX_CHUNK_CHARS,
  validateForGenerate,
  generateFromReranked,
  buildUserContent,
  truncateText,
  normalizeChatUsage,
  renderPromptTemplate,
  buildSystemPromptFromConfig,
  chatTemperatureFromConfig
};
