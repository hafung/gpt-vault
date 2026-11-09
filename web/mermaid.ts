import DOMPurify from 'dompurify';

type Diagram = { source: string; refresh: () => void };
const diagrams = new WeakMap<HTMLElement, Diagram>();
const cache = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0, observing = false;
const fontFamily = 'system-ui, "Microsoft YaHei", "PingFang SC", sans-serif';

function renderDiagram(source: string, dark: boolean): Promise<string> {
  const key = `${dark}\n${source}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const task = queue.catch(() => {}).then(async () => {
    // Diagram definitions are data. Never enable callbacks, HTML labels or
    // source-supplied CSS/configuration when viewing archived messages.
    if (source.length > 50000 || /(?:^|[;\n])\s*(?:classDef|style|linkStyle)\b[^\n]*url\s*\(/i.test(source)) throw new Error('Unsupported diagram');
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      maxTextSize: 50000, maxEdges: 400, htmlLabels: false, fontFamily,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'flowchart', 'sequence'],
      theme: 'base',
      themeVariables: {
        darkMode: dark, fontFamily, fontSize: '15px',
        background: dark ? '#1c2420' : '#ffffff',
        primaryColor: dark ? '#293c2e' : '#e9f0e8', primaryTextColor: dark ? '#d9e4dc' : '#2d3733',
        primaryBorderColor: dark ? '#789d81' : '#789780', lineColor: dark ? '#9abd9d' : '#65816e',
        secondaryColor: dark ? '#263a45' : '#edf4f8', tertiaryColor: dark ? '#413d29' : '#faf6e9',
        actorBkg: dark ? '#293c2e' : '#e9f0e8', actorBorder: dark ? '#789d81' : '#789780',
        actorTextColor: dark ? '#d9e4dc' : '#2d3733', actorLineColor: dark ? '#789d81' : '#789780',
        signalColor: dark ? '#bdcec2' : '#4c5d53', signalTextColor: dark ? '#d9e4dc' : '#2d3733',
        noteBkgColor: dark ? '#413d29' : '#faf6e9', noteTextColor: dark ? '#e6dfc4' : '#554c30',
      },
      flowchart: { htmlLabels: false, curve: 'basis', padding: 18, wrappingWidth: 280 },
      sequence: { useMaxWidth: true, wrap: true },
    });
    const { svg } = await mermaid.render(`vault-diagram-${++nextId}`, source);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'script'] });
  });
  queue = task;
  cache.set(key, task);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  task.catch(() => { cache.delete(key); });
  return task;
}

export function decorateMermaidDiagrams(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('pre > code[class~="language-mermaid" i]').forEach(code => {
    const pre = code.parentElement!;
    if (pre.closest('.mermaid-block,.dil-source')) return;
    const source = code.textContent || '';
    const block = document.createElement('section'); block.className = 'mermaid-block'; block.setAttribute('aria-label', 'Mermaid 图表');
    const toolbar = document.createElement('div'); toolbar.className = 'mermaid-toolbar';
    const title = document.createElement('span'); title.className = 'mermaid-kind';
    title.textContent = /^\s*sequenceDiagram\b/m.test(source) ? '时序图' : /^\s*(?:flowchart|graph)\b/m.test(source) ? '流程图' : 'Mermaid 图表';
    const button = (label: string) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; toolbar.append(b); return b; };
    toolbar.append(title);
    const graphButton = button('图表'), sourceButton = button('源码'), zoomOut = button('−'), zoomIn = button('+'), copy = button('复制源码');
    zoomOut.setAttribute('aria-label','缩小图表'); zoomIn.setAttribute('aria-label','放大图表');
    const panel = document.createElement('div'); panel.className = 'mermaid-preview'; panel.setAttribute('role','img'); panel.setAttribute('aria-label',title.textContent);
    const status = document.createElement('span'); status.className = 'mermaid-status'; status.setAttribute('role','status'); status.textContent = '正在绘制图表…';
    pre.querySelector('.code-copy')?.remove(); pre.classList.add('mermaid-source'); pre.hidden = true;
    pre.replaceWith(block); block.append(toolbar, panel, status, pre);
    let scale = 1, version = 0, renderedTheme = '', graphReady = false;
    const show = (graph: boolean) => {
      panel.hidden = !graph; pre.hidden = graph;
      graphButton.setAttribute('aria-pressed',String(graph)); sourceButton.setAttribute('aria-pressed',String(!graph));
      zoomIn.hidden = zoomOut.hidden = !graph;
    };
    graphButton.onclick = () => show(true); sourceButton.onclick = () => show(false); show(true);
    const zoom = (amount: number) => {
      scale = Math.max(.5, Math.min(3, scale + amount));
      const img = panel.querySelector('img');
      if (img) {
        img.style.width = `${scale * 100}%`;
        if (img.dataset.intrinsicWidth) img.style.maxWidth = `${Number(img.dataset.intrinsicWidth) * scale}px`;
      }
    };
    zoomIn.onclick = () => zoom(.25); zoomOut.onclick = () => zoom(-.25);
    copy.onclick = () => {
      navigator.clipboard.writeText(source).then(() => { status.textContent = '源码已复制'; }).catch(() => { status.textContent = '复制失败，请重试'; });
    };
    const refresh = async () => {
      const theme = document.documentElement.dataset.theme || 'light';
      if (renderedTheme === theme) return;
      renderedTheme = theme;
      const current = ++version;
      try {
        const svg = await renderDiagram(source, theme === 'dark');
        if (!block.isConnected || current !== version) return;
        // An SVG image keeps the generated diagram isolated from the page's
        // DOM, scripts, links and CSS, while retaining crisp zoomed rendering.
        const img = document.createElement('img'); img.alt = title.textContent!; img.draggable = false;
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        const svgRoot = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const width = Number(svgRoot.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2]) || Number(svgRoot.getAttribute('width'));
        if (Number.isFinite(width) && width > 0) { img.dataset.intrinsicWidth = String(width); img.style.maxWidth = `${width * scale}px`; }
        img.style.width = `${scale * 100}%`; panel.replaceChildren(img);
        graphButton.disabled = false; graphReady = true; status.textContent = '';
      } catch {
        if (!block.isConnected || current !== version) return;
        if (!graphReady) { show(false); graphButton.disabled = true; }
        status.textContent = '图表暂时无法渲染，可查看或复制源码。';
      }
    };
    diagrams.set(block, { source, refresh }); void refresh();
  });
  if (!observing) {
    observing = true;
    new MutationObserver(() => document.querySelectorAll<HTMLElement>('.mermaid-block').forEach(block => diagrams.get(block)?.refresh()))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}
