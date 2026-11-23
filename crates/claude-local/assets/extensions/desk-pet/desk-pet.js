// 桌宠：一只小橘猫在 Claude 窗口底部走来走去。
// 点它会说话；按住能拖到别处，松手会掉下来；你按回车发消息时它会跳一下；不理它太久会睡着。
// Alt+Shift+P 显示 / 隐藏，选择记在 localStorage 里。
(() => {
  const KEY = "claude-mom-ext:desk-pet";
  const SIZE = 56;
  const SPEED = 40; // 走路速度，像素/秒
  const GRAVITY = 1800;
  const LINES = [
    "喵～", "今天也要好好写代码", "摸鱼被我看到了", "要不要喝口水？", "我饿了，有小鱼干吗",
    "这个 bug 我见过", "呼噜呼噜……", "Claude 想得好认真", "别熬夜哦", "摸摸头？",
  ];

  const CAT = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path class="tail" d="M15 44 C4 40 4 27 10 22" fill="none" stroke="#e8954a" stroke-width="5" stroke-linecap="round"/>
      <rect class="leg a" x="17" y="49" width="5" height="10" rx="2.5" fill="#e8954a"/>
      <rect class="leg b" x="24" y="49" width="5" height="10" rx="2.5" fill="#f4a259"/>
      <rect class="leg b" x="34" y="49" width="5" height="10" rx="2.5" fill="#e8954a"/>
      <rect class="leg a" x="41" y="49" width="5" height="10" rx="2.5" fill="#f4a259"/>
      <ellipse cx="31" cy="44" rx="18" ry="11" fill="#f4a259"/>
      <path d="M22 36 q3 6 0 12 M29 34 q3 7 0 14" stroke="#e8954a" stroke-width="2" fill="none" stroke-linecap="round"/>
      <polygon points="37,24 38,9 47,19" fill="#f4a259"/>
      <polygon points="46,19 55,9 57,24" fill="#f4a259"/>
      <polygon points="39,20 39.5,13 44,18.5" fill="#f7b7a3"/>
      <polygon points="49,18.5 54,13 55,20" fill="#f7b7a3"/>
      <circle cx="47" cy="30" r="12" fill="#f4a259"/>
      <ellipse class="eye" cx="43" cy="29" rx="1.8" ry="2.6" fill="#333"/>
      <ellipse class="eye" cx="52" cy="29" rx="1.8" ry="2.6" fill="#333"/>
      <circle cx="40" cy="34" r="2.2" fill="#f7a1a1" opacity=".6"/>
      <circle cx="55" cy="34" r="2.2" fill="#f7a1a1" opacity=".6"/>
      <polygon points="46.2,33 48.8,33 47.5,34.6" fill="#c0605a"/>
      <path d="M47.5 34.6 q-1.5 2 -3 1 M47.5 34.6 q1.5 2 3 1" stroke="#333" stroke-width=".9" fill="none" stroke-linecap="round"/>
    </svg>`;

  const STYLE = `
    :host { all: initial; }
    .pet {
      position: fixed; left: 0; bottom: 0; width: ${SIZE}px; height: ${SIZE}px; z-index: 2147483000;
      cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; will-change: transform;
    }
    .pet.drag { cursor: grabbing; }
    svg { width: 100%; height: 100%; overflow: visible; transition: transform .15s; }
    .pet.left svg { transform: scaleX(-1); }
    .leg, .tail, .eye { transform-box: fill-box; }
    .leg { transform-origin: top center; }
    .walk .leg.a { animation: step .38s infinite alternate ease-in-out; }
    .walk .leg.b { animation: step .38s infinite alternate-reverse ease-in-out; }
    @keyframes step { from { transform: rotate(20deg); } to { transform: rotate(-20deg); } }
    .tail { transform-origin: 100% 100%; animation: wag 1.2s infinite ease-in-out; }
    @keyframes wag { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(-16deg); } }
    .eye { transform-origin: center; animation: blink 4s infinite; }
    @keyframes blink { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
    .sleep .eye { animation: none; transform: scaleY(.12); }
    .sleep .tail { animation: none; }
    .drag .leg { animation: dangle .3s infinite alternate ease-in-out; }
    @keyframes dangle { from { transform: rotate(8deg); } to { transform: rotate(-8deg); } }
    .zzz {
      position: absolute; right: -6px; top: -4px; opacity: 0;
      font: bold 14px/1 system-ui, sans-serif; color: #8a8fa3;
    }
    .sleep .zzz { animation: zzz 2s infinite; }
    @keyframes zzz {
      0% { opacity: 0; transform: translate(0, 6px); }
      30% { opacity: 1; }
      100% { opacity: 0; transform: translate(10px, -16px); }
    }
    .bubble {
      position: absolute; bottom: 100%; left: 50%; margin-bottom: 4px; padding: 6px 10px;
      transform: translateX(-50%); border-radius: 10px; background: #fff; color: #333;
      font: 13px/1.4 system-ui, sans-serif; white-space: nowrap; pointer-events: none;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .18); opacity: 0; transition: opacity .2s;
    }
    .bubble.show { opacity: 1; }`;

  const start = () => {
    const host = document.createElement("div");
    host.id = "claude-mom-ext-desk-pet";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${STYLE}</style><div class="pet"><div class="bubble"></div><span class="zzz">z</span>${CAT}</div>`;
    const pet = shadow.querySelector(".pet");
    const bubble = shadow.querySelector(".bubble");

    // 页面框架重渲染时可能把我们挪走，掉了就放回去。
    const attach = () => { if (!host.isConnected && localStorage.getItem(KEY) !== "off") document.body.appendChild(host); };
    attach();
    setInterval(attach, 1000);

    const pet$ = {
      x: Math.random() * Math.max(0, innerWidth - SIZE), y: 0, vy: 0,
      dir: Math.random() < .5 ? -1 : 1, mode: "walk", until: 0, idleSince: performance.now(),
    };
    let bubbleTimer = 0;
    const say = (text, ms = 2500) => {
      bubble.textContent = text;
      bubble.classList.add("show");
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => bubble.classList.remove("show"), ms);
    };
    const wake = () => { pet$.idleSince = performance.now(); };
    const next = (now) => {
      if (Math.random() < .55) {
        pet$.mode = "walk";
        if (Math.random() < .5) pet$.dir *= -1;
        pet$.until = now + 3000 + Math.random() * 5000;
      } else {
        pet$.mode = "idle";
        pet$.until = now + 2000 + Math.random() * 4000;
      }
    };

    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - last) / 1000, .05);
      last = now;
      const maxX = Math.max(0, innerWidth - SIZE);
      if (pet$.mode === "walk") {
        pet$.x += pet$.dir * SPEED * dt;
        if (pet$.x <= 0 || pet$.x >= maxX) pet$.dir *= -1;
      }
      if (pet$.mode === "fall") {
        pet$.vy -= GRAVITY * dt;
        pet$.y += pet$.vy * dt;
        if (pet$.y <= 0) {
          pet$.y = 0;
          pet$.vy = 0;
          pet$.mode = "idle";
          pet$.until = now + 1500;
        }
      }
      if ((pet$.mode === "walk" || pet$.mode === "idle") && now > pet$.until) {
        if (now - pet$.idleSince > 45000) {
          pet$.mode = "sleep";
          say("困了，睡一会儿", 2000);
        } else {
          next(now);
        }
      }
      pet$.x = Math.min(Math.max(pet$.x, 0), maxX);
      pet.className = `pet ${pet$.mode}${pet$.dir < 0 ? " left" : ""}`;
      pet.style.transform = `translate(${pet$.x}px, ${-pet$.y}px)`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // 按住拖动；几乎没动就当作点了一下。
    let grab = null;
    pet.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pet.setPointerCapture(event.pointerId);
      grab = { x: event.clientX, y: event.clientY, dx: event.clientX - pet$.x, moved: false, wasSleeping: pet$.mode === "sleep" };
      pet$.mode = "drag";
      wake();
    });
    pet.addEventListener("pointermove", (event) => {
      if (!grab) return;
      if (Math.hypot(event.clientX - grab.x, event.clientY - grab.y) > 4) grab.moved = true;
      if (!grab.moved) return;
      pet$.x = event.clientX - grab.dx;
      pet$.y = Math.max(0, innerHeight - event.clientY - SIZE / 2);
    });
    const release = () => {
      if (!grab) return;
      const { moved, wasSleeping } = grab;
      grab = null;
      pet$.vy = 0;
      pet$.mode = "fall";
      if (moved) say("哇——", 1200);
      else say(wasSleeping ? "唔……谁叫我" : LINES[Math.floor(Math.random() * LINES.length)]);
    };
    pet.addEventListener("pointerup", release);
    pet.addEventListener("pointercancel", release);

    // 发消息（输入框里按回车，不带 Shift）时跳一下。
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      if (!(event.target instanceof Element) || !event.target.closest('[contenteditable="true"], textarea')) return;
      wake();
      if (pet$.mode === "drag") return;
      pet$.mode = "fall";
      pet$.vy = 520;
      say("收到！Claude 开工了", 1800);
    }, true);
    document.addEventListener("pointerdown", wake, true);

    addEventListener("keydown", (event) => {
      if (!event.altKey || !event.shiftKey || event.code !== "KeyP") return;
      event.preventDefault();
      if (host.isConnected) {
        localStorage.setItem(KEY, "off");
        host.remove();
      } else {
        localStorage.setItem(KEY, "on");
        attach();
        say("我回来啦");
      }
    });

    setTimeout(() => say("喵！我来陪你写代码啦"), 800);
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
