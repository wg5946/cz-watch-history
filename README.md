# 厂长资源 观影历史记录增强版

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-blue?logo=tampermonkey)](https://greasyfork.org/zh-CN/scripts/578674)

为 [厂长资源](https://www.4kcz.com/) 影视站添加**观影历史记录**、**播放进度追踪**、**自动续播**、**最新集数检测**功能的油猴脚本。

## 功能

- **📺 观影历史** — 自动记录观看的影片，封面海报随记录自动抓取，悬浮按钮随时查看
- **⏱️ 播放进度** — 精确追踪进度，支持跨页面、跨窗口续播
- **🔄 自动跳转续播** — 从历史记录新窗口打开时，自动跳转到上次播放位置
- **🆕 最新集数检测** — 后台检测连载动漫/剧集的更新状态，有更新时显示标记
- **🎬 多站点适配** — 覆盖主站及所有播放器域名，iframe 跨域通信

## 安装

在 [Greasy Fork](https://greasyfork.org/zh-CN/scripts/578674) 页面点击「安装此脚本」即可。

需要先安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。

## 支持的站点

| 类型 | 域名 |
|------|------|
| 主站 | `czzyv.com`、`4kcz.com` |
| 播放器 | `plala.py1080p.com`、`py1080p.com`、`159.75.162.215` |

脚本自动适配任意 `/player/*.php` 播放页及主站播放页。

## 使用说明

1. 访问主站在线观看影片，脚本自动开始记录
2. 页面右侧会出现 ⏰ 悬浮按钮，鼠标悬停查看历史
3. 点击历史记录条目会在新窗口打开并自动续播
4. 有更新的剧集会显示红色「有更新」标记

### 调试模式

生产环境下日志默认关闭，仅输出错误/警告信息。如需排查问题，在浏览器控制台执行以下命令开启详细日志：

```js
// 开启详细日志（需刷新页面）
localStorage.setItem('CZ_HISTORY_DEBUG', '1')

// 关闭详细日志
localStorage.setItem('CZ_HISTORY_DEBUG', '0')
```

## 技术实现

- 纯 JavaScript，零依赖，通过 Tampermonkey `@grant none` 注入
- iframe 内播放器通过 `postMessage` 与顶层页面通信，获取播放进度
- 进度追踪支持 ArtPlayer 自定义播放器及原生 `<video>` 元素
- 封面图通过 fetch 详情页 DOM 解析自动抓取
- 最新集数通过解析播放列表 DOM 检测，支持中文数字

## 许可

[MIT](LICENSE)
