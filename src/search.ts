import { type PluginRem, type RNPlugin } from '@remnote/plugin-sdk';

export const SEARCH_POPUP_WIDGET = 'zh_search_popup';
export const SEARCH_TOP_BAR_WIDGET = 'zh_search_top_bar';
export const OPEN_SEARCH_COMMAND_ID = 'open-zh-search';
export const REBUILD_INDEX_COMMAND_ID = 'rebuild-zh-search-index';
export const SEARCH_INDEX_STORAGE_KEY = 'zh-search.index.v1';
export const SEARCH_INDEX_SESSION_KEY = 'zh-search.index.session.v1';
export const SEARCH_STATE_STORAGE_KEY = 'zh-search.state.v1';
export const MAX_RESULTS_SETTING_ID = 'max-results';
export const INCLUDE_BACK_TEXT_SETTING_ID = 'include-back-text';
export const REBUILD_ON_ACTIVATE_SETTING_ID = 'rebuild-on-activate';
export const REM_CHANGE_LISTENER_KEY = 'zh-search.global-rem-changed';
export const DEFAULT_MAX_RESULTS = 30;

const INDEX_VERSION = 1;
const BUILD_BATCH_SIZE = 40;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const WHITESPACE_RE = /\s+/g;
const PREVIEW_LENGTH = 140;
const PATH_SEPARATOR = ' / ';
const UNTITLED_REM_LABEL = 'Untitled Rem';
let inMemoryIndexCache: SearchIndexStore | undefined;

export type SearchBuildReason = 'startup' | 'manual' | 'popup';
export type SearchMatchField = 'text' | 'backText';
export type SearchMatchMode = 'exact' | 'compact';

export interface SearchIndexEntry {
  remId: string;
  title: string;
  path: string;
  normalizedText: string;
  normalizedBackText: string;
  updatedAt: number;
}

export interface SearchIndexStore {
  version: number;
  builtAt: string;
  entryCount: number;
  entries: SearchIndexEntry[];
}

export interface SearchBuildState {
  version: number;
  isBuilding: boolean;
  isStale: boolean;
  storageMode?: 'local' | 'session' | 'memory';
  fallbackRichTextCount?: number;
  warning?: string;
  reason?: SearchBuildReason;
  startedAt?: string;
  lastBuiltAt?: string;
  totalCount: number;
  processedCount: number;
  entryCount: number;
  error?: string;
}

export interface SearchResult {
  entry: SearchIndexEntry;
  matchedField: SearchMatchField;
  matchedMode: SearchMatchMode;
  matchIndex: number;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  totalMatches: number;
}

interface BuildRemSnapshot {
  remId: string;
  parentId: string | null;
  text: string;
  backText: string;
  title: string;
  updatedAt: number;
}

interface RichTextReadResult {
  text: string;
  usedFallback: boolean;
}

function createDefaultBuildState(): SearchBuildState {
  return {
    version: INDEX_VERSION,
    isBuilding: false,
    isStale: false,
    totalCount: 0,
    processedCount: 0,
    entryCount: 0,
  };
}

function mergeBuildState(
  base: SearchBuildState | undefined,
  patch: Partial<SearchBuildState>,
): SearchBuildState {
  return {
    ...createDefaultBuildState(),
    ...base,
    ...patch,
    version: INDEX_VERSION,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(ZERO_WIDTH_RE, '').replace(WHITESPACE_RE, ' ').trim();
}

export function normalizeForSearch(value: string): string {
  return normalizeWhitespace(value.normalize('NFKC').toLocaleLowerCase());
}

export function compactForSearch(value: string): string {
  return normalizeForSearch(value).replace(WHITESPACE_RE, '');
}

function truncateText(value: string, maxLength = PREVIEW_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function bestTitle(text: string, backText: string): string {
  return truncateText(normalizeWhitespace(text || backText || UNTITLED_REM_LABEL), 80);
}

function extractSnippet(source: string, query: string): string {
  const normalizedSource = normalizeWhitespace(source);
  if (!normalizedSource) {
    return '';
  }

  const fallback = truncateText(normalizedSource);
  const loweredSource = normalizedSource.toLocaleLowerCase();
  const loweredQuery = query.trim().toLocaleLowerCase();

  if (!loweredQuery) {
    return fallback;
  }

  const rawMatchIndex = loweredSource.indexOf(loweredQuery);
  if (rawMatchIndex < 0) {
    return fallback;
  }

  const sliceStart = Math.max(0, rawMatchIndex - 28);
  const sliceEnd = Math.min(normalizedSource.length, rawMatchIndex + loweredQuery.length + 56);
  const prefix = sliceStart > 0 ? '…' : '';
  const suffix = sliceEnd < normalizedSource.length ? '…' : '';

  return `${prefix}${normalizedSource.slice(sliceStart, sliceEnd).trim()}${suffix}`;
}

function stringifyError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message || error.name;
  }

  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; name?: unknown; code?: unknown };
    const parts = [candidate.name, candidate.code, candidate.message]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .map((value) => String(value).trim());

    if (parts.length > 0) {
      return parts.join(': ');
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return 'Unknown error';
}

function extractTextFromUnknownRichText(value: unknown, seen = new Set<unknown>()): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (seen.has(value)) {
    return '';
  }

  if (Array.isArray(value)) {
    seen.add(value);
    return value
      .map((item) => extractTextFromUnknownRichText(item, seen))
      .filter(Boolean)
      .join(' ');
  }

  if (typeof value === 'object') {
    seen.add(value);
    const candidate = value as Record<string, unknown>;
    const parts = [
      typeof candidate.text === 'string' ? candidate.text : '',
      extractTextFromUnknownRichText(candidate.textOfDeletedRem, seen),
      extractTextFromUnknownRichText(candidate.highlighterSerialization, seen),
      extractTextFromUnknownRichText(candidate.value, seen),
      extractTextFromUnknownRichText(candidate.content, seen),
      extractTextFromUnknownRichText(candidate.children, seen),
    ].filter(Boolean);

    return parts.join(' ');
  }

  return '';
}

async function richTextToString(plugin: RNPlugin, richText?: unknown): Promise<RichTextReadResult> {
  if (!richText) {
    return { text: '', usedFallback: false };
  }

  if (typeof richText === 'string') {
    return { text: normalizeWhitespace(richText), usedFallback: false };
  }

  try {
    return {
      text: normalizeWhitespace(
        await plugin.richText.toString(richText as NonNullable<PluginRem['text']>),
      ),
      usedFallback: false,
    };
  } catch {
    return {
      text: normalizeWhitespace(extractTextFromUnknownRichText(richText)),
      usedFallback: true,
    };
  }
}

async function updateBuildState(
  plugin: RNPlugin,
  patch: Partial<SearchBuildState>,
): Promise<SearchBuildState> {
  const current = await plugin.storage.getSession<SearchBuildState>(SEARCH_STATE_STORAGE_KEY);
  const next = mergeBuildState(current, patch);
  await plugin.storage.setSession(SEARCH_STATE_STORAGE_KEY, next);
  return next;
}

export async function getBuildState(plugin: RNPlugin): Promise<SearchBuildState> {
  const stored = await plugin.storage.getSession<SearchBuildState>(SEARCH_STATE_STORAGE_KEY);
  return mergeBuildState(stored, {});
}

export async function readSearchIndex(plugin: RNPlugin): Promise<SearchIndexStore | undefined> {
  const localStored = await plugin.storage.getLocal<SearchIndexStore>(SEARCH_INDEX_STORAGE_KEY);
  if (localStored && localStored.version === INDEX_VERSION && Array.isArray(localStored.entries)) {
    return localStored;
  }

  if (inMemoryIndexCache?.version === INDEX_VERSION && Array.isArray(inMemoryIndexCache.entries)) {
    return inMemoryIndexCache;
  }

  const sessionStored = await plugin.storage.getSession<SearchIndexStore>(SEARCH_INDEX_SESSION_KEY);
  if (
    sessionStored &&
    sessionStored.version === INDEX_VERSION &&
    Array.isArray(sessionStored.entries)
  ) {
    return sessionStored;
  }

  return undefined;
}

async function writeSearchIndex(
  plugin: RNPlugin,
  index: SearchIndexStore,
): Promise<'local' | 'session' | 'memory'> {
  try {
    await plugin.storage.setLocal(SEARCH_INDEX_STORAGE_KEY, index);
    inMemoryIndexCache = index;
    return 'local';
  } catch (localError) {
    try {
      await plugin.storage.setSession(SEARCH_INDEX_SESSION_KEY, index);
      inMemoryIndexCache = index;
      return 'session';
    } catch (sessionError) {
      inMemoryIndexCache = index;
      throw new Error(
        `local cache failed (${stringifyError(localError)}); session cache failed (${stringifyError(
          sessionError,
        )})`,
      );
    }
  }
}

async function snapshotRemBatch(
  plugin: RNPlugin,
  rems: PluginRem[],
): Promise<{ snapshots: BuildRemSnapshot[]; fallbackRichTextCount: number }> {
  const snapshots = await Promise.all(
    rems.map(async (rem) => {
      const textResult = await richTextToString(plugin, rem.text);
      const backTextResult = await richTextToString(plugin, rem.backText);
      const text = textResult.text;
      const backText = backTextResult.text;

      return {
        snapshot: {
          remId: rem._id,
          parentId: rem.parent,
          text,
          backText,
          title: bestTitle(text, backText),
          updatedAt: rem.localUpdatedAt || rem.updatedAt || 0,
        },
        usedFallback: textResult.usedFallback || backTextResult.usedFallback,
      };
    }),
  );

  return {
    snapshots: snapshots.map((item) => item.snapshot),
    fallbackRichTextCount: snapshots.filter((item) => item.usedFallback).length,
  };
}

function buildPathResolver(entries: Map<string, BuildRemSnapshot>) {
  const pathCache = new Map<string, string>();

  const resolvePath = (remId: string, seen = new Set<string>()): string => {
    if (pathCache.has(remId)) {
      return pathCache.get(remId) ?? '';
    }

    const current = entries.get(remId);
    if (!current?.parentId) {
      pathCache.set(remId, '');
      return '';
    }

    if (seen.has(remId)) {
      return '';
    }

    const parent = entries.get(current.parentId);
    if (!parent) {
      pathCache.set(remId, '');
      return '';
    }

    const nextSeen = new Set(seen);
    nextSeen.add(remId);

    const parentPath = resolvePath(parent.remId, nextSeen);
    const segments = [parentPath, parent.title].filter(Boolean);
    const resolved = segments.join(PATH_SEPARATOR);
    pathCache.set(remId, resolved);
    return resolved;
  };

  return resolvePath;
}

async function buildSearchIndexStore(
  plugin: RNPlugin,
  reason: SearchBuildReason,
): Promise<SearchIndexStore> {
  const rems = await plugin.rem.getAll();
  const startedAt = new Date().toISOString();

  await updateBuildState(plugin, {
    isBuilding: true,
    isStale: false,
    reason,
    startedAt,
    totalCount: rems.length,
    processedCount: 0,
    entryCount: 0,
    error: undefined,
  });

  const snapshots: BuildRemSnapshot[] = [];
  let fallbackRichTextCount = 0;

  for (let startIndex = 0; startIndex < rems.length; startIndex += BUILD_BATCH_SIZE) {
    const batch = rems.slice(startIndex, startIndex + BUILD_BATCH_SIZE);
    const batchResult = await snapshotRemBatch(plugin, batch);
    snapshots.push(...batchResult.snapshots);
    fallbackRichTextCount += batchResult.fallbackRichTextCount;

    await updateBuildState(plugin, {
      isBuilding: true,
      fallbackRichTextCount,
      processedCount: Math.min(startIndex + BUILD_BATCH_SIZE, rems.length),
      totalCount: rems.length,
      reason,
      startedAt,
    });
  }

  const snapshotMap = new Map(snapshots.map((snapshot) => [snapshot.remId, snapshot]));
  const resolvePath = buildPathResolver(snapshotMap);
  const builtAt = new Date().toISOString();

  const entries = snapshots
    .filter((snapshot) => snapshot.text || snapshot.backText)
    .map<SearchIndexEntry>((snapshot) => ({
      remId: snapshot.remId,
      title: snapshot.title,
      path: resolvePath(snapshot.remId),
      normalizedText: normalizeForSearch(snapshot.text),
      normalizedBackText: normalizeForSearch(snapshot.backText),
      updatedAt: snapshot.updatedAt,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return {
    version: INDEX_VERSION,
    builtAt,
    entryCount: entries.length,
    entries,
  };
}

export async function syncSearchState(plugin: RNPlugin): Promise<SearchBuildState> {
  const index = await readSearchIndex(plugin);
  const storageMode = (await plugin.storage.getLocal<SearchIndexStore>(SEARCH_INDEX_STORAGE_KEY))
    ? 'local'
    : (await plugin.storage.getSession<SearchIndexStore>(SEARCH_INDEX_SESSION_KEY))
      ? 'session'
      : index
        ? 'memory'
        : undefined;
  return updateBuildState(plugin, {
    isBuilding: false,
    storageMode,
    fallbackRichTextCount: undefined,
    warning: undefined,
    lastBuiltAt: index?.builtAt,
    totalCount: index?.entryCount ?? 0,
    processedCount: index?.entryCount ?? 0,
    entryCount: index?.entryCount ?? 0,
    error: undefined,
  });
}

export async function markSearchIndexStale(plugin: RNPlugin): Promise<void> {
  const current = await getBuildState(plugin);

  if (current.isBuilding) {
    return;
  }

  await updateBuildState(plugin, {
    isStale: current.entryCount > 0,
  });
}

export async function rebuildSearchIndex(
  plugin: RNPlugin,
  reason: SearchBuildReason,
  notify = false,
): Promise<SearchIndexStore | undefined> {
  const currentState = await getBuildState(plugin);
  if (currentState.isBuilding) {
    if (notify) {
      await plugin.app.toast('中文搜索索引正在构建中，请稍候');
    }
    return readSearchIndex(plugin);
  }

  try {
    if (notify) {
      await plugin.app.toast('开始重建中文搜索索引');
    }

    const index = await buildSearchIndexStore(plugin, reason);
    let storageMode: 'local' | 'session' | 'memory' = 'memory';
    const currentProgress = await getBuildState(plugin);

    try {
      storageMode = await writeSearchIndex(plugin, index);
    } catch (storageError) {
      storageMode = 'memory';
      inMemoryIndexCache = index;
      await plugin.app.toast(`缓存降级到内存：${stringifyError(storageError)}`);
    }

    await updateBuildState(plugin, {
      isBuilding: false,
      isStale: false,
      storageMode,
      fallbackRichTextCount: currentProgress.fallbackRichTextCount,
      warning:
        currentProgress.fallbackRichTextCount && currentProgress.fallbackRichTextCount > 0
          ? `有 ${currentProgress.fallbackRichTextCount} 条笔记的富文本格式异常，已使用兼容模式读取。`
          : undefined,
      reason,
      startedAt: undefined,
      lastBuiltAt: index.builtAt,
      totalCount: index.entryCount,
      processedCount: index.entryCount,
      entryCount: index.entryCount,
      error: undefined,
    });

    if (notify) {
      const storageLabel =
        storageMode === 'local' ? '本地缓存' : storageMode === 'session' ? '会话缓存' : '内存缓存';
      await plugin.app.toast(`中文搜索索引已更新，共 ${index.entryCount} 条笔记（${storageLabel}）`);
      if (currentProgress.fallbackRichTextCount && currentProgress.fallbackRichTextCount > 0) {
        await plugin.app.toast(
          `其中 ${currentProgress.fallbackRichTextCount} 条笔记使用了兼容模式读取富文本`,
        );
      }
    }

    return index;
  } catch (error) {
    const message = stringifyError(error);

    await updateBuildState(plugin, {
      isBuilding: false,
      error: message,
      warning: undefined,
      startedAt: undefined,
    });

    if (notify) {
      await plugin.app.toast(`中文搜索索引重建失败：${message}`);
    }

    return undefined;
  }
}

export async function ensureSearchIndex(
  plugin: RNPlugin,
  reason: SearchBuildReason,
): Promise<SearchIndexStore | undefined> {
  const existing = await readSearchIndex(plugin);
  if (existing) {
    await syncSearchState(plugin);
    return existing;
  }

  return rebuildSearchIndex(plugin, reason);
}

export async function initializeSearchPlugin(plugin: RNPlugin): Promise<void> {
  await syncSearchState(plugin);

  const rebuildOnActivate =
    (await plugin.settings.getSetting<boolean>(REBUILD_ON_ACTIVATE_SETTING_ID)) ?? false;

  if (rebuildOnActivate) {
    await rebuildSearchIndex(plugin, 'startup');
    return;
  }

  const existing = await readSearchIndex(plugin);
  if (!existing) {
    await rebuildSearchIndex(plugin, 'startup');
  }
}

export async function openSearchPopup(plugin: RNPlugin, initialQuery = ''): Promise<void> {
  await plugin.widget.openPopup(SEARCH_POPUP_WIDGET, { initialQuery });
}

function buildSearchMatch(
  entry: SearchIndexEntry,
  normalizedQuery: string,
  compactQuery: string,
  includeBackText: boolean,
): Omit<SearchResult, 'entry' | 'snippet'> | undefined {
  const matches: Array<{
    matchedField: SearchMatchField;
    matchedMode: SearchMatchMode;
    matchIndex: number;
  }> = [];

  const textIndex = entry.normalizedText.indexOf(normalizedQuery);
  if (textIndex >= 0) {
    matches.push({ matchedField: 'text', matchedMode: 'exact', matchIndex: textIndex });
  }

  const compactTextIndex = compactQuery
    ? compactForSearch(entry.normalizedText).indexOf(compactQuery)
    : -1;
  if (compactQuery && compactTextIndex >= 0) {
    matches.push({ matchedField: 'text', matchedMode: 'compact', matchIndex: compactTextIndex });
  }

  if (includeBackText) {
    const backTextIndex = entry.normalizedBackText.indexOf(normalizedQuery);
    if (backTextIndex >= 0) {
      matches.push({ matchedField: 'backText', matchedMode: 'exact', matchIndex: backTextIndex });
    }

    const compactBackTextIndex = compactQuery
      ? compactForSearch(entry.normalizedBackText).indexOf(compactQuery)
      : -1;
    if (compactQuery && compactBackTextIndex >= 0) {
      matches.push({
        matchedField: 'backText',
        matchedMode: 'compact',
        matchIndex: compactBackTextIndex,
      });
    }
  }

  if (matches.length === 0) {
    return undefined;
  }

  matches.sort((left, right) => {
    if (left.matchedMode !== right.matchedMode) {
      return left.matchedMode === 'exact' ? -1 : 1;
    }

    if (left.matchedField !== right.matchedField) {
      return left.matchedField === 'text' ? -1 : 1;
    }

    return left.matchIndex - right.matchIndex;
  });

  return matches[0];
}

export function searchIndex(
  index: SearchIndexStore | undefined,
  rawQuery: string,
  includeBackText: boolean,
  maxResults: number,
): SearchResponse {
  const normalizedQuery = normalizeForSearch(rawQuery);
  const compactQuery = compactForSearch(rawQuery);

  if (!index || !normalizedQuery) {
    return { results: [], totalMatches: 0 };
  }

  const matches: SearchResult[] = [];

  for (const entry of index.entries) {
    const match = buildSearchMatch(entry, normalizedQuery, compactQuery, includeBackText);
    if (!match) {
      continue;
    }

    const sourceText =
      match.matchedField === 'text' ? entry.normalizedText : entry.normalizedBackText;
    matches.push({
      entry,
      matchedField: match.matchedField,
      matchedMode: match.matchedMode,
      matchIndex: match.matchIndex,
      snippet: extractSnippet(sourceText, rawQuery),
    });
  }

  matches.sort((left, right) => {
    if (left.matchedMode !== right.matchedMode) {
      return left.matchedMode === 'exact' ? -1 : 1;
    }

    if (left.matchedField !== right.matchedField) {
      return left.matchedField === 'text' ? -1 : 1;
    }

    if (left.matchIndex !== right.matchIndex) {
      return left.matchIndex - right.matchIndex;
    }

    if (left.entry.updatedAt !== right.entry.updatedAt) {
      return right.entry.updatedAt - left.entry.updatedAt;
    }

    return left.entry.title.localeCompare(right.entry.title, 'zh-Hans-CN');
  });

  return {
    results: matches.slice(0, Math.max(1, maxResults)),
    totalMatches: matches.length,
  };
}
