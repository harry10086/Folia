# Folia
> **Folia** 是什么？和 Obsidian 一样：**文件系统就是数据库，Markdown 就是数据格式。**
**Folia** 是一个基于 Tauri 2 + Vue 3 + CodeMirror 6 的 Markdown 笔记管理器。本地文件夹优先、零隐藏数据库、跨平台、极轻量的 Obsidian 替代。

**Folia 特点：**
- 不在笔记目录生成任何隐藏配置或数据库
- 不维护常驻内存的全文索引
- 没有复杂的插件市场与 CSS 脚本体系
- 没有白板与重型任务管理
- 没有关系图谱
- 没有内置的云同步

如果你和我一样，只是信息收集、日常写作、记录、整理和阅读 Markdown 文档，那应该用得上这款轻量笔记软件 **Folia**。

> 虽然说是全平台，实际上 Linux 和 macOS 我都没测过，macOS 我没条件测，Linux 我是在不想测，因为之前测 RimeTune 把我搞累了，实在不想碰了。
> 如有需要请自行 AI 去改吧，改完记得 PR 就好，反正我也都是 AI。

---

## 核心特性

### 1. 纯净的本地多工作区管理
- **多工作区并行管理**：同时挂载多个本地笔记目录，全局以 `(workspaceId, canonicalPath)` 唯一标识文档，自动区分多库同名文件（如多个目录下的 `README.md`）。
- **完整文件树操作**：支持新建笔记/文件夹、重命名、复制副本、拖拽移动、排序切换（名称升序/降序/修改时间）、在系统文件管理器中定位；删除默认移至系统回收站防止误删；支持**多笔记库拖拽 / 上下箭头调整顺序**与**一键收起全部目录树**。
- **侧边栏自动隐藏、自动跟随与笔记库高亮**：支持固定显示、一键折叠或**鼠标贴边自动隐藏/滑出**；点击或切换任意标签页时，左侧文件树会自动展开所在目录、高亮所属笔记库与当前文件并平滑滚动定位。
- **内嵌命令终端分栏（PTY + xterm.js）**：点击左侧栏任意笔记库横条上的终端图标，即可在右侧分栏直接打开该目录的真实交互终端（Windows 默认自动使用 Git Bash，并支持在「设置 → 命令终端」中自由切换 PowerShell / CMD / Zsh / 自定义路径及调整字体、字号、行高与光标样式）。
- **零侵入目录结构**：不强制图片或附件存放路径，不在笔记库内写入 `.folia` 等隐藏文件夹；安装版配置保存在系统应用数据目录，**Windows 便携版**在程序目录保留 `portable.txt` 时自动将配置保存在同级 `data/` 目录实现真正绿色免安装。

### 2. CodeMirror 6 双模式编辑器与 HTML 预览
- **实时预览 & 源码双栏预览一键切换**：
  - **实时预览模式**：光标离开行/块时自动隐藏语法符号并内联渲染标题、加粗、高亮、图片、可点击待办复选框、表格、提示块、数学公式与图表；光标单击进入即展开源码编辑，鼠标拖选标题或提示块标题时保持稳定不跳动、可直接复制。
  - **源码模式（自动左右双栏同步预览）**：切换至源码模式后自动在当前标签页内左右分栏（左侧源码编辑、右侧实时同步渲染预览，中间分隔条支持拖拽调比例、双击恢复 50%），与多标签分栏完全独立。
- **HTML 文件浏览与源码编辑**：支持直接打开 `.html` / `.htm` 文件，在内置网页浏览预览与 CodeMirror 6 HTML 源码编辑之间切换，并支持一键在系统浏览器中打开。
- **丰富的 Markdown 语法支持**：
  - 基础与 GFM 语法：YAML Frontmatter、标题、列表、待办清单、表格、代码块高亮、分割线、脚注。
  - 扩展语法：`++下划线++`、`==高亮==`、`~下标~`、`^上标^`、GitHub Callout（`> [!TIP]` / `NOTE` / `IMPORTANT` / `WARNING` / `CAUTION`）、Emoji 短码（如 `:rocket:`）。
  - 可视化扩展（按需懒加载，不拖慢冷启动）：**KaTeX** 行内/块级 LaTeX 数学公式、**Mermaid** 流程图/思维导图/时序图。
- **高效编辑辅助**：
  - 空行或空格后输入 `/` 唤出格式插入菜单。
  - 输入 `[[` 触发当前工作区文件模糊补全，默认写入跨工具通用的标准相对路径 `[笔记名](相对路径.md)`（可在设置中切换为 `[[双链语法]]`），均支持 `Ctrl / Cmd + Click` 跳转文件或 `#标题`。
  - 可折叠目录大纲（点击定位 + 滚动高亮当前章节）与右侧仿 VS Code 风格高 DPI 微缩排版缩略图（支持独立开关与拖拽定位）。
  - **大文件自动降级**：单文件超过 `512 KB` 自动切换为高性能单栏源码模式并关闭重型内联组件，保障流畅不卡顿。

### 3. 跨平台图片与附件管理
- **自定义本地资源协议 `folia-asset://`**：在 Rust 侧校验工作区安全边界、规范化中文与空格路径，自动兼容 Obsidian 风格的 `_resources` 附件目录回退解析，并返回 `Cache-Control: no-store`，确保相对路径图片在 Windows / macOS / Linux 三端一致渲染。
- **粘贴与拖拽自动落盘**：剪贴板截图粘贴或外部图片拖入编辑器自动保存至指定目录（支持当前笔记子目录 `./images`、同级目录、工作区统一附件目录），自动插入 POSIX 风格相对路径。
- **底部可折叠附件栏**：浏览当前笔记所在目录及常见子目录中的图片、PDF 与其他附件，支持缩略图预览、一键插入 Markdown 引用、复制相对路径与灯箱大图查看。

### 4. 安全防覆盖、编码无损与崩溃恢复
- **编码与换行符无损保留**：自动识别 UTF-8、UTF-8 BOM、UTF-16 与 GB18030/GBK 等旧文档编码，并记录原始 `LF` / `CRLF` 换行符，保存时按原格式写回。
- **自动保存 + 文件监控防覆盖状态机**：Rust 侧通过 `notify` 防抖监听 + `blake3` 内容哈希 + `SelfWriteGuard` 自写登记表，彻底杜绝自动保存触发误弹窗；外部编辑器修改正在编辑的脏文件时，拦截写入并弹出顶部非阻塞冲突条（支持 **行级 Diff 对比** / **重新加载** / **保留当前版本**）。
- **原子写入 & 崩溃恢复**：保存采用同目录临时文件原子替换；未保存内容定期向系统 `AppData` 写入恢复草稿，异常退出重启后自动提示一键恢复。

### 5. 统一搜索、多标签分栏与双文件行级 Diff 对比
- **左侧栏统一过滤与流式全文检索（`Ctrl / Cmd + Shift + F`）**：空白时显示完整文件树，输入关键词即时同步过滤文件名并触发基于 ripgrep 同源 Rust `ignore` + `grep-searcher` 的全库流式正文搜索（支持大小写敏感、全字匹配、正则表达式、按工作区过滤与输入变更即时取消）。
- **增强标签栏**：支持标签溢出横向滚轮/左右箭头滚动、全部标签下拉列表、**固定标签页**（右键固定，归集左侧防误关）、**鼠标拖拽自由排序**。
- **灵活的 2 分栏 / 3 分栏视图（带可拖动分隔条）**：
  - 顶栏分栏按钮支持左右分栏与上下分屏均按 **单栏 → 2 分栏 → 3 分栏 → 单栏** 循环切换；
  - 支持 **`Ctrl / Cmd + 点击` 多选 2～3 个标签页**一键合并为 2 分栏 / 3 分栏；
  - 支持**鼠标按住标签页拖至编辑区左右边缘**直接拆出新分栏，或拖入其他分栏跨栏移动；
  - 分栏分隔条支持自由拖拽调节宽度/高度，双击恢复均分。
- **内置双文件行级差异对比（`@codemirror/merge`）**：可通过以下 3 种方式随时唤出：
  1. 在**左侧文件树**中右键任意 Markdown 文件 →「与当前打开文件 Diff 对比」；
  2. 在**顶栏标签页**中右键另一标签页 →「与当前标签 Diff 对比」，或按住 `Ctrl` 选中 2 个标签页后点击「对比差异」；
  3. 当文件被外部程序修改产生冲突时，点击顶部冲突条的「对比差异」。

### 6. 主题配色（支持 YAML 导入导出）、快捷键手势与导出
- **16 套内置纸感主题 + 无限自定义主题**：内置 10 套浅色主题与 6 套深色主题，顶栏提供一键深浅模式切换；支持彩色渲染 / 单色渲染、圆角风格、边栏始终深色、自定义字体/字号/行距与界面缩放。
- **可视化微调 & YAML 配色代码编辑**：支持新建、更新与删除自定义主题卡片，支持像 YAML 代码一样直接编辑、**复制 / 粘贴 / 导入 `.yaml` / 导出 `.yaml`** 分享配色方案。
- **可自定义快捷键与鼠标手势**：所有全局快捷键与右键鼠标手势均可在设置中可视化录制与编辑。
- **HTML & PDF 导出**：
  - 导出单文件 HTML（自动应用当前主题配色，并将本地相对图片转为 Base64 内嵌以支持离线分享）。
  - 导出 PDF（调用系统打印配合专用 `@media print` 排版样式，零额外包体膨胀）。
- **自动更新检查**：设置中心内置「关于与更新」，支持启动时自动检查或手动查询 GitHub Releases 新版本并跳转下载。

---

## 技术栈与架构

| 模块 | 技术选型 |
| :--- | :--- |
| **桌面框架** | Tauri 2（Windows WebView2 / macOS WKWebView / Linux WebKitGTK） |
| **前端框架** | Vue 3 + TypeScript + Pinia + Vite |
| **编辑器内核** | CodeMirror 6（`@codemirror/*` + `@codemirror/merge`） |
| **后端运行时** | Rust（`std::fs`, `trash`, `notify`, `ignore`, `grep-searcher`, `encoding_rs`, `chardetng`, `blake3`） |
| **扩展渲染与导出** | `marked` + `markdown-it` + `katex` + `mermaid`（动态懒加载） |

### 项目目录结构

```text
Folia/
├── src/                        # 前端应用（Vue 3 + TypeScript）
│   ├── core/                   # 与 UI 框架解耦的核心业务层
│   │   ├── ipc/                # Tauri 强类型 IPC 与 folia-asset:// 地址映射
│   │   ├── markdown/           # CM6 实时预览、大纲提取、/ 与 [[ 补全、格式快捷键
│   │   ├── export/             # HTML 单文件导出与 PDF 打印排版
│   │   ├── gestures/           # 右键拖拽鼠标手势识别器与轨迹绘制
│   │   ├── shortcuts/          # 跨平台快捷键定义与自定义录制匹配
│   │   ├── theme/              # 16 套主题色卡、YAML 主题编解码与 CSS Token 引擎
│   │   ├── ui/                 # 跨分栏指针标签拖拽状态
│   │   ├── update/             # GitHub Releases 版本检查器
│   │   └── __tests__/          # Vitest 前端单元测试
│   ├── stores/                 # Pinia 状态管理（settings / workspace / tabs）
│   ├── components/             # 视图组件（Sidebar / EditorPaneView / MarkdownEditor / MarkdownPreviewPane / Minimap / OutlinePanel / AttachmentBar / DiffModal / QuickOpenModal / SettingsModal / GlobalTooltip）
│   └── styles/                 # 全局样式、CodeMirror 主题与打印样式
├── src-tauri/                  # Rust 后端核心
│   ├── src/
│   │   ├── fs/                 # 目录扫描、编码/换行符无损读写、原子写入、回收站、附件保存
│   │   ├── watcher/            # notify 防抖监控与 blake3 自写防覆盖守卫
│   │   ├── search/             # ignore + grep-searcher 流式全文检索与取消控制
│   │   ├── protocol/           # 自定义 folia-asset:// 协议处理器
│   │   ├── config/             # AppData 配置持久化与崩溃恢复草稿
│   │   └── commands/           # Tauri IPC 命令入口
│   └── tests/                  # Rust 后端核心集成测试
└── .github/workflows/          # Windows / macOS / Linux 跨平台 CI 与 Release 自动发布流水线
```

---

## 快捷键与鼠标手势

### 默认全局快捷键（均可在设置中自定义，macOS 下将 `Ctrl` 替换为 `⌘`）

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + S` | 保存当前文件 |
| `Ctrl + N` | 快速新建笔记 |
| `Ctrl + W` | 关闭当前标签页 |
| `Ctrl + P` | 快速打开文件 |
| `Ctrl + Shift + F` | 聚焦左侧文件过滤 / 全库搜索 |
| `Ctrl + Shift + L` | 切换实时预览 / 源码双栏预览 |
| `Ctrl + Shift + B` | 显示 / 隐藏左侧文件栏 |
| `Ctrl + Shift + O` | 显示 / 隐藏目录大纲 |
| `Ctrl + Shift + M` | 显示 / 隐藏右侧缩略图 |
| `Ctrl + Shift + A` | 显示 / 隐藏底部附件栏 |
| `Ctrl + \` | 左右分栏循环（单栏 → 2 栏 → 3 栏 → 单栏） |
| `Ctrl + Shift + \` | 上下分屏 |
| `Ctrl + Shift + E` | 导出为单文件 HTML |
| `Ctrl + Shift + P` | 打印 / 导出为 PDF |
| `Ctrl + ,` | 打开设置中心 |

### 编辑器格式化快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + B` | **加粗**（`**text**`） |
| `Ctrl + I` | *斜体*（`*text*`） |
| `Ctrl + U` | ++下划线++（`++text++`） |
| `Ctrl + Shift + X` | ~~删除线~~（`~~text~~`） |
| `Ctrl + E` | `行内代码`（`` `code` ``） |
| `Ctrl + Shift + H` | ==高亮==（`==text==`） |

### 默认鼠标手势（按住鼠标右键拖动触发，均可在设置中录制与修改）

| 手势轨迹 | 对应动作 |
| :--- | :--- |
| `←`（向左） | 切换到上一个标签页 |
| `→`（向右） | 切换到下一个标签页 |
| `↓→`（L 形） | 关闭当前标签页 |
| `↑`（向上） | 平滑滚动到文档顶部 |
| `↓`（向下） | 平滑滚动到文档底部 |
| `↑↓`（上下折返） | 切换实时预览 / 源码模式 |

---

## 本地开发与构建

### 环境依赖
- **Node.js** 20+（推荐 LTS）
- **Rust** 稳定版工具链（`rustup` + `cargo`）
- **系统 WebView / 编译工具**：
  - **Windows**：Edge WebView2 Runtime（Windows 10/11 通常已预装）+ MSVC Build Tools 或 GNU 工具链
  - **macOS**：Xcode Command Line Tools（`xcode-select --install`）
  - **Linux (Ubuntu/Debian)**：
    ```bash
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libxdo-dev
    ```

### 常用命令

```bash
# 1. 安装前端依赖
npm install

# 2. 启动桌面开发模式（热重载）
npm run tauri dev

# 3. 前端类型检查与生产构建
npm run build

# 4. 运行前端单元测试（Vitest）
npm test

# 5. 运行 Rust 后端集成测试
cargo test --manifest-path src-tauri/Cargo.toml --test core_tests

# 6. 打包当前平台发布安装包
npm run tauri build
```

> **Windows PowerShell 提示**：若系统限制执行 `npm.ps1`，可将上述命令中的 `npm` 替换为 `npm.cmd`（例如 `npm.cmd run tauri dev`）。

---

## 作者与开源协议

- **作者**：harry（[mianao.info](https://mianao.info)）
- **开源协议**：本项目遵循仓库中的 [LICENSE](LICENSE) GPLv3 协议发布。
