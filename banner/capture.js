// Drives headless Chrome over CDP and captures deterministic frames of scene.html.
// usage: node capture.js <outDir> <frames> <fps> [singleT]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = __dirname.replace(/\\/g, '/');
const [outDir, framesArg = '200', fpsArg = '25', singleT] = process.argv.slice(2);
const FRAMES = Number(framesArg), FPS = Number(fpsArg);
const W = 1600, H = 520, PORT = 9333;
const SCENE = process.env.SCENE || "scene.html", DPR = Number(process.env.DPR || 1), QS = process.env.QS || '';
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${here}/chrome-profile`,
    '--hide-scrollbars', `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--allow-file-access-from-files', 'about:blank',
  ], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.navigate', { url: `file:///${here}/${SCENE}${QS ? '?' + QS : ''}` });
  const t0 = Date.now();
  while (!(await evalJs('window.__ready === true').catch(() => false))) {
    if (Date.now() - t0 > 60000) {
      const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
      console.error('timeout; errors:', JSON.stringify(errs).slice(0, 2000)); process.exit(1);
    }
    await sleep(300);
  }
  console.log('info:', JSON.stringify(await evalJs('window.__info || null')));
  console.log('gl:', await evalJs(`(() => { const g = document.getElementById('gl').getContext('webgl2'); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; })()`));

  const list = singleT !== undefined ? [Number(singleT)] : Array.from({ length: FRAMES }, (_, i) => i / FPS);
  const start = Date.now();
  for (let i = 0; i < list.length; i++) {
    await evalJs(`window.renderAt(${list[i]})`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    fs.writeFileSync(path.join(outDir, singleT !== undefined ? `still_${singleT}.png` : `f_${String(i).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (i % 25 === 0) console.log(`frame ${i}/${list.length} ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  ws.close(); chrome.kill();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
