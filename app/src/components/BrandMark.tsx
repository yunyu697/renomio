/**
 * 品牌图标。颜色只跟随明暗主题（data-theme），不随配色方案变化：
 * 浅色主题用 flow-indigo-light 的取色，深色主题用 flow-indigo-dark 的取色。
 * 形状与 src-tauri/icons/source-light.svg / source-dark.svg 一致。
 */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 104 104"
      role="img"
      aria-label="Renomio"
    >
      <rect className="bm-tile" x="0" y="0" width="104" height="104" rx="24" />
      <g transform="rotate(-11 52 54)">
        <rect className="bm-ghost" x="27" y="26" width="42" height="54" rx="7" opacity="0.28" />
      </g>
      <g transform="rotate(8 52 54)">
        <rect className="bm-ghost" x="35" y="27" width="42" height="54" rx="7" opacity="0.52" />
      </g>
      <rect className="bm-doc" x="33" y="29" width="42" height="54" rx="7" />
      <rect className="bm-line" x="40" y="47" width="26" height="3" rx="1.5" />
      <rect className="bm-line" x="40" y="56" width="20" height="3" rx="1.5" opacity="0.6" />
      <rect className="bm-line" x="40" y="65" width="23" height="3" rx="1.5" opacity="0.35" />
      <circle className="bm-badge" cx="76" cy="77" r="15" />
      <path className="bm-arrow" d="M69 77h13m-5-5 5 5-5 5" />
    </svg>
  );
}
