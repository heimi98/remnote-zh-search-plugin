# RemNote 中文搜索增强插件

一个基于 RemNote 官方模板开发的中文搜索增强插件。

## 功能

- 桌面端通过快捷键 `mod+alt+f` 打开中文搜索弹窗
- 移动端通过顶部按钮打开同一个搜索界面
- 首次使用时读取可访问的全部 Rem，自建中文可匹配索引
- 直接输入 `功率` 即可命中包含 `功率` 的笔记，不依赖 RemNote 原生分词结果
- 提供“重建中文搜索索引”命令，笔记更新后可手动同步结果

## 开发

```bash
npm install
npm run dev
```

在 RemNote 的插件开发入口中加载 `http://localhost:8080`。

## 打包

```bash
npm run build
```

构建产物会输出到 `dist/`，并生成 `PluginZip.zip`。
