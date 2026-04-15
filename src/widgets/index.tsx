import {
  AppEvents,
  declareIndexPlugin,
  type ReactRNPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import '../index.css';
import {
  DEFAULT_MAX_RESULTS,
  INCLUDE_BACK_TEXT_SETTING_ID,
  initializeSearchPlugin,
  MAX_RESULTS_SETTING_ID,
  OPEN_SEARCH_COMMAND_ID,
  openSearchPopup,
  REBUILD_INDEX_COMMAND_ID,
  rebuildSearchIndex,
  REBUILD_ON_ACTIVATE_SETTING_ID,
  REM_CHANGE_LISTENER_KEY,
  SEARCH_POPUP_WIDGET,
  SEARCH_TOP_BAR_WIDGET,
  markSearchIndexStale,
} from '../search';

const MOBILE_SIDEBAR_BUTTON_ID = 'open-zh-search-sidebar-button';

async function isMobileOperatingSystem(plugin: ReactRNPlugin): Promise<boolean> {
  try {
    const operatingSystem = await plugin.app.getOperatingSystem();
    return operatingSystem === 'ios' || operatingSystem === 'android';
  } catch {
    return (
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) ||
      (typeof screen !== 'undefined' && screen.width <= 768)
    );
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  const isMobile = await isMobileOperatingSystem(plugin);

  await plugin.settings.registerBooleanSetting({
    id: INCLUDE_BACK_TEXT_SETTING_ID,
    title: '检索背面内容',
    description: '开启后，搜索结果会同时匹配 Rem 的 backText。',
    defaultValue: true,
  });

  await plugin.settings.registerNumberSetting({
    id: MAX_RESULTS_SETTING_ID,
    title: '最大结果数',
    description: '每次搜索最多展示多少条匹配结果。',
    defaultValue: DEFAULT_MAX_RESULTS,
  });

  await plugin.settings.registerBooleanSetting({
    id: REBUILD_ON_ACTIVATE_SETTING_ID,
    title: '启动时重建索引',
    description: '开启后，每次插件激活都会全量重建中文搜索索引。',
    defaultValue: false,
  });

  await plugin.app.registerCommand({
    id: OPEN_SEARCH_COMMAND_ID,
    name: '打开中文搜索',
    description: '打开中文搜索弹窗，检索所有包含关键词的笔记。',
    keywords: '中文 搜索 zh search note remnote',
    keyboardShortcut: 'mod+alt+f',
    action: async () => {
      await openSearchPopup(plugin);
    },
  });

  await plugin.app.registerCommand({
    id: REBUILD_INDEX_COMMAND_ID,
    name: '重建中文搜索索引',
    description: '重新读取全部可访问笔记并刷新中文搜索索引。',
    keywords: '中文 搜索 index rebuild 重建 索引',
    action: async () => {
      await rebuildSearchIndex(plugin, 'manual', true);
    },
  });

  await plugin.app.registerWidget(SEARCH_POPUP_WIDGET, WidgetLocation.Popup, {
    dimensions: { height: 'auto', width: isMobile ? '100%' : 1120 },
  });

  if (isMobile) {
    await plugin.app.registerWidget(SEARCH_TOP_BAR_WIDGET, WidgetLocation.TopBar, {
      dimensions: { height: 'auto', width: 'auto' },
    });

    await plugin.app.registerWidget(SEARCH_TOP_BAR_WIDGET, WidgetLocation.PaneHeader, {
      dimensions: { height: 'auto', width: 'auto' },
    });

    await plugin.app.registerSidebarButton({
      id: MOBILE_SIDEBAR_BUTTON_ID,
      name: '中文搜索',
      action: async () => {
        await openSearchPopup(plugin);
      },
    });
  }

  plugin.event.addListener(AppEvents.GlobalRemChanged, REM_CHANGE_LISTENER_KEY, () => {
    void markSearchIndexStale(plugin);
  });

  void initializeSearchPlugin(plugin);
}

async function onDeactivate(plugin: ReactRNPlugin) {
  plugin.event.removeListener(AppEvents.GlobalRemChanged, REM_CHANGE_LISTENER_KEY);
}

declareIndexPlugin(onActivate, onDeactivate);
