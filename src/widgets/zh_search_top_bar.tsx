import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useState } from 'react';
import '../index.css';
import { openSearchPopup } from '../search';

function ZhSearchTopBarButton() {
  const plugin = usePlugin();
  const [opening, setOpening] = useState(false);

  async function handleOpen() {
    setOpening(true);

    try {
      await openSearchPopup(plugin);
    } finally {
      setOpening(false);
    }
  }

  return (
    <button
      aria-label="打开中文搜索"
      className="rn-zh-search-topbar-button rn-zh-search-theme"
      disabled={opening}
      onClick={() => void handleOpen()}
      title="打开中文搜索"
      type="button"
    >
      <span className="rn-zh-search-topbar-icon" aria-hidden="true">
        <span className="rn-zh-search-topbar-lens">zh</span>
        <span className="rn-zh-search-topbar-handle" />
      </span>
    </button>
  );
}

renderWidget(ZhSearchTopBarButton);
