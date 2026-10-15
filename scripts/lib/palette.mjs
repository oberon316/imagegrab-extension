/**
 * 品牌配色（十六进制）。
 *
 * 这是配色的唯一定义处：
 *  - 图标生成器把十六进制换算成 RGB 后绘制；
 *  - check.mjs 校验这套色值确实出现在界面样式里，避免有人偷偷换色后三处不一致。
 */
export const PALETTE = Object.freeze({
  /** 奶油白 —— 页面底色、卡片底色 */
  cream: '#F7F3E9',
  /** 深松石绿 —— 主色，按钮与标题 */
  teal: '#0E5C55',
  /** 深松石绿（按下/悬停加深） */
  tealDeep: '#0A4640',
  /** 焦糖棕 —— 强调、警示 */
  caramel: '#A9682F',
  /** 雾金 —— 描边、次要强调 */
  gold: '#C9A96A',
  /** 正文墨色 */
  ink: '#2B2A27',
});

/** '#RRGGBB' -> [r, g, b] */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`hexToRgb: 非法颜色 ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
