// 加宽对话区：聊天页和 Code / Cowork 的对话列都变宽，输入框跟着变宽。
// Alt+Shift+W 在加宽和原样之间切换，选择记在 localStorage 里。
//
// 依据（claude.ai 前端，2026-11 版本）：
//   - 聊天页的对话列和输入框用 max-width: var(--transcript-width, 48rem)，
//     这个变量由页面自己写在 <html> 的行内样式上；样式表里的 !important 能盖过它。
//   - Code / Cowork 的对话列用 --transcript-measure（默认 768px，按 data-transcript-width=s/m/l 切换）。
// 前端改版后变量名可能会变，到时候这里不生效，不会报错。
(() => {
  const WIDTH = "min(92vw, 72rem)"; // 想要多宽改这里，例如 "1200px"、"90vw"
  const KEY = "claude-mom-ext:wide-chat";

  const style = document.createElement("style");
  style.id = "claude-mom-ext-wide-chat";
  style.textContent = `
    :root { --transcript-width: ${WIDTH} !important; }
    :root, [data-transcript-width] { --transcript-measure: ${WIDTH} !important; }
  `;

  const apply = (on) => {
    if (on) document.head.appendChild(style);
    else style.remove();
  };

  const enabled = () => localStorage.getItem(KEY) !== "off";
  apply(enabled());
  // 页面框架接管 <head> 时可能把这段样式删掉，掉了就放回去。
  setInterval(() => { if (enabled() && !style.isConnected) apply(true); }, 1000);

  addEventListener("keydown", (event) => {
    if (!event.altKey || !event.shiftKey || event.code !== "KeyW") return;
    event.preventDefault();
    const on = !enabled();
    localStorage.setItem(KEY, on ? "on" : "off");
    apply(on);
  });
})();
