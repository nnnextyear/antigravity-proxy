export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingSetting = ThinkingEffort | 'auto';

export interface LiveModelCatalog {
  models: Record<string, any>;
  agentModelSorts?: Array<{ groups?: Array<{ modelIds?: string[] }> }>;
}

export interface ResolvedModel {
  upstreamModel: string;
  pool: 'cli' | 'sandbox';
  info?: Record<string, any>;
}

export class ModelRequestError extends Error {
  readonly statusCode = 400;
}

const THINKING_SUFFIX = /-(?:extra-low|minimal|low|medium|high|xhigh|max|tiered|thinking)$/i;
const INTERNAL_MODEL = /^(?:chat_|tab_)/i;

function cleanModelId(id: string): string {
  return String(id || '').trim().replace(/^models\//i, '').replace(/\[.*?\]/g, '').trim();
}

/** Presets are one selectable model; the request controls its thinking. */
export function normalizePublicModelId(input: string): string {
  let id = cleanModelId(input);
  if (/^(?:gemini-|claude-|gpt-oss-)/i.test(id)) {
    while (THINKING_SUFFIX.test(id)) id = id.replace(THINKING_SUFFIX, '');
  }
  return id;
}

function sourceRank(id: string): number {
  if (id === normalizePublicModelId(id)) return 0;
  if (id.endsWith('-tiered')) return 1;
  // A stable entry point when the catalog has only preset IDs. Effort never
  // chooses a different ID; thinkingConfig carries that setting separately.
  if (id.endsWith('-high') || id.endsWith('-thinking')) return 2;
  if (id.endsWith('-medium')) return 3;
  return 4;
}

export function toPublicModelCatalog(catalog: LiveModelCatalog): Array<{
  id: string;
  info: Record<string, any>;
  sourceId: string;
}> {
  const entries = Object.entries(catalog.models).map(([id, value]) => ({
    sourceId: cleanModelId(id),
    info: value && typeof value === 'object' ? value as Record<string, any> : {}
  }));
  // This is the actual Antigravity agent model picker. Do not confuse the
  // full control-plane catalog (tab completion/search/legacy routes) with it.
  const pickerIds = catalog.agentModelSorts?.flatMap(sort =>
    (sort.groups || []).flatMap(group => group.modelIds || []));
  const visible = pickerIds === undefined
    ? entries.map(entry => entry.sourceId)
    : pickerIds.map(cleanModelId);
  const byId = new Map(entries.map(entry => [entry.sourceId, entry]));
  const publicIds = [...new Set(visible
    .filter(id => {
      const entry = byId.get(id);
      return entry && !INTERNAL_MODEL.test(id) && entry.info.hidden !== true && entry.info.isHidden !== true;
    }).map(normalizePublicModelId))];

  return publicIds.map(id => {
    const candidates = entries.filter(entry => normalizePublicModelId(entry.sourceId) === id
      && entry.info.hidden !== true && entry.info.isHidden !== true);
    candidates.sort((a, b) => sourceRank(a.sourceId) - sourceRank(b.sourceId)
      || a.sourceId.localeCompare(b.sourceId));
    const source = candidates[0];
    const levels = [...new Set(candidates.flatMap(entry => {
      const suffix = entry.sourceId.slice(id.length);
      return suffix === '-extra-low' || suffix === '-minimal' ? ['minimal']
        : /^-(low|medium|high)$/.test(suffix) ? [suffix.slice(1)] : [];
    }))];
    const info = /^gemini-3(?:[.\-]|$)/i.test(id) && levels.length && !source.info.supportedThinkingLevels
      ? { ...source.info, supportedThinkingLevels: levels } : source.info;
    return { id, info, sourceId: source.sourceId };
  });
}

/** Select only an ID present in the current catalog; never alias model families. */
export function resolveDynamicUpstreamModel(input: string, catalog?: LiveModelCatalog): ResolvedModel {
  const id = normalizePublicModelId(input);
  const entry = catalog && toPublicModelCatalog(catalog).find(model => model.id === id);
  if (!id) throw new ModelRequestError('model is required');
  if (catalog && !entry) throw new ModelRequestError(`Model '${id}' is not available in the live Antigravity model picker.`);
  const upstreamModel = entry?.sourceId || cleanModelId(input);
  return {
    upstreamModel,
    pool: /^(?:claude-|gpt-oss-)/i.test(upstreamModel) ? 'sandbox' : 'cli',
    info: entry?.info
  };
}

export function normalizeThinkingEffort(value: unknown): ThinkingSetting | undefined {
  if (typeof value !== 'string') return undefined;
  const level = value.trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(level)
    ? level as ThinkingSetting : undefined;
}

const BUDGETS = { minimal: 4096, low: 8192, medium: 16384, high: 24576, xhigh: 32768, max: 32768 };

export function resolveFrameworkThinking(input: {
  reasoning_effort?: unknown;
  reasoning?: { effort?: unknown };
  output_config?: { effort?: unknown };
  thinking?: { type?: string; budget_tokens?: number };
  thinking_budget?: number;
  thinkingBudget?: number;
}): { effort?: ThinkingSetting; budgetTokens?: number } {
  if (input.thinking?.type === 'disabled') return { effort: 'none' };
  const rawEffort = input.output_config?.effort ?? input.reasoning?.effort ?? input.reasoning_effort;
  if (rawEffort !== undefined) {
    const effort = normalizeThinkingEffort(rawEffort);
    if (!effort) throw new ModelRequestError(`Unsupported thinking effort: ${String(rawEffort)}`);
    return { effort };
  }
  const budgetTokens = input.thinking?.budget_tokens ?? input.thinking_budget ?? input.thinkingBudget;
  if (budgetTokens !== undefined) {
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < -1) {
      throw new ModelRequestError('thinking budget must be -1 or a non-negative integer');
    }
    return { effort: thinkingEffortFromBudget(budgetTokens), budgetTokens };
  }
  return { effort: input.thinking?.type === 'enabled' || input.thinking?.type === 'adaptive' ? 'auto' : undefined };
}

export function thinkingEffortFromBudget(budget: number): ThinkingSetting {
  if (budget === -1) return 'auto';
  if (budget <= 0) return 'none';
  if (budget <= 4096) return 'minimal';
  if (budget <= 8192) return 'low';
  if (budget <= 16384) return 'medium';
  return budget <= 24576 ? 'high' : budget <= 32768 ? 'xhigh' : 'max';
}

/** No framework setting means leave the upstream default alone. */
export function resolveThinkingConfig(
  model: string,
  effort?: ThinkingSetting,
  explicitBudget?: number,
  info?: Record<string, any>,
  maxOutputTokens?: number
): Record<string, unknown> | undefined {
  if (info?.supportsThinking === false || (effort === undefined && explicitBudget === undefined)) return undefined;
  const setting = effort ?? (explicitBudget === undefined ? undefined : thinkingEffortFromBudget(explicitBudget));
  const isGemini3 = /^gemini-3(?:[.\-]|$)/i.test(model);
  const isPro = isGemini3 && /(?:^|-)pro(?:$|-)/i.test(model);

  if (isGemini3) {
    if (setting === 'auto') return undefined;
    // Gemini 3 cannot disable thinking. Use its lowest supported native level.
    const level = setting === 'none' || setting === 'minimal' ? 'minimal'
      : setting === 'xhigh' || setting === 'max' ? 'high' : setting;
    const supported = Array.isArray(info?.supportedThinkingLevels)
      ? info.supportedThinkingLevels.filter((value: string) => ['minimal', 'low', 'medium', 'high'].includes(value))
      : isPro ? ['low', 'high'] : ['minimal', 'low', 'medium', 'high'];
    if (!supported.length) return undefined;
    const levels = ['minimal', 'low', 'medium', 'high'];
    const target = levels.indexOf(level!);
    // Clamp upward when a model omits a level (e.g. 3.8 Flash has low,
    // medium/high but rejects minimal; Pro exposes only low/high).
    const thinkingLevel = levels.slice(target).find(value => supported.includes(value))
      || [...levels].reverse().find(value => supported.includes(value));
    return { thinkingLevel };
  }

  let budget = setting === 'none' ? 0 : setting === 'auto' ? -1
    : explicitBudget ?? (setting ? BUDGETS[setting] : undefined);
  if (budget === undefined) return undefined;
  // Budgets for Gemini 2.5 Flash/Pro and Claude must fit the model's output.
  const nativeMax = /^gemini-2\.5-pro/i.test(model) ? 32768
    : /^gemini-2\.5-flash(?!-lite)/i.test(model) ? 24576 : undefined;
  const max = Number(info?.maxThinkingBudget) || nativeMax;
  if (budget > 0) {
    budget = Math.floor(budget);
    if (max) budget = Math.min(budget, max);
    if (info?.minThinkingBudget) budget = Math.max(budget, Number(info.minThinkingBudget));
    if (/^claude-/i.test(model) && maxOutputTokens) budget = Math.min(budget, Math.max(0, maxOutputTokens - 1));
  }
  // Gemini 2.5 Pro requires thinking, even when a framework asks for none.
  if (budget === 0 && /^gemini-2\.5-pro/i.test(model)) budget = Number(info?.minThinkingBudget) || 128;
  return { thinkingBudget: budget };
}
