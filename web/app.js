// iUART web console. Talks to the board over a small HTTP API:
//   GET  /api/status            board, ports, baud, network, uptime
//   GET  /api/logs?since=N      new serial output since sequence N (header X-Seq = next N)
//   POST /api/send              raw bytes to the active port (request body)
//   POST /api/uart?name=UART1   switch the active port
//   POST /api/baud?value=115200 change the baud rate
//   POST /api/clear             drop the board's log buffer
// Opened as a file or with ?demo it runs a built-in demo instead.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const screen = $("screen"), cmd = $("cmd"), form = $("form");
  const EOL = { lf: "\n", crlf: "\r\n", cr: "\r", none: "" };
  const KEYS = { enter: "\r", tab: "\t", backspace: "\x7f", up: "\x1b[A", down: "\x1b[B", ctrlc: "\x03", ctrld: "\x04", esc: "\x1b" };
  const MAX_CHARS = 400000;

  let seq = 0;
  let atLineStart = true;
  let plain = "";               // the whole log as text, for "save log"
  let history = [], historyPos = 0;
  let api = realApi();

  // ---------- rendering ----------

  // strip terminal control sequences the board's shell sends (colors, bracketed paste, titles)
  const cleanup = (text) => text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");

  function stamp() {
    const d = new Date();
    return `[${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}] `;
  }

  function nearBottom() { return screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40; }

  function append(text, cls) {
    if (!text) return;
    const follow = $("autoscroll").checked && nearBottom();
    const frag = document.createDocumentFragment();
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      if (cls) { const s = document.createElement("span"); s.className = cls; s.textContent = buffer; frag.appendChild(s); }
      else frag.appendChild(document.createTextNode(buffer));
      plain += buffer; buffer = "";
    };
    for (const ch of text) {
      if (ch === "\b" || ch === "\x7f") { // the shell erasing a character
        if (buffer) buffer = buffer.slice(0, -1);
        else eraseLastChar();
        continue;
      }
      if (atLineStart && $("stamps").checked) {
        flush();
        const t = document.createElement("span"); t.className = "ts"; t.textContent = stamp(); frag.appendChild(t);
      }
      buffer += ch;
      atLineStart = ch === "\n";
    }
    flush();
    screen.appendChild(frag);
    trim();
    if (follow || $("autoscroll").checked && cls === "sent") screen.scrollTop = screen.scrollHeight;
  }

  function eraseLastChar() {
    let node = screen.lastChild;
    while (node && !node.textContent) node = node.previousSibling;
    if (!node) return;
    node.textContent = node.textContent.slice(0, -1);
    plain = plain.slice(0, -1);
  }

  function trim() {
    while (plain.length > MAX_CHARS && screen.firstChild) {
      plain = plain.slice(screen.firstChild.textContent.length);
      screen.removeChild(screen.firstChild);
    }
  }

  function system(msg) { append((atLineStart ? "" : "\n") + msg + "\n", "sys"); }

  // ---------- status ----------

  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  }

  function renderStatus(st) {
    $("board").textContent = st.board || "wireless serial console";
    $("ip").textContent = st.mode === "ap" ? `${st.ip} · ${st.ssid} (hotspot)` : st.ip;
    $("rssi").textContent = st.mode === "ap" ? "access point" : `${st.rssi} dBm ${bars(st.rssi)}`;
    $("uptime").textContent = `up ${fmtUptime(st.uptime)}`;
    $("muted").querySelector("b").textContent = st.muted || 0;
    $("baud").value = String(st.baud);
    const box = $("uarts");
    if (box.dataset.ports !== st.uarts.join()) {
      box.dataset.ports = st.uarts.join();
      box.innerHTML = "";
      st.uarts.forEach((name) => {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = name.toLowerCase(); b.dataset.name = name; b.setAttribute("role", "tab");
        b.addEventListener("click", () => selectUart(name));
        box.appendChild(b);
      });
    }
    box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.name === st.uart)));
  }

  function bars(rssi) { return rssi > -55 ? "▂▄▆█" : rssi > -67 ? "▂▄▆" : rssi > -78 ? "▂▄" : "▂"; }

  function setLink(on, text) {
    const el = $("link");
    el.classList.toggle("on", on); el.classList.toggle("off", !on);
    el.querySelector("span").textContent = text;
  }

  // ---------- actions ----------

  async function send(data, echo) {
    if (!data) return;
    if (echo !== undefined) append(echo, "sent");
    try { await api.send(data); } catch { system("! could not reach the board"); }
    poll();
  }

  async function selectUart(name) {
    try { renderStatus(await api.uart(name)); system(`— switched to ${name}`); } catch { system("! could not switch port"); }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = cmd.value;
    if (text.trim()) { history.push(text); if (history.length > 100) history.shift(); }
    historyPos = history.length;
    send(text + EOL[$("eol").value], undefined);
    cmd.value = ""; resize();
  });

  cmd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); return; }
    if (e.key === "c" && e.ctrlKey && !cmd.value) { e.preventDefault(); send(KEYS.ctrlc); return; }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !cmd.value.includes("\n")) {
      if (!history.length) return;
      e.preventDefault();
      historyPos = Math.max(0, Math.min(history.length, historyPos + (e.key === "ArrowUp" ? -1 : 1)));
      cmd.value = history[historyPos] || ""; resize();
    }
  });

  function resize() { cmd.style.height = "auto"; cmd.style.height = Math.min(cmd.scrollHeight, 140) + "px"; }
  cmd.addEventListener("input", resize);

  $("keys").addEventListener("click", (e) => {
    const key = e.target.closest("button")?.dataset.key;
    if (key) send(KEYS[key]);
  });

  $("baud").addEventListener("change", async () => {
    try { renderStatus(await api.baud($("baud").value)); system(`— baud ${$("baud").value}`); } catch { system("! could not change baud"); }
  });

  $("clear").addEventListener("click", async () => {
    screen.textContent = ""; plain = ""; atLineStart = true;
    try { await api.clear(); } catch { /* the screen is cleared anyway */ }
  });

  $("download").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([plain], { type: "text/plain" }));
    a.download = `iuart-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- polling ----------

  let polling = false, failures = 0;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const r = await api.logs(seq);
      if (r.reset && seq) system("— earlier output was dropped from the board's buffer");
      seq = r.seq;
      append(cleanup(r.text));
      if (failures) { failures = 0; refreshStatus(); }
    } catch {
      if (++failures === 3) setLink(false, "offline");
    } finally { polling = false; }
  }

  async function refreshStatus() {
    try { renderStatus(await api.status()); setLink(true, "online"); return true; }
    catch { setLink(false, "offline"); return false; }
  }

  // ---------- API ----------

  function realApi() {
    const json = (r) => { if (!r.ok) throw new Error(r.status); return r.json(); };
    return {
      status: () => fetch("/api/status", { cache: "no-store" }).then(json),
      logs: async (since) => {
        const r = await fetch(`/api/logs?since=${since}`, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        return { text: await r.text(), seq: Number(r.headers.get("X-Seq")) || since, reset: r.headers.get("X-Reset") === "1" };
      },
      send: (data) => fetch("/api/send", { method: "POST", headers: { "Content-Type": "text/plain" }, body: data }).then((r) => { if (!r.ok) throw new Error(r.status); }),
      uart: (name) => fetch(`/api/uart?name=${encodeURIComponent(name)}`, { method: "POST" }).then(json),
      baud: (v) => fetch(`/api/baud?value=${encodeURIComponent(v)}`, { method: "POST" }).then(json),
      clear: () => fetch("/api/clear", { method: "POST" }),
    };
  }

  // A Linux board booting, then a tiny shell — for the demo and screenshots
  function demoApi() {
    const st = { board: "XIAO ESP32-C6 · demo", uarts: ["UART1"], uart: "UART1", baud: 115200, ip: "192.168.1.100", mode: "sta", ssid: "home", rssi: -58, uptime: 3725, muted: 3 };
    const boot = [
      "DDR Version V1.04 20230516", "LPDDR2, 528MHz", "U-Boot 2017.09 (Dec 07 2023 - 10:21:33 +0800)",
      "Model: Luckfox Pico Max", "Starting kernel ...", "",
      "[    0.000000] Booting Linux on physical CPU 0x0", "[    0.000000] Linux version 5.10.160 (gcc version 8.3.0)",
      "[    0.000000] CPU: ARMv7 Processor [410fc075] revision 5 (ARMv7), cr=10c5387d",
      "[    1.104511] rockchip-pinctrl pinctrl: probed pinctrl", "[    1.732050] mmc0: new high speed SDHC card at address aaaa",
      "[    2.415602] EXT4-fs (mmcblk0p6): mounted filesystem with ordered data mode", "[    3.002118] rk_gmac-dwmac ffa80000.ethernet eth0: Link is Up - 100Mbps/Full",
      "", "Ubuntu 22.04.3 LTS luckfox ttyFIQ0", "", "luckfox login: pico", "Password: ", "Welcome to Luckfox Pico Max", "", "pico@luckfox:~$ ",
    ];
    const out = { "uname -a": "Linux luckfox 5.10.160 #1 Thu Dec 7 10:21:33 CST 2023 armv7l armv7l armv7l GNU/Linux",
      "ls": "blink.py  config  logs  www", "uptime": " 01:02:05 up  1:02,  1 user,  load average: 0.08, 0.04, 0.01",
      "ip -br a": "lo      UNKNOWN  127.0.0.1/8\neth0    UP       192.168.1.166/24", "help": "try: uname -a, ls, uptime, ip -br a" };
    let pending = "", line = "", t = 0;
    const timer = setInterval(() => { if (t < boot.length) pending += boot[t++] + (t === boot.length ? "" : "\r\n"); else clearInterval(timer); }, 160);
    setInterval(() => { st.uptime++; }, 1000);
    const later = (v) => new Promise((res) => setTimeout(() => res(v), 60));
    return {
      status: () => later({ ...st }),
      logs: (since) => { const text = pending; pending = ""; return later({ text, seq: since + text.length, reset: false }); },
      send: (data) => {
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            const c = line.trim(); line = "";
            pending += "\r\n" + (c ? (out[c] ?? `${c.split(" ")[0]}: command not found`) + "\r\n" : "") + "pico@luckfox:~$ ";
          } else if (ch === "\x03") { line = ""; pending += "^C\r\npico@luckfox:~$ "; }
          else if (ch === "\x7f") { if (line) { line = line.slice(0, -1); pending += "\b \b"; } }
          else if (ch >= " ") { line += ch; pending += ch; }
        }
        return later();
      },
      uart: (name) => later({ ...st, uart: name }),
      baud: (v) => { st.baud = Number(v); return later({ ...st }); },
      clear: () => later(),
    };
  }

  // ---------- start ----------

  async function start() {
    const demo = location.protocol === "file:" || new URLSearchParams(location.search).has("demo");
    if (demo || !(await refreshStatus())) {
      api = demoApi();
      $("demo-note").hidden = false;
      await refreshStatus();
    }
    setInterval(poll, 400);
    setInterval(refreshStatus, 5000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    poll();
    cmd.focus();
  }

  start();
})();
