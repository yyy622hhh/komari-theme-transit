<h3 align="center">komari-theme-Glassmorphism</h3>
<p align="center">
基于 Vue 3 + Vite + reka-ui + Tailwind CSS v4 的 Komari Monitor 毛玻璃主题
</p>

![preview](/docs/preview.png)

## 简介

komari-theme-Glassmorphism 是一个为 Komari Monitor 打造的毛玻璃（Glassmorphism）风格主题，以简洁现代的设计理念，打造清爽的监控面板视觉体验。此项目在原始 `Komari Emerald` 主题基础上进行了完整改造，优化了整体设计、色彩方案、卡片样式和交互体验。

##效果预览
![主页](https://i.111666.best/image/8ipd0XZXr159FwES6qsyV8.png)
![节点详情](https://i.111666.best/image/v4CAvcy5ZYdTKwRTzMm9pm.png))
## 主要改动

### 视觉设计

- 添加了根据识别到的cpu信息对vps进行打分的内容(仅供娱乐)
- 全局采用毛玻璃（Glassmorphism）设计风格，卡片和容器具有半透明玻璃效果
- 地球仪改用纯白色背景，搭配淡蓝色柔和光晕，提升整体洁净感,连线从访客ip出发到所有节点
- 地球连线采用更细更浅的设计，减少视觉压力，强调数据流向的轻盈感

### 交互和体验

- 调整节点卡片尺寸和间距，增强可读性和视觉层次感
- 优化色彩方案，深色和浅色模式都采用现代配色

### 技术栈升级

- 迁移至 reka-ui + Tailwind CSS v4，移除 Naive UI 和 UnoCSS
- 采用 shadcn-vue 组件库设计模式，确保高度可定制性
- 优化性能和包体积

## 使用

1. 从当前仓库的 [Release 页面](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases) 下载最新的 `komari-theme-Glassmorphism-build-*.zip` 文件
2. 登录 Komari Monitor 后，点击"设置"，进入"主题管理"选项卡
3. 点击"上传主题"，选择下载的 zip 文件
4. 刷新页面，即可应用主题

## 环境要求

- Node.js: `^20.19.0` 或 `>=22.12.0`
- Bun: `>=1.2.0`

## 开发

```bash
# 安装依赖
bun install

# 启动开发服务器
bun run dev

# 代码检查
bun run lint
```

## 构建

```bash
# 类型检查 + 生产构建
bun run build

# 预览生产构建
bun run preview
```

## 技术栈

| 类别     | 技术                             |
| -------- | -------------------------------- |
| 框架     | Vue 3                            |
| 构建工具 | Vite 7                           |
| UI 组件  | reka-ui（shadcn-vue 风格组件）   |
| 样式方案 | Tailwind CSS v4 + tw-animate-css |
| 状态管理 | Pinia 3                          |
| 路由     | Vue Router 5                     |
| 提示系统 | vue-sonner（Toaster）            |
| 图标     | @iconify/vue                     |
| 图表     | vue-echarts                      |
| 3D 地球  | cobe                             |
| 实用工具 | @vueuse/core, dayjs              |
| 代码规范 | ESLint (@antfu/eslint-config)    |

## 主要特性

### 3D 地球交互

- 基于 cobe 库的交互式 3D 地球仪，展示全球节点分布
- 实时服务器位置标记和带宽流向可视化
- 支持鼠标拖拽旋转、缩放，自动旋转功能

### 响应式设计

- 完全响应式布局，适配桌面、平板和移动设备
- 深色/浅色模式自动切换，支持用户偏好设置
- 流畅的过渡动画和交互反馈

### 数据展示

- 实时节点监控信息，包括在线状态、CPU、内存、带宽等
- 网络延迟和性能图表展示
- 访问者地理位置信息展示

## 致谢

- 原始主题作者：Tokinx
- [Komari](https://github.com/komari-monitor/komari)
- [Komari Naive](https://github.com/tonyliuzj/komari-naive)
- [Vue 3](https://vuejs.org/)
- [Vite](https://vitejs.dev/)
- [reka-ui](https://reka-ui.com/)
- [Tailwind CSS](https://tailwindcss.com/)

本项目在原有 `Komari Emerald` 主题基础上进行了毛玻璃风格改造，特此感谢原作者 Tokinx 的贡献。

## License

[MIT](./LICENSE)
