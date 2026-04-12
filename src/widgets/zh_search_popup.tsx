import {
  RemHierarchyEditorTree,
  RemViewer,
  renderWidget,
  usePlugin,
  useTracker,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import '../index.css';
import {
  DEFAULT_MAX_RESULTS,
  ensureSearchIndex,
  INCLUDE_BACK_TEXT_SETTING_ID,
  MAX_RESULTS_SETTING_ID,
  readSearchIndex,
  type SearchBuildState,
  searchIndex,
  rebuildSearchIndex,
  type SearchResult,
  SEARCH_STATE_STORAGE_KEY,
} from '../search';

const SEARCH_ICON = (
  <svg
    aria-hidden="true"
    className="rn-zh-search-search-icon"
    viewBox="0 0 20 20"
    width="20"
    height="20"
  >
    <path
      d="M8.5 3a5.5 5.5 0 1 0 3.47 9.77l3.63 3.63a1 1 0 0 0 1.4-1.4l-3.63-3.63A5.5 5.5 0 0 0 8.5 3Zm0 2a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0-7Z"
      fill="currentColor"
    />
  </svg>
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return <>{text}</>;
  }

  const parts = text.split(new RegExp(`(${escapeRegExp(trimmedQuery)})`, 'gi'));

  return (
    <>
      {parts.map((part, index) =>
        part.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase() ? (
          <mark key={`${part}-${index}`} className="rn-zh-search-highlight">
            {part}
          </mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

function formatBuildSummary(state: SearchBuildState): string {
  if (state.isBuilding) {
    return `正在建立索引 ${state.processedCount}/${state.totalCount}`;
  }

  if (state.error) {
    return `索引构建失败：${state.error}`;
  }

  if (!state.entryCount) {
    return '尚未建立索引';
  }

  const builtAtText = state.lastBuiltAt
    ? new Date(state.lastBuiltAt).toLocaleString('zh-CN', { hour12: false })
    : '未知时间';

  const storageLabel =
    state.storageMode === 'session'
      ? '会话缓存'
      : state.storageMode === 'memory'
        ? '内存缓存'
        : '本地缓存';

  return `已索引 ${state.entryCount} 条笔记 · 上次构建 ${builtAtText} · ${storageLabel}`;
}


function ResultMarker({ active }: { active: boolean }) {
  return (
    <span className={`rn-zh-search-result-marker${active ? ' is-active' : ''}`} aria-hidden="true">
      <span className="rn-zh-search-result-marker-core" />
    </span>
  );
}

function SearchPopup() {
  const plugin = usePlugin();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const popupContext = useTracker(
    () => plugin.widget.getWidgetContext<WidgetLocation.Popup>(),
    [plugin],
  );
  const buildState =
    useTracker(
      () => plugin.storage.getSession<SearchBuildState>(SEARCH_STATE_STORAGE_KEY),
      [plugin],
    ) ?? {
      version: 1,
      isBuilding: false,
      isStale: false,
      totalCount: 0,
      processedCount: 0,
      entryCount: 0,
    };
  const index = useTracker(
    () => readSearchIndex(plugin),
    [plugin, buildState.lastBuiltAt, buildState.storageMode, buildState.entryCount],
  );
  const includeBackText =
    useTracker(() => plugin.settings.getSetting<boolean>(INCLUDE_BACK_TEXT_SETTING_ID), [plugin]) ??
    true;
  const maxResults =
    useTracker(() => plugin.settings.getSetting<number>(MAX_RESULTS_SETTING_ID), [plugin]) ??
    DEFAULT_MAX_RESULTS;

  const [query, setQuery] = useState('');
  const [selectedRemId, setSelectedRemId] = useState<string | null>(null);
  const [openingRemId, setOpeningRemId] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);

  useEffect(() => {
    void ensureSearchIndex(plugin, 'popup');
  }, [plugin]);

  useEffect(() => {
    const initialQuery = popupContext?.contextData?.initialQuery;
    setQuery(typeof initialQuery === 'string' ? initialQuery : '');
  }, [popupContext?.contextData?.initialQuery]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [popupContext?.widgetInstanceId]);

  const searchResponse = searchIndex(index, query, includeBackText, maxResults);
  const selectedResult =
    searchResponse.results.find((result) => result.entry.remId === selectedRemId) ??
    searchResponse.results[0];
  const selectedIndex = selectedResult
    ? searchResponse.results.findIndex((result) => result.entry.remId === selectedResult.entry.remId)
    : -1;

  useEffect(() => {
    if (searchResponse.results.length === 0) {
      setSelectedRemId(null);
      return;
    }

    if (!selectedRemId || !searchResponse.results.some((result) => result.entry.remId === selectedRemId)) {
      setSelectedRemId(searchResponse.results[0].entry.remId);
    }
  }, [searchResponse.results, selectedRemId]);

  useEffect(() => {
    if (!selectedResult) {
      return;
    }

    const target = resultRefs.current[selectedResult.entry.remId];
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedResult?.entry.remId]);

  async function openResult(remId: string) {
    setOpeningRemId(remId);

    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem) {
        await plugin.app.toast('未找到对应笔记');
        return;
      }

      await plugin.window.openRem(rem);
      await plugin.widget.closePopup();
    } finally {
      setOpeningRemId(null);
    }
  }

  async function handleRebuild() {
    setIsRebuilding(true);

    try {
      await rebuildSearchIndex(plugin, 'manual', true);
    } finally {
      setIsRebuilding(false);
    }
  }

  function selectNeighbor(direction: 1 | -1) {
    if (searchResponse.results.length === 0) {
      return;
    }

    const baseIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.min(
      searchResponse.results.length - 1,
      Math.max(0, baseIndex + direction),
    );
    setSelectedRemId(searchResponse.results[nextIndex].entry.remId);
  }

  async function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      await plugin.widget.closePopup();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectNeighbor(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectNeighbor(-1);
      return;
    }

    if (event.key === 'Enter' && selectedResult) {
      event.preventDefault();
      await openResult(selectedResult.entry.remId);
    }
  }

  function renderResultCard(result: SearchResult, indexInList: number) {
    const active = selectedResult?.entry.remId === result.entry.remId;

    return (
      <button
        key={result.entry.remId}
        ref={(element) => {
          resultRefs.current[result.entry.remId] = element;
        }}
        className={`rn-zh-search-result-card${active ? ' is-active' : ''}`}
        disabled={openingRemId === result.entry.remId}
        onClick={() => setSelectedRemId(result.entry.remId)}
        onDoubleClick={() => void openResult(result.entry.remId)}
        type="button"
      >
        {indexInList === 0 ? <div className="rn-zh-search-best-match">最佳匹配</div> : null}

        <div className="rn-zh-search-result-grid">
          <ResultMarker active={active} />

          <div className="rn-zh-search-result-main">

            {result.entry.path ? (
              <div className="rn-zh-search-result-path">{result.entry.path}</div>
            ) : null}

            {result.snippet ? (
              <div className="rn-zh-search-result-snippet">
                <HighlightText query={query} text={result.snippet} />
              </div>
            ) : null}
          </div>
        </div>

        {active ? (
          <button
            className="rn-zh-search-open-selected"
            disabled={openingRemId === result.entry.remId}
            onClick={(e) => {
              e.stopPropagation();
              void openResult(result.entry.remId);
            }}
            type="button"
          >
            打开当前项
          </button>
        ) : null}
      </button>
    );
  }


  return (
    <div className="rn-zh-search-shell rn-zh-search-theme">
      <section className="rn-zh-search-results-panel">
        <div className="rn-zh-search-header">
          <div className="rn-zh-search-toolbar">
            <label className="rn-zh-search-commandbar">
              <span className="rn-zh-search-commandbar-icon">{SEARCH_ICON}</span>
              <input
                ref={inputRef}
                className="rn-zh-search-commandbar-input"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => void handleInputKeyDown(event)}
                placeholder="搜索中文笔记内容"
                value={query}
              />
            </label>

            <div className="rn-zh-search-toolbar-actions">
              {query ? (
                <button
                  className="rn-zh-search-toolbar-button"
                  onClick={() => setQuery('')}
                  type="button"
                >
                  清除
                </button>
              ) : null}

              <button
                className="rn-zh-search-toolbar-button"
                disabled={buildState.isBuilding || isRebuilding}
                onClick={() => void handleRebuild()}
                type="button"
              >
                {buildState.isBuilding || isRebuilding ? '重建中…' : '重建索引'}
              </button>
            </div>
          </div>

          <div className="rn-zh-search-meta-row">
            <span className="rn-zh-search-meta-pill">{formatBuildSummary(buildState)}</span>
          </div>
        </div>

        <div className="rn-zh-search-panel-header">
          <div>
            <div className="rn-zh-search-panel-eyebrow">匹配结果</div>
            <div className="rn-zh-search-panel-title">
              {query.trim()
                ? searchResponse.results.length < searchResponse.totalMatches
                  ? `找到 ${searchResponse.totalMatches} 条匹配，显示前 ${searchResponse.results.length} 条`
                  : `找到 ${searchResponse.totalMatches} 条匹配`
                : '输入关键词开始检索'}
            </div>
          </div>
        </div>

        <div className="rn-zh-search-results-scroll">
          {!query.trim() ? (
            <div className="rn-zh-search-empty-state">
              <p className="rn-zh-search-empty-title">输入中文关键词开始搜索</p>
              <p className="rn-zh-search-empty-copy">
                左侧展示匹配项，右侧展示当前选中项的完整预览。
              </p>
            </div>
          ) : buildState.isBuilding && !index?.entryCount ? (
            <div className="rn-zh-search-empty-state">
              <p className="rn-zh-search-empty-title">正在建立首个中文索引</p>
              <p className="rn-zh-search-empty-copy">
                构建完成后会自动显示结果。当前进度：{buildState.processedCount}/
                {buildState.totalCount}
              </p>
            </div>
          ) : searchResponse.totalMatches === 0 ? (
            <div className="rn-zh-search-empty-state">
              <p className="rn-zh-search-empty-title">没有找到匹配结果</p>
              <p className="rn-zh-search-empty-copy">
                可以尝试更短的关键词，或者先点击"重建索引"同步最新笔记内容。
              </p>
            </div>
          ) : (
            <div className="rn-zh-search-result-list">
              {searchResponse.results.map((result, indexInList) =>
                renderResultCard(result, indexInList),
              )}
            </div>
          )}
        </div>
      </section>

      <aside className="rn-zh-search-preview-panel">
        {selectedResult ? (
          <div className="rn-zh-search-preview-surface">
            <RemViewer
              remId={selectedResult.entry.remId}
              width="100%"
            />
            <div className="rn-zh-search-preview-viewport" ref={previewViewportRef}>
              <RemHierarchyEditorTree
                {...({
                  constraintRef: previewViewportRef,
                  remId: selectedResult.entry.remId,
                  width: '100%',
                  maxWidth: '100%',
                } as any)}
                key={selectedResult.entry.remId}
              />
            </div>
          </div>
        ) : (
          <div className="rn-zh-search-empty-state rn-zh-search-empty-state-preview">
            <p className="rn-zh-search-empty-title">没有可预览的结果</p>
            <p className="rn-zh-search-empty-copy">
              当左侧出现匹配项后，右侧会展示当前选中笔记的预览内容。
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

renderWidget(SearchPopup);
