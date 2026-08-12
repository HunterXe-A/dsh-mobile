# dsh-mobile

DSH WebUI 移动端适配插件（**PiUI 翻页器模式**）：信息流**原样保留**，整页左右翻页打开侧边栏——窄屏下框架本身就是横向 scroll-snap 翻页器（侧边栏 | 聊天 | 详情），聊天页全宽且渲染零改动。纯客户端适配，零核心改动——官方 rc.2 发行版直接可用，不依赖任何扩展点 patch。

## 功能

- **左右翻页（PiUI mobile-chat-pager）**：≤768px 时三栏框架重排为三页横向 snap 容器——侧边栏页 = `视口宽 - 72px`（露出 72px 聊天页边缘，PiUI overlayWidth 规则），聊天页与详情页各占全宽；手指左右滑动翻页，或点页头 ☰ / hero 悬浮 ☰ 程序化翻页（带滑入动画）
- **信息流原样**：聊天列就是原生渲染，一行未改，只是被放进翻页容器
- **状态驱动翻页**：控制器观察框架自身的 `data-sidebar-collapsed`（AppFrame 的稳定属性），侧边栏展开 ⟷ 侧边栏页；手动滑动只是浏览，不干扰状态
- **选会话自动回聊天页**：在侧边栏页点了会话（或新建会话）后自动翻回聊天页（菜单打开与手动滑过去两种路径都处理）
- **安全区与键盘**：`viewport-fit=cover` + safe-area env() 变量 + visualViewport 驱动的 `--dshm-keyboard-inset`，输入条悬浮在 Home 指示条与虚拟键盘之上；`100dvh` 动态视口（iOS Safari 地址栏安全）
- **触控优化**：按钮最小 32px 命中高度（PiUI 基线）、粗指针隐藏滚动条、`overscroll-behavior` 防回弹、点击高亮透明、翻页滚动条隐藏
- **原生视觉**：桌面宽度下逐字节等同原生（全部规则以 `<html data-dsh-mobile>` 为作用域，卸载即恢复原样）

## 效果

| 桌面（原生三栏） | 手机（聊天页） | 手机（滑到侧边栏页） |
|---|---|---|
| ![桌面原生](screenshots/desktop-native.png) | ![聊天页](screenshots/mobile-chat-page.png) | ![侧边栏页](screenshots/mobile-sidebar-page.png) |

## 安装

```sh
git clone https://github.com/dsh-external/dsh-mobile.git
dsh plugin --profile web add link:E:/dev/dsh-mobile
```

重启 `dsh web`，用手机模式（DevTools 设备模拟）或真实手机访问即可。

## 使用

- **打开侧边栏**：手指向右滑（聊天页 → 侧边栏页）；或会话页头左侧 ☰（仅手机宽度显示）；无会话起始页为左上角悬浮 ☰
- **返回聊天**：手指向左滑；或再点 ☰ / FAB；在侧边栏页选了会话后自动翻回
- **详情页**：第三页（手指继续左滑到达）——本快照中详情列本身只有空态，且窄屏下框架让步链保持其关闭，故默认不可达
- **桌面不受影响**：≥769px 时 ☰ 隐藏，框架恢复三栏

## 设计约束（为什么是 CSS + 轻量控制器，而不是替换 root）

- dsh 的 `root` 槽位是框架内建的 `single` 槽，由 ui-layout 独占——插件不能替换 AppFrame
- 因此翻页器直接作用于 **AppFrame 本身**：CSS 把 grid 轨道重排为三页（`calc(100% - 72px) 100% 100%`）+ `overflow-x: auto` + `scroll-snap`，控制器只滚动它并镜像页面状态——全部基于稳定 data 属性（`data-sidebar-collapsed` / `data-details-collapsed`，rc.2 与工作区快照一致）与对话骨架的 data 座位，**不依赖任何哈希类名**
- **已知限制**：窄屏下详情列仍遵循框架让步链自动关闭（核心行为，插件不越权）；想改变它属于 in-repo 改动（dsh-focus-chat README 同款结论）
- 键盘 inset 依赖 `visualViewport`（现代浏览器/PWA 均有）；不支持时退化为 0

## 开发

```sh
pnpm install        # devDeps link 到 ../test-lehhair（DSH 源码，需先构建其 client 包）
pnpm run check      # typecheck + test + build
```

```
src/client/
  controller.ts      # DOM 控制器：viewport meta、翻页镜像、键盘 inset、FAB、选会话回聊天页
  mobile.css         # 全局移动端样式表（<style data-plugin> 注入，卸载即移除）
  MobileMenuButton.tsx  # 页头 ☰（header.actions 槽位，order -10）
  locales.ts         # 中英文案
```

## License

BSD-3-Clause
