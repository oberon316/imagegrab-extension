/**
 * lib/theme.js —— 品牌配色的 JS 侧定义（扩展页面使用）。
 *
 * 同一套色值在三个地方各有一份：
 *   scripts/lib/palette.mjs      图标生成器
 *   extension/content/url-tools.js  内容脚本浮层
 *   extension/lib/theme.js       扩展页面（本文件）
 * 外加 extension/gallery/gallery.css 里的 CSS 变量。
 * check.mjs 会校验这几处完全一致。
 */

export const PALETTE = Object.freeze({
  /** 奶油白 —— 页面底色、卡片底色 */
  cream: '#F7F3E9',
  /** 深松石绿 —— 主色 */
  teal: '#0E5C55',
  /** 深松石绿（悬停/按下） */
  tealDeep: '#0A4640',
  /** 焦糖棕 —— 强调、警示 */
  caramel: '#A9682F',
  /** 雾金 —— 描边、次要强调 */
  gold: '#C9A96A',
  /** 正文墨色 */
  ink: '#2B2A27',
});
