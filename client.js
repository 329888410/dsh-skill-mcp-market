// Client half of dsh-skill-mcp-market: a floating market panel registered into `shell.overlay`.
// No build step; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-skill-mcp-market',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const RPC = '/api/dsh-market/rpc';

    async function call(op, payload) {
      // A hung response must surface as an error instead of an endless spinner.
      const response = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload || {}) }),
        cache: 'no-store',
        signal: AbortSignal.timeout(300000),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `HTTP ${response.status}`);
      }
      return data;
    }

    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        color: 'var(--dsh-text-primary, #1f2328)',
      },
      launcher: {
        height: 40,
        padding: '0 16px',
        borderRadius: 20,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-surface, #ffffff)',
        color: 'inherit',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(0,0,0,.16)',
        fontWeight: 600,
      },
      panel: {
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      },
      pane: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      },
      dim: {
        padding: 24,
        color: '#888',
        fontSize: 14,
        textAlign: 'center',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsh-border, #eaeef2)',
        // 宿主面板容器才是真正的滚动容器时，只有 sticky 能让标签栏留在视口里
        position: 'sticky',
        top: 0,
        zIndex: 3,
        background: 'var(--dsh-surface, #ffffff)',
      },
      tab: (active) => ({
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: active ? 'var(--dsh-surface-raised, #f0f3f6)' : 'transparent',
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        color: 'inherit',
      }),
      // 管理面板内的二级页签：下划线式，与主 tab 的药丸形成层级差
      subTab: (active) => ({
        padding: '4px 10px',
        border: '0',
        borderBottom: '2px solid ' + (active ? 'var(--dsh-accent, #3b82f6)' : 'transparent'),
        background: 'transparent',
        fontWeight: active ? 700 : 500,
        fontSize: 12,
        cursor: 'pointer',
        color: 'inherit',
      }),
      body: {
        flex: 1,
        overflow: 'auto',
        padding: '12px 18px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        alignItems: 'stretch',
        // 更粗、更深的竖直滚动条（WebKit）
        scrollbarWidth: 'thin',
        scrollbarColor: '#5a636e #eef1f4',
        '&::-webkit-scrollbar': { width: '12px' },
        '&::-webkit-scrollbar-track': { background: '#f0f2f4' },
        '&::-webkit-scrollbar-thumb': {
          background: '#5a636e',
          borderRadius: 6,
          border: '2px solid #f0f2f4',
        },
        '&::-webkit-scrollbar-thumb:hover': { background: '#3d444d' },
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      // 搜索行吸顶：吸附在标签栏（约 48px）之下
      // 搜索栏固定：它和标签栏一样在滚动容器之外，滚动时永不移位

      // 类型 / 分类标签栏：与搜索栏同样在滚动容器之外，滚动时常驻
      filterBar: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '0 18px 8px 12px',
        borderBottom: '1px solid var(--dsh-border, #eaeef2)',
        background: 'var(--dsh-surface, #ffffff)',
      },
      searchBar: {

        display: 'flex',

        gap: 8,

        alignItems: 'center',

        padding: '8px 18px 8px 12px',

        borderBottom: '1px solid var(--dsh-border, #eaeef2)',

        background: 'var(--dsh-surface, #ffffff)',

      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, alignContent: 'start', alignItems: 'start' },
      chip: (active) => ({
        padding: '4px 10px',
        borderRadius: 999,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: active ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: active ? '#fff' : 'inherit',
      }),
      input: {
        flex: 1,
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: 'var(--dsh-input-bg, #fff)',
        color: 'inherit',
        font: 'inherit',
      },
      card: {
        minWidth: 220,
        border: '1px solid var(--dsh-border, #eaeef2)',
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      title: { fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      desc: { opacity: 0.75, fontSize: 12, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      meta: { display: 'flex', gap: 6, fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
      btn: (kind) => ({
        height: 28,
        padding: '0 10px',
        borderRadius: 7,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        border: '1px solid var(--dsh-border, #d0d7de)',
        background: kind === 'primary' ? 'var(--dsh-accent, #2f6feb)' : 'transparent',
        color: kind === 'primary' ? '#fff' : 'inherit',
      }),
      status: { fontSize: 12, opacity: 0.75 },
      err: { fontSize: 12, color: '#c62828' },
    };

    // 每个目录一行：多目录时逐行渲染，避免 \n 在 <input> 里被吞掉、两行粘成一行
    function setPathRows(label, values, onValues) {
      // values: 已换行拼接的字符串；每行一个目录，各占一行、各自可编辑，改完整块写回。
      const lines = String(values || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const write = (idx, text) => {
        const next = lines.slice();
        next[idx] = text;
        onValues(next.filter(Boolean).join('\n'));
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { width: 64, opacity: 0.7, fontSize: 12, alignSelf: 'flex-start', marginTop: 4 } }, label),
        lines.map((line, idx) =>
          h('input', {
            key: idx,
            style: { ...S.input, width: '100%' },
            value: line,
            onChange: (e) => write(idx, e.target.value),
          }))
      );
    }
    function Market(props) {
      const [tab, setTab] = useState('skills');
      // 管理面板子页签：记忆上次停留页（参照 dsh-skill-mcp-panel 的 last-tab 模式），
      // localStorage 不可用时静默退化为技能页。
      const MANAGE_TAB_KEY = 'dsh-market:manage-tab';
      const readManageTab = () => {
        try { return localStorage.getItem(MANAGE_TAB_KEY) === 'mcp' ? 'mcp' : 'skill'; } catch { return 'skill'; }
      };
      const [manageTab, setManageTab] = useState(readManageTab);
      const switchManageTab = (next) => {
        setManageTab(next);
        try { localStorage.setItem(MANAGE_TAB_KEY, next); } catch { /* 隐私模式等场景静默 */ }
      };
      const [query, setQuery] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      // MCP 安装/保存的实时进度：{ serverName, waitedMs, tools } | null
      const [installProgress, setInstallProgress] = useState(null);
      const [skills, setSkills] = useState([]);
      const [mcps, setMcps] = useState([]);
      const [installed, setInstalled] = useState([]);
      const [mounted, setMounted] = useState([]);
      const [settings, setSettings] = useState(null);
      const [skillDraft, setSkillDraft] = useState('');
      const [mcpDraft, setMcpDraft] = useState('');
      // { slug, missing: string[] } — the connector needs values before it can start
      const [envPrompt, setEnvPrompt] = useState(null);
      const [envDraft, setEnvDraft] = useState({});
      // { kind: 'skill'|'mcp', slug, data } — detail drawer with the edit form
      const [detail, setDetail] = useState(null);
      const [draft, setDraft] = useState({});
      // searchSkills/searchMcps 的 useCallback 依赖是 []，直接读 state 会闭包住首帧的值。


      const [source, setSource] = useState('clawhub');
      const [mcpSource, setMcpSource] = useState('registry');
      const [mcpCategory, setMcpCategory] = useState('all');
      const [mcpSort, setMcpSort] = useState('default');
      const [mcpPage, setMcpPage] = useState(1);
      const [mcpTotalPages, setMcpTotalPages] = useState(0);
      const [mcpHasMore, setMcpHasMore] = useState(false);
      const [mcpTotal, setMcpTotal] = useState(0);
      const [mcpCategories, setMcpCategories] = useState([]);
      const [size, setSize] = useState(24);
      const [sort, setSort] = useState('default');
      const [category, setCategory] = useState('all');
      const [pageJump, setPageJump] = useState('');
      const [mcpPageJump, setMcpPageJump] = useState('');
      // 过滤词按子页签拆开：旧实现一个词同时过滤技能与 MCP，切页签互相污染
      const [manageSkillFilter, setManageSkillFilter] = useState('');
      const [manageMcpFilter, setManageMcpFilter] = useState('');
      const [collapsedGroups, setCollapsedGroups] = useState(() => {
      // searchSkills/searchMcps 的 useCallback 依赖是 []，直接读 state 会闭包住首帧的值；


        // 折叠偏好跨面板重挂载与刷新保留；拒绝存储的浏览器只是不记忆
        try {
          const raw = window.localStorage.getItem('dsh-skill-mcp-market.collapsedGroups');
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      });
      // 这面镜子在每次渲染时同步最新选择，回调里读它拿到的是当前值而不是初值。
      const liveRef = useRef({});
      liveRef.current = { source, category, size, mcpSource, mcpCategory, mcpSort };
      // 会话日志体检：检测并修复「空 tool-call」导致的会话永久损坏
      const [sessionScan, setSessionScan] = useState(null);
      const [sessionBusy, setSessionBusy] = useState('');
      // 回收站：列出/恢复/清空（删除是移入 .trash，不是真删）
      const [trashList, setTrashList] = useState(null);
      // MCP 连接器回收站：卸载已把定义写入 <mcpDir>/.trash，这里把它显性化并可恢复
      const [mcpTrashList, setMcpTrashList] = useState(null);
      const [mcpTrashBusy, setMcpTrashBusy] = useState('');
      const [trashBusy, setTrashBusy] = useState('');
      // 最近一次的查询结果缓存（按 tab+source+category+sort+query 作 key），
      // 切源/改查询时若命中就立即渲染缓存、后台再刷新，避免每次切源都白屏重查。
      const resultCacheRef = useRef({});
      const [nativeDirs, setNativeDirs] = useState([]);
      // 技能市场的分页：每个源都支持真正的翻页，页数/总数由后端这一页返回的元数据决定
      const [skillsPage, setSkillsPage] = useState(1);
      const [skillsTotalPages, setSkillsTotalPages] = useState(1);
      const [skillsTotal, setSkillsTotal] = useState(0);
      const [skillsHasMore, setSkillsHasMore] = useState(false);

      const gotoPage = (p) => {
        p = Math.max(1, Math.min(p, 1 << 30));
        if (tab === 'skills') searchSkills(query, { source, size, page: p });
        else searchMcps(query, { page: p });
      };

      const pager = (page, totalPages, hasMore, label, jumpState, setJumpState, windowed = true) => {
        const unknown = !totalPages; // 注册表按 cursor 走，没有可数的总页数
        const n = unknown ? 0 : Math.max(1, Math.trunc(totalPages) || 1);
        const shown = Math.min(page, n || page);
        // 页码窗口：windowed=true 时固定显示当前页前后各 5 页；windowed=false 时显示全部页码
        // 页码窗口：已知总数时显示当前页±5（省略号折叠）；未知总数时只显示±2
        const pageItems = (function () {
          const items = [];
          const push = (v) => items.push(v);
          const span = 5; // 统一 ±5 窗口
          if (n === 0) {
            for (let i = Math.max(1, page - span); i <= page + span; i += 1) if (i >= 1) push(i);
            return items;
          }
          // 已知总数：1 … window … N
          const lo = Math.max(2, page - span);
          const hi = Math.min(n - 1, page + span);
          push(1);
          if (lo > 2) push('…');
          for (let i = lo; i <= hi; i += 1) push(i);
          if (hi < n - 1) push('…');
          if (n > 1) push(n);
          return items;
        })();
        const pageButtons = pageItems.map((v) =>
          v === '…'
            ? h('span', { key: 'ellipsis-' + v, style: { padding: '0 4px', opacity: 0.5 } }, '…')
            : h('button', {
              key: `pg${v}`,
              style: S.btn(v === page ? 'primary' : undefined),
              disabled: busy !== '' || v === page,
              onClick: () => gotoPage(v),
            }, String(v)));
        return h('div', { style: { ...S.row, justifyContent: 'space-between', padding: '4px 2px' } },
          h('div', { style: S.row },
            h('button', {
              style: S.btn(),
              disabled: page <= 1 || busy !== '',
              onClick: () => gotoPage(page - 1),
            }, '‹ 上一页'),
            pageButtons,
            h('button', {
              style: S.btn(),
              disabled: (unknown ? !hasMore : page >= n) || busy !== '',
              onClick: () => gotoPage(page + 1),
            }, '下一页 ›')),
          h('div', { style: S.row },
            h('span', { style: S.status },
              unknown
                ? `${label ? label + " · " : ""}第 ${page} 页（${hasMore ? '可继续加载' : '已是最后一页'}）`
                : `${label ? label + " " : ""}第 ${page} / ${n} 页`),
            h('span', { style: { fontSize: 12, opacity: 0.6, marginLeft: 8 } }, '跳至'),
            h('input', {
              style: { ...S.input, width: 56, height: 26, textAlign: 'center' },
              type: 'number',
              min: 1,
              max: unknown ? '' : n,
              value: jumpState,
              placeholder: String(page),
              onChange: (e) => setJumpState(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') {
                  const p = Math.max(1, Math.trunc(Number(jumpState) || page));
                  if (!unknown && p > n) return;
                  setJumpState('');
                  gotoPage(p);
                }
              },
              onBlur: () => {
                if (jumpState) {
                  const p = Math.max(1, Math.trunc(Number(jumpState) || page));
                  setJumpState('');
                  gotoPage(p);
                }
              },
            })));
      };

      const loadInstalled = useCallback(async () => {
        const [s, m] = await Promise.all([call('skills.list'), call('mcp.list')]);
        setInstalled(s.items || []);
        setMounted(m.items || []);
        return { s, m };
      }, []);

      const loadSettings = useCallback(async () => {
        const d = await call('settings.get');
        setSettings(d);
        setSkillDraft((d.settings.skillDirs || []).join('\n'));
        setMcpDraft((d.settings.mcpDirs || []).join('\n'));
        setNativeDirs(d.settings.dshNativeSkillDirs || []);
      }, []);

      const searchSkills = useCallback(async (text, options) => {
        // 回落到当前选中的源——否则回车/点「搜索」会退化成「全部来源」聚合
        const src = (options && options.source) || liveRef.current.source;
        const cat = (options && options.category) || liveRef.current.category || 'all';
        const q = String(text || '');
        const pageNo = (options && options.page) || 1;
        const append = Boolean(options && options.append);
        // 只有「首页」进缓存；翻页是增量追加，缓存它没有意义还会撑爆内存
        const effSort = sort === 'default' ? 'installCount' : (sort === 'name' ? 'name' : '');
        const cacheKey = append ? '' : `sk|${src}|${q}|${cat}|${pageNo}|${effSort}`;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        // 命中缓存：立即渲染旧结果，不白屏；后台再刷新
        if (cached) {
          setSkills(cached.items || []);
          setSkillsPage(1);
          setSkillsTotalPages(cached.pages || 0);
          setSkillsTotal(cached.total || (cached.items || []).length);
          setSkillsHasMore(Boolean(cached.hasMore));
          if ((cached.items || []).length) setNotice('（缓存，正在刷新…）');
        } else if (!append) {
          setBusy('skills.search');
        }
        setError('');
        try {
          const d = await call('skills.search', {
            query: text,
            source: src,
            category: cat === 'all' ? '' : cat,
            page: pageNo,
            pageSize: (options && options.size) || size,
            sort: effSort,
          });
          const rows = d.items || [];
          if (cacheKey) {
            resultCacheRef.current[cacheKey] = {
              items: rows,
              pages: d.pages,
              total: d.total,
              hasMore: d.hasMore,
              hints: d.hints || [],
              degraded: d.degraded || [],
            };
          }
          if (append) {
            // 追加去重：翻页边界上偶尔会重复返回同一条，去重后列表才不会原地重复
            setSkills((prev) => {
              const seen = new Set(prev.map((x) => x.id));
              return prev.concat(rows.filter((x) => !seen.has(x.id)));
            });
          } else {
            setSkills(rows);
          }
          setSkillsPage(d.page || pageNo);
          setSkillsTotalPages(d.pages || 0); // 0 = 未知总页数，pager 走窗口式
          setSkillsTotal(Number(d.total) || rows.length);
          setSkillsHasMore(Boolean(d.hasMore));
          const hints = (d.hints || []).filter(Boolean);
          if (!(d.items || []).length) {
            // An empty market is either "no match", "needs a keyword" or "upstream refused us".
            const reasons = (d.sourceErrors || []).length
              ? d.sourceErrors
              : hints.length
                ? hints
                : (d.degraded || []).length
                  ? [`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`]
                  : ['没有找到匹配的技能。'];
            setNotice(reasons.join('；'));
          } else if (hints.length) {
            setNotice(hints.join('；'));
          } else if ((d.degraded || []).length) {
            setNotice(`部分来源不可用：${d.degraded.map((x) => x.source).join(', ')}`);
          } else {
            setNotice('');
          }
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      }, [sort, liveRef, source, size]);

      const searchMcps = useCallback(async (text, options) => {
        const opts = options || {};
        const nextSource = opts.source || mcpSource;
        const nextCategory = opts.category !== undefined ? opts.category : mcpCategory;
        const nextSort = opts.sort !== undefined ? opts.sort : mcpSort;
        const nextPage = opts.page || 1;
        const nextSize = opts.size !== undefined ? opts.size : size;
        // 首屏查询（非 append）命中缓存时立即渲染旧结果，后台再刷新，避免切源白屏
        const cacheKey = opts.append ? '' : `mc|${nextSource}|${nextCategory === 'all' ? '' : nextCategory}|${nextSort === 'default' ? '' : nextSort}|${String(text || '')}|${nextPage}|${nextSize}`;
        const cached = cacheKey ? resultCacheRef.current[cacheKey] : null;
        if (cached) {
          setMcps(cached.items || []);
          setNotice('（缓存，正在刷新…）');
        } else {
          setBusy('mcp.search');
        }
        setError('');
        try {
          const d = await call('mcp.search', {
            query: text,
            source: nextSource,
            category: nextCategory === 'all' ? '' : nextCategory,
            sort: nextSort === 'default' ? '' : nextSort,
            page: nextPage,
            size: nextSize,
          });
          const rows = d.items || [];
          if (cacheKey) resultCacheRef.current[cacheKey] = { items: rows, categories: d.categories || [] };
          // Append must not repeat a card: the registry pages by version rows, so a server
          // may legitimately return a slug that is already on screen.
          setMcps(opts.append
            ? (prev) => {
                const seen = new Set(prev.map((m) => m.id || m.slug));
                return prev.concat(rows.filter((m) => !seen.has(m.id || m.slug)));
              }
            : rows);
          setMcpPage(d.page || nextPage);
          // totalPages 0 means the source cannot count pages (the registry is cursor-based);
          // canLoadMore is then the only honest signal.
          setMcpTotalPages(d.totalPages || 0);
          setMcpHasMore(d.canLoadMore !== undefined
            ? Boolean(d.canLoadMore)
            : (d.page || nextPage) < (d.totalPages || 1));
          setMcpTotal(d.total || rows.length);
          setMcpCategories(d.categories || []);
          // The host reports catalogue degradation separately from "no match", so both the
          // reason and the still-usable path (install by registry name) reach the user.
          if (d.hint) setNotice(d.hint);
          else if (!(d.items || []).length) setNotice('没有找到匹配的连接器；可直接按注册表名称安装，例如 io.github.Async23/chrome-devtools-mcp。');
          else setNotice('');
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      }, []);

      useEffect(() => {
        setError('');
        setNotice('');
        // 旧实现：任何 tab 都 loadInstalled + else 分支必打一次 MCP 市场搜索（3-40s 的无谓查询）。
        // 收紧为按需：installed 数据只在管理页需要；searchMcps 只在 MCP 市场页需要。
        loadSettings().catch((e) => setError(String(e.message || e)));
        if (tab === 'manage') loadInstalled().catch((e) => setError(String(e.message || e)));
        if (tab === 'skills') searchSkills('', { source, size });
        else if (tab === 'mcp') searchMcps('', { size });
      }, [tab, loadSettings, loadInstalled, searchSkills, searchMcps]);

      // 排序变了 → 重新拉取当前 tab 的数据（不同排序返回不同顺序/结果）
      const prevSortRef = useRef(sort);
      useEffect(() => {
        if (tab !== 'skills' || sort === prevSortRef.current) return;
        prevSortRef.current = sort;
        setSkills([]);
        searchSkills('', { source, size, page: 1 });
      }, [sort, tab]);

      const openSkillDetail = async (slug) => {
        setBusy(`detail:${slug}`);
        setError('');
        try {
          const data = await call('skills.detail', { slug });
          setDetail({ kind: 'skill', slug, data });
          setDraft({ name: slug, description: '', body: data.content });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const openMcpDetail = async (serverName) => {
        setBusy(`detail:${serverName}`);
        setError('');
        try {
          const data = await call('mcp.detail', { serverName });
          setDetail({ kind: 'mcp', slug: serverName, data });
          setDraft({ command: data.command, args: (data.args || []).join('\n'), url: data.url });
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const saveSkillEdit = async () => {
        setBusy('save:skill');
        setError('');
        try {
          const saved = await call('skills.update', {
            slug: detail.slug,
            name: draft.name,
            description: draft.description || undefined,
            body: draft.body,
          });
          setNotice(`已保存 ${saved.slug}（${saved.path}），下一步技能目录即刷新`);
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const saveMcpEdit = async () => {
        setBusy('save:mcp');
        setError('');
        try {
          const result = await call('mcp.update', {
            serverName: detail.slug,
            patch: {
              command: draft.command,
              args: String(draft.args || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
              url: draft.url,
            },
          });
          if (result.ok) {
            setNotice(`已保存并重连 ${detail.slug}，${result.tools.length} 个工具`);
          } else if (result.pending) {
            // 已挂载但还在启动：轮询实时工具表给终局（npx 冷启动可远超 8s）
            setNotice(`已保存 ${detail.slug}，正在重启连接器…`);
            const final = await waitForTools(detail.slug);
            if (final.ok) setNotice(`已保存并重连 ${detail.slug}，${final.toolCount} 个工具（等待 ${Math.round(final.waitedMs / 1000)}s）`);
            else if (final.timedOut) setNotice(`${detail.slug} 超过 ${Math.round(MAX_PROGRESS_MS / 1000)}s 仍未发布工具，请稍后刷新查看`);
            else setNotice(`已保存，但未连上：${result.error || ''}`);
          } else {
            setNotice(`已保存，但未连上：${result.error || ''}`);
          }
          setDetail(null);
          await loadInstalled();
        } catch (e) {
          setError(`保存失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

;

      // 各源详情页 URL 推导（统一通过 DSH 内置 sidebar-right browser tab 打开）。
      // 每个源都要给出可打开的地址：全部源的全部技能卡片都必须有「详情」按钮。
      const detailUrlFor = (item) => {
        if (!item) return '';
        const source = item.source;
        const slug = String(item.slug || '').toLowerCase();
        const owner = String(item.owner || '').replace(/^@/, '');
        const homepage = typeof item.homepage === 'string' && /^https?:\/\//i.test(item.homepage) ? item.homepage : '';
        const upstream = String(item.upstreamUrl || '').replace(/^@/, '');
        if (source === 'skillhub') {
          // homepage 指向 api.skillhub.cn 接口地址，可浏览的详情页在 www 站。
          if (slug) return `https://www.skillhub.cn/skills/${slug}`;
          return homepage;
        }
        if (source === 'skillsmp') {
          // upstreamUrl 格式为 owner/repo@branch，取 @ 前的部分拼 GitHub URL。
          const repo = upstream.split('@')[0];
          if (repo) return `https://github.com/${repo}`;
          return homepage;
        }
        if (homepage) return homepage;
        if (source === 'skills.sh') {
          return upstream && slug ? `https://www.skills.sh/${upstream}/${slug}` : '';
        }
        if (source === 'clawhub') {
          return owner && slug ? `https://clawhub.ai/${owner}/${slug}` : '';
        }
        if (source === 'browse.sh') {
          return slug ? `https://browse.sh/skills/${owner ? owner + '/' : ''}${slug}` : '';
        }
        if (source === 'modelscope') {
          const ident = item.modelScopeIdent || '';
          return ident ? `https://modelscope.cn/skills/${ident}` : '';
        }
        if (upstream) return `https://github.com/${upstream}`;
        return '';
      };

      // 在 DSH 内置 sidebar-right browser tab 中打开详情页（绝不使用系统浏览器）。
      // 右侧栏按 Session 挂载：市场面板占满主列时没有挂载的 Session，openTab 会拒绝。
      // 先回到会话（selectPanel(null)），再打开内置浏览器 tab；永远不回退到系统浏览器。
      // 详情页以停靠 tab 呈现（不展开右侧栏、不用浮窗，避免同时弹出侧边栏+浮窗的突兀感）。
      const openDetail = (item) => {
        const url = detailUrlFor(item);
        if (!url) {
          setError('该条目没有可打开的详情页');
          return;
        }
        const sr = props && props.sidebarRight;
        if (!sr || typeof sr.openTab !== 'function') {
          setError('当前环境没有 DSH 内置浏览器（sidebarRight 不可用）');
          return;
        }
        const tryOpen = () => {
          try {
            sr.openTab('browser', { params: { url } });
            return true;
          } catch {
            return false;
          }
        };
        if (tryOpen()) return;
        // 全局面板（市场）没有挂载 Session → 回到会话，再重试
        try {
          if (props.layout && typeof props.layout.selectPanel === 'function') props.layout.selectPanel(null);
        } catch { /* layout service unavailable */ }
        const retry = (left) => {
          if (tryOpen()) return;
          if (left > 0 && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => retry(left - 1));
            return;
          }
          setError('无法在 DSH 内置浏览器中打开详情：右侧栏当前不可用');
        };
        retry(40);
      };

      const doInstallSkill = async (item) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('skills.install', {
            source: item.source,
            // 每个源产出的 installRef 已在 handler 里统一（见 src/sources.js installRefOf）。
            // 这里只做最后兜底，不再堆叠 per-source 三元。
            reference: item.installRef || item.upstreamUrl || item.id,
            upstreamUrl: item.source === 'modelscope' ? (item.upstreamUrl || '') : '',
            skillDir: item.skillDir || (item.source === 'skills.sh' ? (item.slug || '') : ''),
            ref: item.ref || '',
            name: item.slug,
          });
          setNotice(`已安装 ${d.slug} → ${d.dir}（${d.files} 个文件，已生效）`);
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      // 探针只是快速确认；真正的终局由轮询 mcp.list 的实时工具表给出。
      // RPC 分发实测并发（慢查询进行中 settings.get 仍 4ms 返回），轮询不会排队等待。
      const MAX_PROGRESS_MS = 120000;
      const POLL_INTERVAL_MS = 600;
      const waitForTools = (serverName) => new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(async () => {
          const waitedMs = Date.now() - started;
          setInstallProgress({ serverName, waitedMs, tools: 0 });
          if (waitedMs > MAX_PROGRESS_MS) {
            clearInterval(timer);
            setInstallProgress(null);
            resolve({ ok: false, timedOut: true, waitedMs });
            return;
          }
          try {
            const d = await call('mcp.list', {});
            const hit = (d.items || []).find((x) => x.serverName === serverName);
            const tools = (hit && hit.tools) || [];
            if (tools.length > 0) {
              clearInterval(timer);
              setInstallProgress(null);
              resolve({ ok: true, toolCount: tools.length, waitedMs });
            } else {
              setInstallProgress({ serverName, waitedMs, tools: 0 });
            }
          } catch { /* 单次轮询失败就等下一轮 */ }
        }, POLL_INTERVAL_MS);
      });

      const doInstallMcp = async (item, envValues) => {
        setBusy(`install:${item.slug}`);
        setError('');
        setNotice('');
        try {
          const d = await call('mcp.install', { slug: item.slug, envValues: envValues || {} });
          const r = (d.results || [])[0] || {};
          if (r.missing && r.missing.length) {
            setEnvPrompt({ slug: item.slug, missing: r.missing });
            setEnvDraft({});
            setNotice(`该连接器需要 ${r.missing.join(', ')}；填好后会写入系统环境变量并立即连接`);
          } else if (r.ok) {
            setEnvPrompt(null);
            setNotice(`已连接 ${r.serverName}，新增 ${r.toolCount} 个工具${(r.envWritten || []).length ? `（已写入环境变量 ${r.envWritten.join(', ')}）` : ''}`);
          } else if (r.pending) {
            // 已挂载但还没发布工具：npx 首次运行要先下载依赖，继续轮询出真实结果
            setNotice(`已保存 ${r.serverName}，正在启动…（${r.error || '首次运行需下载依赖'}）`);
            const final = await waitForTools(r.serverName);
            if (final.ok) setNotice(`已连接 ${r.serverName}，新增 ${final.toolCount} 个工具（等待 ${Math.round(final.waitedMs / 1000)}s）`);
            else if (final.timedOut) setNotice(`${r.serverName} 超过 ${Math.round(MAX_PROGRESS_MS / 1000)}s 仍未发布工具，请稍后在「管理 → MCP 连接器」刷新查看，或检查启动命令`);
            else setNotice(`已保存 ${r.serverName}，但未连上：${r.error || ''}`);
          } else {
            setNotice(`已保存 ${r.serverName}，但未连上：${r.error || ''}`);
          }
          await loadInstalled();
        } catch (e) {
          setError(`安装失败：${e.message || e}`);
        } finally {
          setBusy('');
        }
      };

      const toggleGroupCollapsed = (key) => {
        setCollapsedGroups((prev) => {
          const next = { ...prev };
          if (next[key]) delete next[key];
          else next[key] = true;
          try {
            window.localStorage.setItem('dsh-skill-mcp-market.collapsedGroups', JSON.stringify(next));
          } catch {
            /* storage refused: the view still collapses for this render */
          }
          return next;
        });
      };

      const toggleSkill = async (slug, enabled, scope) => {
        setBusy(`toggle:${slug}`);
        setError('');
        try {
          const d = await call('skills.toggle', { slug, enabled, scope: scope || 'auto' });
          const scopeText = d && d.scope === 'file'
            ? (enabled ? '文件级：已移除禁用标记，模型可再次调用' : '文件级：已写入禁用标记，模型不再调用')
            : '面板级：仅本面板隐藏，宿主注册表仍会加载该技能';
          setNotice(`${enabled ? '已启用' : '已停用'} ${slug}（${scopeText}）`);
          await loadSettings();
          setSettings((prev) => (prev ? { ...prev, settings: { ...prev.settings } } : prev));
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const toggleMcp = async (name, enabled) => {
        setBusy(`toggle:${name}`);
        setError('');
        try {
          await call('mcp.toggle', { serverName: name, enabled });
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const removeSkill = async (slug) => {
        setBusy(`remove:${slug}`);
        try {
          await call('skills.uninstall', { slug, confirm: true });
          await loadInstalled();
          await searchSkills(query);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const savePaths = async () => {
        setBusy('settings.set');
        setError('');
        try {
          const d = await call('settings.set', {
            skillDirs: skillDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
            mcpDirs: mcpDraft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          });
          setNotice(`路径已更新（技能 ${d.skillDirs.length} 个 / MCP ${d.mcpDirs.length} 个），已即时重挂`);
          await loadSettings();
          await loadInstalled();
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      // 回收站：skills.trash / skills.restore / skills.trashEmpty
      const loadTrash = async () => {
        setTrashBusy('list');
        setError('');
        try {
          const d = await call('skills.trash', {});
          setTrashList(d);
          setNotice(`回收站共 ${d.items.length} 项`);
        } catch (e) {
          setError(`读取回收站失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };
      // 回收站是技能侧的常驻区块：进入管理-技能子页签自动拉一次（失败不打扰用户，
      // 手动「读取回收站」按钮仍在原位兜底）。必须定义在 loadTrash 之后——
      // useEffect 的依赖数组在渲染时求值，提前引用 const 会触发 TDZ（实测白屏）。
      useEffect(() => {
        if (tab === 'manage' && manageTab === 'skill' && trashList === null && !trashBusy) {
          loadTrash().catch(() => {});
        }
      }, [tab, manageTab, trashList, trashBusy, loadTrash]);

      // MCP 子页签同理：首次进入自动拉一次回收站（定义在 loadMcpTrash 之后，避免 TDZ）
      useEffect(() => {
        if (tab === 'manage' && manageTab === 'mcp' && mcpTrashList === null && !mcpTrashBusy) {
          loadMcpTrash().catch(() => {});
        }
      }, [tab, manageTab, mcpTrashList, mcpTrashBusy, loadMcpTrash]);

      const loadMcpTrash = async () => {
        setMcpTrashBusy('list');
        setError('');
        try {
          const d = await call('mcp.trash', {});
          setMcpTrashList(d);
          setNotice(`MCP 回收站共 ${d.items.length} 项`);
        } catch (e) {
          setError(`读取 MCP 回收站失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };

      const restoreMcpTrashEntry = async (entry) => {
        setMcpTrashBusy(`restore:${entry.path}`);
        setError('');
        setNotice('');
        try {
          const r = await call('mcp.restore', { path: entry.path });
          setNotice(r.aliased
            ? `已恢复为 ${r.serverName}（同名定义已存在，改用别名避免覆盖）`
            : `已恢复 ${r.serverName}，连接器已重新挂载`);
          await loadMcpTrash();
          await loadInstalled();
        } catch (e) {
          setError(`恢复失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };

      const emptyMcpTrash = async () => {
        setMcpTrashBusy('empty');
        setError('');
        setNotice('');
        try {
          const r = await call('mcp.trashEmpty', { confirm: true });
          setNotice(`已清空 MCP 回收站，删除 ${r.removed} 项（不可恢复）`);
          await loadMcpTrash();
        } catch (e) {
          setError(`清空失败：${e.message || e}`);
        } finally {
          setMcpTrashBusy('');
        }
      };

      const restoreTrashEntry = async (entry) => {
        setTrashBusy(`restore:${entry.path}`);
        setError('');
        setNotice('');
        try {
          const r = await call('skills.restore', { path: entry.path });
          setNotice(`已恢复 ${r.slug} → ${r.restoredTo}`);
          await loadTrash();
          await loadInstalled();
        } catch (e) {
          setError(`恢复失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };

      const emptyTrashAll = async () => {
        setTrashBusy('empty');
        setError('');
        setNotice('');
        try {
          const r = await call('skills.trashEmpty', { confirm: true });
          setNotice(`已清空回收站，删除 ${r.removed} 项（不可恢复）`);
          setTrashList({ items: [] });
        } catch (e) {
          setError(`清空失败：${e.message || e}`);
        } finally {
          setTrashBusy('');
        }
      };

      // 会话日志体检：sessions.scan 列出 + 深度检测；sessions.repair 修复
      const scanSessions = async (deep) => {
        setSessionBusy(deep ? 'scan-deep' : 'scan');
        setError('');
        setNotice('');
        try {
          const d = await call('sessions.scan', { deep: Boolean(deep), limit: 60 });
          setSessionScan(d);
          setNotice(`扫描 ${d.count} 个会话日志${deep ? `，发现 ${d.corrupt} 个损坏` : ''}`);
        } catch (e) {
          setError(`会话体检失败：${e.message || e}`);
        } finally {
          setSessionBusy('');
        }
      };

      const repairSession = async (file, dryRun) => {
        setSessionBusy(`repair:${file}`);
        setError('');
        setNotice('');
        try {
          const r = await call('sessions.repair', { file, dryRun: Boolean(dryRun), confirm: !dryRun });
          if (dryRun) {
            setNotice(r.corruption
              ? `预演：${r.sessionId} 在 seq ${r.corruption.seq} 处损坏（${r.corruption.reason}），将保留 ${r.keepEvents}/${r.eventsBefore} 条`
              : `预演：${r.sessionId} 未发现损坏`);
          } else if (r.repaired) {
            setNotice(`已修复 ${r.sessionId}：丢弃 ${r.dropped} 条坏事件，保留 ${r.keepEvents} 条；原文件备份为 ${r.backup}`);
            await scanSessions(true);
          } else {
            setNotice(`${r.sessionId} 未发现损坏，无需修复`);
          }
        } catch (e) {
          setError(`修复失败：${e.message || e}`);
        } finally {
          setSessionBusy('');
        }
      };

      const orderedSkills = skills.slice().sort((a, b) => {
        if (sort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        if (b.installable !== a.installable) return (b.installable === false ? 0 : 1) - (a.installable === false ? 0 : 1);
        return (b.installs || 0) - (a.installs || 0);
      });
      const categories = [...new Set(skills.map((item) => item.category).filter(Boolean))].slice(0, 10);
      const visibleSkills = orderedSkills.filter((item) => category === 'all' || item.category === category);
      const skillCards = visibleSkills.map((item) =>
        h('div', { key: item.id, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.sourceLabel || item.source),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installs ? h('span', null, `· ${item.installs.toLocaleString()} 次安装`) : null,
            item.stars ? h('span', null, `· ★ ${Number(item.stars).toLocaleString()}`) : null,
            item.describedBy === 'page-meta' ? null : null,
            item.installable === false ? h('span', null, '· 仅可浏览') : null),
          h('div', { style: S.row },
            h('button', {
              style: { ...S.btn(), padding: '0 6px' },
              title: detailUrlFor(item) ? '在 DSH 内置浏览器中查看详情' : '该条目没有可打开的详情页',
              disabled: !detailUrlFor(item),
              onClick: () => openDetail(item),
            }, '详情'),
            installed.some((x) => x.slug === item.slug)
              ? h('span', { style: S.status }, '✓ 已安装')
              : item.installable === false
                ? h('span', { style: S.status }, item.note || '该条目没有可用的下载源')
                : h('button', {
                  style: S.btn('primary'),
                  disabled: busy === `install:${item.slug}` || item.installable === false,
                  onClick: () => doInstallSkill(item),
                }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const orderedMcps = mcps.slice().sort((a, b) => {
        if (mcpSort === 'name') return String(a.name || a.slug).localeCompare(String(b.name || b.slug));
        if (mcpSort === 'installCount') return (b.installs || 0) - (a.installs || 0);
        if (mcpSort === 'ratingAverage') return (b.rating || 0) - (a.rating || 0);
        return 0;
      });
      const mcpCards = orderedMcps.map((item) =>
        h('div', { key: item.id || item.slug, style: S.card },
          h('div', { style: S.title }, item.name || item.slug),
          h('div', { style: S.desc }, item.description || ''),
          h('div', { style: S.meta },
            h('span', null, item.transport || 'stdio'),
            h('span', null, `· ${item.sourceLabel || (item.source === 'lobehub' ? 'LobeHub' : 'MCP 官方注册表')}`),
            item.owner ? h('span', null, `· ${item.owner}`) : null,
            item.category ? h('span', null, `· ${item.category}`) : null,
            item.installs ? h('span', null, `· ${Number(item.installs).toLocaleString()} 次安装`) : null,
            item.stars ? h('span', null, `· ★ ${Number(item.stars).toLocaleString()}`) : null,
            (item.envRequired || []).length ? h('span', null, `· 需要 ${item.envRequired.join(', ')}`) : null),
          // "name" is the registry identifier users may need to copy into a manual install.
          h('div', { style: S.meta }, h('span', null, item.slug)),
          item.note ? h('div', { style: S.status }, item.note) : null,
           h('div', { style: S.row },
             detailUrlFor(item) ? h('button', {
               style: { ...S.btn(), padding: '0 6px' },
               title: detailUrlFor(item) ? '在 DSH 内置浏览器中查看详情' : '该条目没有可打开的详情页',
               disabled: !detailUrlFor(item),
               onClick: () => openDetail(item),
             }, '详情') : null,
             h('button', {
               style: S.btn('primary'),
               disabled: item.installable === false || busy === `install:${item.slug}`,
               onClick: () => doInstallMcp(item),
              }, busy === `install:${item.slug}` ? '安装中…' : '安装'))));

      const CATEGORY_LABELS = {
        developer: '开发者',
        'developer-tools': '开发者工具',
        development: '开发',
        'data-analytics': '数据分析',
        database: '数据库',
        search: '搜索',
        'web-search': '网页搜索',
        'media-generate': '媒体生成',
        productivity: '效率办公',
        business: '商业服务',
        finance: '金融',
        tools: '实用工具',
        utility: '实用工具',
        'travel-transport': '出行交通',
        social: '社交',
        communication: '通信',
        cloud: '云服务',
        security: '安全',
        education: '教育',
        'education-science': '教育科研',
        'gaming-entertainment': '游戏娱乐',
        'health-wellness': '健康',
        healthcare: '医疗',
        news: '新闻',
        research: '研究',
        'real-estate': '房产',
        shopping: '购物',
        services: '服务',
        hardware: '硬件',
        networking: '网络',
        government: '政务',
        legal: '法律',
        industrial: '工业',
        robotics: '机器人',
        lifestyle: '生活',
        entertainment: '娱乐',
        blockchain: '区块链',
        'home-automation': '智能家居',
        'jobs-search': '招聘',
        science: '科学',
      };
      const categoryLabel = (code) => CATEGORY_LABELS[code] || code;
      const disabledSet = new Set(((settings && settings.settings && settings.settings.disabledSkills) || []).map((x) => String(x).toLowerCase()));
      // 两个子页签各用各的过滤词
      const skillFilterText = manageSkillFilter.trim().toLowerCase();
      const mcpFilterText = manageMcpFilter.trim().toLowerCase();
      const filteredInstalled = skillFilterText
        ? installed.filter((i) => (i.name || i.slug || '').toLowerCase().includes(skillFilterText) || (i.description || '').toLowerCase().includes(skillFilterText))
        : installed;
      const filteredMounted = mcpFilterText
        ? mounted.filter((i) => (i.title || i.serverName || '').toLowerCase().includes(mcpFilterText) || (i.description || '').toLowerCase().includes(mcpFilterText))
        : mounted;
      // 单张已装技能卡片（分组渲染时复用）
      const renderInstalledCard = (item) => {
        const off = disabledSet.has(String(item.slug).toLowerCase());
        // fileToggle 表示这个技能的 SKILL.md 可写（文件级真生效）；否则只能面板级隐藏
        const fileToggle = item.fileToggleable !== false;
        return h('div', { key: `i-${item.dir}-${item.slug}`, style: { ...S.card, opacity: item.shadowedBy ? 0.55 : 1 } },
          h('div', { style: S.title }, `${item.name || item.slug}${off ? '（已停用）' : ''}${item.shadowedBy ? `（被 ${item.shadowedBy} 覆盖）` : ''}`),
          h('div', { style: S.meta }, h('span', null, item.sourceLabel ? `${item.sourceLabel} · rank ${item.rank}` : item.dir)),
          h('div', { style: S.meta }, h('span', { style: { opacity: 0.6 } }, item.dir)),
          h('div', { style: S.row },
            h('button', {
              style: S.btn(off ? 'primary' : undefined),
              disabled: busy === `toggle:${item.slug}`,
              title: fileToggle ? '改写 SKILL.md 的 disable-model-invocation，模型不再调用该技能' : '该技能只能在本面板隐藏，模型仍会收到',
              onClick: () => toggleSkill(item.slug, off, fileToggle ? 'file' : 'panel'),
            }, busy === `toggle:${item.slug}` ? '处理中…' : (off ? '启用' : (fileToggle ? '关闭' : '在本面板隐藏'))),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:skill:${item.slug}`,
              onClick: async () => {
                setBusy(`openDir:skill:${item.slug}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'skill', slug: item.slug });
                  setNotice(`已在资源管理器中定位到技能文件夹：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('button', { style: S.btn(), disabled: busy === `remove:${item.slug}`, onClick: () => removeSkill(item.slug) }, '卸载')))
      };

      // 按来源层级分组（rank 200 用户 → 500 插件提供），折叠状态存 localStorage
      const installedGrouped = (() => {
        const map = new Map();
        for (const item of filteredInstalled) {
          const rank = item.rank || 999;
          const label = item.sourceLabel || '未分层';
          const key = `${rank}:${label}`;
          if (!map.has(key)) map.set(key, { key, rank, label, items: [] });
          map.get(key).items.push(item);
        }
        return [...map.values()].sort((x, y) => x.rank - y.rank);
      })();

      const installedSkills = installedGrouped.map((group) => {
        const collapsed = collapsedGroups[group.key] === true;
        const shadowed = group.items.filter((x) => x.shadowedBy).length;
        return h('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' } },
          h('button', {
            type: 'button',
            style: { ...S.row, gap: 8, cursor: 'pointer', background: 'transparent', border: 0, padding: '4px 0', font: 'inherit', textAlign: 'left', width: '100%' },
            onClick: () => toggleGroupCollapsed(group.key),
            title: collapsed ? '展开该来源' : '收起该来源',
          },
            h('span', { style: { fontSize: 12, width: 12 } }, collapsed ? '▸' : '▾'),
            h('span', { style: { fontSize: 13, fontWeight: 600 } }, group.label),
            h('span', { style: { ...S.status, fontSize: 11 } }, `rank ${group.rank} · ${group.items.length} 个`),
            shadowed > 0 ? h('span', { style: { ...S.status, fontSize: 11, color: '#b26a00' } }, `${shadowed} 个被更高层覆盖`) : null),
          collapsed ? null : h('div', { style: S.grid }, group.items.map(renderInstalledCard)));
      });

      const installedMcps = filteredMounted.map((item) =>
        h('div', { key: `m-${item.serverName}`, style: S.card },
          h('div', { style: S.title }, item.title || item.serverName),
          h('div', { style: S.meta },
            h('span', null, item.transport),
            h('span', null, item.mounted ? '· 已连接' : '· 未连接'),
            h('span', null, item.tools && item.tools.length ? `· ${item.tools.length} 个工具` : '')),
          h('div', { style: S.row },
            h('button', { style: S.btn(), disabled: busy === `toggle:${item.serverName}`, onClick: () => toggleMcp(item.serverName, !item.enabled) }, item.enabled ? '停用' : '启用'),
            h('button', {
              style: S.btn(),
              disabled: busy === `openDir:mcp:${item.serverName}`,
              onClick: async () => {
                setBusy(`openDir:mcp:${item.serverName}`);
                setError('');
                try {
                  const r = await call('market.openDir', { kind: 'mcp-item', serverName: item.serverName });
                  setNotice(`已在资源管理器中定位到 MCP 定义：${r.opened}`);
                } catch (e) {
                  setError(`打开文件夹失败：${e.message || e}`);
                } finally {
                  setBusy('');
                }
              },
            }, '打开文件夹'),
            h('button', {
              style: S.btn(),
              disabled: busy === `remove:${item.serverName}`,
              onClick: async () => {
                setBusy(`remove:${item.serverName}`);
                setError('');
                try {
                  await call('mcp.uninstall', { serverName: item.serverName, confirm: true });
                  setNotice(`已卸载 ${item.serverName}`);
                  await loadInstalled();
                } catch (e) {
                  setError(String(e.message || e));
                } finally {
                  setBusy('');
                }
              },
            }, '卸载'))));

      // 搜索栏提到 body 之外，成为与标签栏同级的固定行

      const searchBar = (tab === 'skills' || tab === 'mcp')

        ? h('div', { style: S.searchBar },

            h('input', {

              style: S.input,

              placeholder: tab === 'skills' ? '搜索技能，回车查询' : '搜索 MCP 连接器',

              value: query,

              onChange: (e) => setQuery(e.target.value),

              onKeyDown: (e) => {

                if (e.key === 'Enter') {
                  if (tab === 'skills') searchSkills(query, { source, size, category });
                  else searchMcps(query, { source: mcpSource, category: mcpCategory, sort: mcpSort, page: 1, size });
                }

              },

            }),

            h('button', {
              style: S.btn(),
              onClick: () => {
                if (tab === 'skills') searchSkills(query, { source, size, category });
                else searchMcps(query, { source: mcpSource, category: mcpCategory, sort: mcpSort, page: 1, size });
              },
            }, '搜索'))

        : null;

      // 类型 / 分类标签栏：与搜索栏同级、在滚动容器之外，像 Excel 冻结窗格一样常驻。
      const filterBar = (tab === 'skills' || tab === 'mcp')
        ? h('div', { style: S.filterBar },
            h('div', { style: S.row },
                  tab === 'skills'
                    ? ['skills.sh', 'clawhub', 'skillsmp', 'trusttools', 'browse.sh', 'lobehub', 'skillhub', 'modelscope'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(source === key),
                          onClick: () => {
                            // 切源时重置分类：新源不一定有分类字段，沿用旧值会导致空列表
                            setSource(key);
                            setCategory('all');
                            searchSkills(query, { source: key, size, category: 'all' });
                          },
                        }, key))
                    : ['registry', 'lobehub'].map((key) =>
                        h('button', {
                          key,
                          style: S.chip(mcpSource === key),
                          onClick: () => {
                            setMcpSource(key);
                            setMcpCategory('all');
                            setMcpSort('default');
                            setMcpPage(1);
                            searchMcps(query, { source: key, category: 'all', sort: 'default', page: 1 });
                          },
                        }, key === 'registry' ? 'MCP 官方注册表' : 'LobeHub')),
                  h('div', { style: { flex: 1 } }),
                  tab === 'mcp'
                    ? h('select', {
                        style: { ...S.input, flex: '0 0 132px', height: 30 },
                        value: mcpSort,
                        onChange: (e) => {
                          const next = e.target.value;
                          setMcpSort(next);
                          setMcpPage(1);
                          searchMcps(query, { sort: next, page: 1 });
                        },
                      },
                        h('option', { value: 'default' }, mcpSource === 'lobehub' ? '按安装数' : '默认顺序'),
                        mcpSource === 'lobehub'
                          ? h('option', { value: 'installCount' }, '安装最多')
                          : h('option', { value: 'name' }, '按名称'),
                        mcpSource === 'lobehub' ? h('option', { value: 'ratingAverage' }, '评分最高') : null)
                    : h('select', {
                        style: { ...S.input, flex: '0 0 120px', height: 30 },
                        value: sort,
                        onChange: (e) => setSort(e.target.value),
                      },
                        // 排序项按该源的实测原生能力生成（与 src/sort-capability.js 矩阵一致，
                        // 由 test-sort-options 的 Test 5 锁定）。不支持的键不下发，避免「选了没反应」。
                        ...(() => {
                          const CAPS = {
                            'skills.sh': ['installCount', 'name'],
                            clawhub: ['installCount', 'stars', 'newest', 'updated', 'trending', 'name'],
                            skillsmp: ['name'],
                            trusttools: ['installCount', 'name'],
                            'browse.sh': ['installCount', 'updated', 'name'],
                            lobehub: ['installCount', 'stars', 'newest', 'updated', 'name'],
                            skillhub: ['installCount', 'stars', 'updated', 'name'],
                            modelscope: ['installCount', 'stars', 'newest', 'updated', 'name'],
                          };
                          const LABEL = {
                            installCount: '按安装数', stars: '按星级', newest: '最新',
                            updated: '最近更新', trending: '热门', name: '按名称',
                          };
                          const caps = CAPS[source] || ['name'];
                          const items = [h('option', { key: 'default', value: 'default' }, '默认顺序')];
                          for (const k of caps) items.push(h('option', { key: k, value: k }, LABEL[k] || k));
                          return items;
                        })()),
            ),
            tab === 'mcp' && mcpSource === 'lobehub' && mcpCategories.length > 0
              ? h('div', { style: S.row },
                  ['all', ...mcpCategories.slice(0, 12)].map((cat) =>
                    h('button', {
                      key: cat,
                      style: S.chip(mcpCategory === cat),
                      onClick: () => {
                        setMcpCategory(cat);
                        setMcpPage(1);
                        searchMcps(query, { category: cat, page: 1 });
                      },
                    }, cat === 'all' ? '全部分类' : categoryLabel(cat))))
              : null,
            tab === 'skills' && categories.length > 0
              ? h('div', { style: S.row },
                  ['all', ...categories].map((cat) =>
                    h('button', {
                      key: cat,
                      style: S.chip(category === cat),
                      onClick: () => { setCategory(cat); window.scrollTo({ top: 0, behavior: 'smooth' }); },
                    }, cat === 'all' ? '全部分类' : cat)))
              : null,
          )
        : null;


      return h('div', {
          style: S.page,
          'data-dsh-market-root': '',
        },
        // 全局滚动条样式（粗 12px、深色 #444 拇指、#1e1e1e 轨道）
        h('style', null,
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar { width: 12px; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-track { background: #f3f4f6; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-thumb { background: #444; border-radius: 6px; border: 2px solid #f3f4f6; }' +
          '[data-dsh-market-root] [data-dsh-market-body]::-webkit-scrollbar-thumb:hover { background: #222; }' +
          '[data-dsh-market-root] [data-dsh-market-body] { scrollbar-width: thin; scrollbar-color: #444 #f3f4f6; }'),
        h('div', { style: S.panel },
          h('div', { style: S.head },
            h('button', { style: S.tab(tab === 'skills'), onClick: () => setTab('skills') }, 'SKILL 技能'),
            h('button', { style: S.tab(tab === 'mcp'), onClick: () => setTab('mcp') }, 'MCP 连接器'),
            h('button', { style: S.tab(tab === 'manage'), onClick: () => setTab('manage') }, '管理'),
            h('button', { style: S.tab(tab === 'settings'), onClick: () => setTab('settings') }, '路径'),
            h('div', { style: { flex: 1 } }),
            h('span', { style: S.status }, busy ? `处理中：${busy}` : '')),
          searchBar,
          filterBar,
          h('div', { style: S.body, 'data-dsh-market-body': '' },
            tab === 'mcp' && (mcpTotal > 0 || mcps.length > 0)
              ? h('div', { style: S.status },
                  mcpSource === 'lobehub'
                    ? `LobeHub · 共 ${mcpTotal.toLocaleString()} 个连接器 · 第 ${mcpPage}/${mcpTotalPages} 页`
                    : `MCP 官方注册表 · 第 ${mcpPage} 页${mcpHasMore ? '（可继续加载）' : ''}`)
              : null,
            error ? h('div', { style: S.err }, error) : null,
            notice ? h('div', { style: S.status }, notice) : null,
            installProgress
              ? h('div', { style: { ...S.row, gap: 10, alignItems: 'center' } },
                  h('span', { style: { fontSize: 12, whiteSpace: 'nowrap' } },
                    `${installProgress.serverName} 正在启动，已等待 ${Math.round(installProgress.waitedMs / 1000)}s`),
                  // 确定性进度条：按已等待时长 / 预算推进（npx 首次运行需下载依赖，故给足预算）
                  h('div', { style: { flex: 1, height: 6, borderRadius: 3, background: 'var(--dsh-surface-raised, #eaeef2)', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        height: '100%',
                        width: Math.min(100, Math.round((installProgress.waitedMs / MAX_PROGRESS_MS) * 100)) + '%',
                        background: 'var(--dsh-accent, #3b82f6)',
                        transition: 'width 0.6s linear',
                      },
                    })),
                  h('span', { style: { fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap' } },
                    `${Math.min(100, Math.round((installProgress.waitedMs / MAX_PROGRESS_MS) * 100))}% / 上限 ${Math.round(MAX_PROGRESS_MS / 1000)}s`))
              : null,
            envPrompt
              ? h('div', { style: S.card },
                  h('div', { style: S.title }, `${envPrompt.slug} 需要环境变量`),
                  envPrompt.missing.map((name) =>
                    h('div', { key: name, style: S.row },
                      h('span', { style: { width: 220, fontSize: 12, opacity: 0.8 } }, name),
                      h('input', {
                        style: S.input,
                        type: 'password',
                        placeholder: `填写 ${name}`,
                        value: envDraft[name] || '',
                        onChange: (e) => setEnvDraft({ ...envDraft, [name]: e.target.value }),
                      }))),
                  h('div', { style: S.status }, '保存后会写入 Windows 用户环境变量（对新进程持久生效），并立即连接。'),
                  h('div', { style: S.row },
                    h('button', {
                      style: S.btn('primary'),
                      disabled: busy === `install:${envPrompt.slug}`,
                      onClick: () => doInstallMcp({ slug: envPrompt.slug }, envDraft),
                    }, '写入并连接'),
                    h('button', { style: S.btn(), onClick: () => setEnvPrompt(null) }, '取消')))
              : null,
            detail
              ? h('div', {
                  style: {
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(15, 23, 42, 0.45)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    padding: '40px 16px',
                    overflowY: 'auto',
                    zIndex: 1000,
                  },
                },
                  h('div', {
                    style: {
                      width: '100%',
                      maxWidth: 560,
                      background: 'var(--dsh-card, #fff)',
                      borderRadius: 12,
                      padding: 20,
                      boxShadow: '0 16px 48px rgba(15, 23, 42, 0.28)',
                    },
                  },
                    h('div', { style: { ...S.title, fontSize: 14 } }, `${detail.kind === 'skill' ? '技能' : 'MCP'}：${detail.slug}`),
                    detail.kind === 'mcp' && detail.data && (detail.data.detailSource || detail.data.rating != null || detail.data.installs != null || detail.data.description) ? h('div', { style: { ...S.meta, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 } }, [
                      detail.data.description ? h('span', { key: 'desc', style: { fontSize: 12, opacity: 0.85 } }, detail.data.description) : null,
                      h('div', { key: 'chips', style: S.row }, [
                        detail.data.rating != null ? h('span', { key: 'rating', style: S.chip() }, `评分 ${detail.data.rating}`) : null,
                        detail.data.installs != null ? h('span', { key: 'installs', style: S.chip() }, `安装 ${Number(detail.data.installs).toLocaleString()}`) : null,
                        detail.data.category ? h('span', { key: 'cat', style: S.chip() }, detail.data.category) : null,
                        detail.data.detailSource ? h('span', { key: 'src', style: { fontSize: 11, opacity: 0.6 } }, `详情来源：${detail.data.detailSource}`) : null,
                      ]),
                      detail.data.envRequired && detail.data.envRequired.length ? h('span', { key: 'env', style: { fontSize: 11, opacity: 0.7 } }, `需环境变量：${detail.data.envRequired.join(', ')}`) : null,
                      detail.data.homepage ? h('a', { key: 'hp', style: { fontSize: 11, color: 'var(--dsh-accent, #2f6feb)', cursor: 'pointer' }, onClick: () => { try { window.open(detail.data.homepage, '_blank'); } catch {} } }, detail.data.homepage) : null,
                    ]) : null,
                    detail.kind === 'skill'
                      ? h('div', { style: { marginTop: 12 } },
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '描述'),
                            h('input', {
                              style: S.input,
                              placeholder: '留空则不修改',
                              value: draft.description || '',
                              onChange: (e) => setDraft({ ...draft, description: e.target.value }),
                            })),
                          h('textarea', {
                            style: { ...S.input, height: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 10 },
                            value: draft.body || '',
                            onChange: (e) => setDraft({ ...draft, body: e.target.value }),
                          }))
                      : h('div', { style: { marginTop: 12 } },
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '命令'),
                            h('input', { style: S.input, value: draft.command || '', onChange: (e) => setDraft({ ...draft, command: e.target.value }) })),
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, 'URL'),
                            h('input', { style: S.input, value: draft.url || '', onChange: (e) => setDraft({ ...draft, url: e.target.value }) })),
                          h('div', { style: S.row },
                            h('span', { style: { width: 64, fontSize: 12, opacity: 0.7 } }, '参数'),
                            h('textarea', {
                              style: { ...S.input, height: 60, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                              value: draft.args || '',
                              onChange: (e) => setDraft({ ...draft, args: e.target.value }),
                            })),
                          h('pre', { style: { fontSize: 11, opacity: 0.8, whiteSpace: 'pre-wrap', margin: '10px 0 0', background: 'rgba(15, 23, 42, 0.04)', padding: 8, borderRadius: 6 } },
                            JSON.stringify({ transport: detail.data.transport, env: detail.data.env, headers: detail.data.headers }, null, 2))),
                    h('div', { style: { ...S.meta, marginTop: 10 } }, h('span', null, detail.data.path || '')),
                    h('div', { style: { ...S.row, marginTop: 14, justifyContent: 'flex-end', gap: 8 } },
                      h('button', { style: S.btn(), onClick: () => setDetail(null) }, '关闭'),
                      detail.kind === 'skill'
                        ? h('button', { style: S.btn('primary'), disabled: busy === 'save:skill', onClick: saveSkillEdit }, '保存')
                        : h('button', { style: S.btn('primary'), disabled: busy === 'save:mcp', onClick: saveMcpEdit }, '保存并重连'))))
              : null,
            tab === 'skills' ? h('div', { style: S.grid }, skillCards) : null,
            tab === 'mcp' ? h('div', { style: S.grid }, mcpCards) : null,
            // 分页导航：上一页/下一页 + 页码（省略号折叠）+ 每页条数选择器，两个 Tab 统一。
            (tab === 'skills' || tab === 'mcp')
              ? h('div', { style: S.row },
                  h('div', { style: S.row },
                    h('select', {
                      style: { ...S.input, flex: '0 0 96px', height: 28 },
                      value: String(size),
                      onChange: (e) => {
                        const nextSize = Number(e.target.value) || 24;
                        setSize(nextSize);
                        if (tab === 'skills') searchSkills(query, { source, size: nextSize, page: 1 });
                        else searchMcps(query, { page: 1, size: nextSize });
                      },
                    }, [12, 24, 48].map((n) =>
                      h('option', { key: n, value: String(n) }, `每页 ${n}`))),
                  h('div', { style: S.row },
                    pager(
                      tab === 'skills' ? skillsPage : mcpPage,
                      tab === 'skills' ? skillsTotalPages : mcpTotalPages,
                      tab === 'skills' ? skillsHasMore : mcpHasMore,
                      tab === 'skills' ? '共约' : (mcpSource === 'lobehub' ? '共约' : ''),
                       tab === 'skills' ? pageJump : mcpPageJump,
                       tab === 'skills' ? setPageJump : setMcpPageJump, tab === 'skills' ? false : true))))
              : null,
            tab === 'manage' ? h('div', { 'data-manage-tab': manageTab, style: { display: 'flex', flexDirection: 'column', gap: 12, flex: 1, width: '100%', alignItems: 'stretch' } },
              // 二级页签：技能侧（上传/列表/回收站）与 MCP 侧各自成页；
              // 记忆上次停留页，aria 属性兼作 test-manage-panel 的结构锚点。
              h('div', { style: { ...S.row, gap: 2, borderBottom: '1px solid var(--dsh-border, #d0d7de)', marginBottom: 2 }, role: 'tablist' },
                h('button', { type: 'button', style: S.subTab(manageTab === 'skill'), 'aria-selected': manageTab === 'skill', onClick: () => switchManageTab('skill') }, `SKILL 技能 (${installed.length})`),
                h('button', { type: 'button', style: S.subTab(manageTab === 'mcp'), 'aria-selected': manageTab === 'mcp', onClick: () => switchManageTab('mcp') }, `MCP 连接器 (${mounted.length})`)),
              manageTab === 'skill' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%' } },
              // 上传技能：拖拽文件夹或点按钮选文件夹。宿主 @deepseek-ai 包没有 showOpenDialog
              // 暴露给插件，面板是 web 页面，用 <input type=file webkitdirectory>（Chromium
              // 弹原生文件夹对话框，效果与 workbuddy 相同）。拖拽事件里 dataTransfer.files
              // 是扁平文件列表，没有 webkitRelativePath，用首个文件的 name 前缀推断根目录。
              h('div', {
                style: {
                  ...S.row,
                  border: '1px dashed var(--dsh-border, #d0d7de)',
                  borderRadius: 8,
                  padding: '12px 16px',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                },
              },
                h('div', { style: { fontSize: 12, opacity: 0.7 } }, '把技能文件夹拖到这里，或'),
                h('button', {
                  style: S.btn('primary'),
                  disabled: busy === 'upload',
                  onClick: async () => {
                    setBusy('upload');
                    setError('');
                    setNotice('');
                    try {
                      const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.webkitdirectory = true;
                      input.multiple = true;
                      input.style.display = 'none';
                      document.body.appendChild(input);
                      const picked = await new Promise((resolve) => {
                        input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
                        input.click();
                      });
                      document.body.removeChild(input);
                      if (!picked.length) return;
                      const files = [];
                      for (const f of picked) {
                        const rel = (f.webkitRelativePath || f.name).split('/').join('/');
                        const parts = rel.split('/');
                        if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
                        const text = await f.text();
                        files.push({ path: rel, content: text });
                      }
                      const result = await call('skills.upload', { files, force: false });
                      const n = result.count || (result.items || []).length;
                      setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
                      await loadInstalled();
                    } catch (e) {
                      setError(`上传失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '浏览文件夹'),
                h('button', {
                  style: S.btn(),
                  disabled: busy === 'uploadZip',
                  onClick: async () => {
                    setBusy('uploadZip');
                    setError('');
                    setNotice('');
                    try {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = '.zip,application/zip';
                      input.style.display = 'none';
                      document.body.appendChild(input);
                      const picked = await new Promise((resolve) => {
                        input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
                        input.click();
                      });
                      document.body.removeChild(input);
                      if (!picked) return;
                      if (picked.size > 4 * 1024 * 1024) throw new Error(`压缩包 ${(picked.size / 1024 / 1024).toFixed(1)}MB 超过 4MB 上限`);
                      const buf = await picked.arrayBuffer();
                      let binary = '';
                      const bytes = new Uint8Array(buf);
                      const CHUNK = 0x8000;
                      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
                      }
                      const d = await call('skills.importZip', { dataBase64: btoa(binary), fileName: picked.name });
                      setNotice(`已从 ${d.fileName} 导入 ${d.slug}（${d.files} 个文件，压缩包内 ${d.entries} 项）${d.skipped && d.skipped.length ? `；跳过 ${d.skipped.length} 项` : ''}`);
                      await loadInstalled();
                    } catch (e) {
                      setError(`导入 .zip 失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, busy === 'uploadZip' ? '导入中…' : '导入 .zip'),
                h('div', {
                  style: {
                    flex: 1,
                    minHeight: 40,
                    border: '2px dashed var(--dsh-border, #d0d7de)',
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--dsh-text-secondary, #6a737d)',
                    fontSize: 12,
                    opacity: 0.7,
                  },
                  onDragOver: (e) => { e.preventDefault(); e.stopPropagation(); },
                  onDrop: async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    setBusy('upload'); setError(''); setNotice('');
                    try {
                      const SKIP_DIRS = new Set(['.git', '.venv', 'venv', 'node_modules', '.idea', '.vscode', '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.nuxt', '.svelte-kit']);
                      const items = e.dataTransfer ? Array.from(e.dataTransfer.items || []) : [];
                      const droppedFiles = [];
                      // 优先走 DataTransferItem.webkitGetAsEntry() 递归读取 FileEntry，
                      // 能拿到真实的目录层级；读不到的文件回退到 e.dataTransfer.files。
                      const readEntry = async (entry, prefix, out) => {
                        if (entry.isFile) {
                          const file = await new Promise((resolve) => entry.file((f) => resolve(f), () => resolve(null)));
                          if (file) out.push({ file, path: prefix + file.name });
                        } else if (entry.isDirectory) {
                          const reader = entry.createReader();
                          const readBatch = () => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
                          let batch = await readBatch();
                          while (batch.length) {
                            for (const child of batch) await readEntry(child, prefix + entry.name + '/', out);
                            batch = await readBatch();
                          }
                        }
                      };
                      const entryResults = [];
                      for (const item of items) {
                        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
                        if (entry) entryResults.push(entry);
                      }
                      if (entryResults.length) {
                        for (const entry of entryResults) await readEntry(entry, '', droppedFiles);
                      }
                      if (!droppedFiles.length) {
                        for (const f of Array.from(e.dataTransfer.files || [])) droppedFiles.push({ file: f, path: f.name });
                      }
                      if (!droppedFiles.length) return;
                      // 推断根目录前缀：所有 path 的公共第一段（拖入的是文件夹时形如 "agnes/SKILL.md"）。
                      const firstSeg = droppedFiles.map(({ path }) => path.split('/').filter(Boolean)[0] || '').filter(Boolean);
                      const rootPrefix = firstSeg.length && firstSeg.every((s) => s === firstSeg[0]) ? firstSeg[0] + '/' : '';
                      const files = [];
                      for (const { file, path } of droppedFiles) {
                        const rel = path.startsWith(rootPrefix) ? path : rootPrefix + path;
                        const parts = rel.split('/');
                        if (parts.some((p2, i) => i > 0 && SKIP_DIRS.has(p2))) continue;
                        const text = await file.text();
                        files.push({ path: rel, content: text });
                      }
                      const result = await call('skills.upload', { files, force: false });
                      const n = result.count || (result.items || []).length;
                      setNotice(`已上传 ${n} 个技能（${(result.items || []).map((i) => i.slug).join('、')}，安全扫描通过）`);
                      await loadInstalled();
                    } catch (err) {
                      setError(`上传失败：${err.message || err}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '或拖拽技能文件夹到这里（根目录或一级子目录必须含 SKILL.md）'),
              h('div', { style: S.row },
                h('input', {
                  style: { ...S.input, flex: 1 },
                  placeholder: '搜索已装技能（名称、描述）',
                  value: manageSkillFilter,
                  onChange: (e) => setManageSkillFilter(e.target.value),
                }),
                manageSkillFilter ? h('button', { style: S.btn(), onClick: () => setManageSkillFilter('') }, '清除') : null),
              h('div', { style: { ...S.title, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装技能（${filteredInstalled.length}）`,
                nativeDirs.length > 0
                  ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `含 DSH 内置 ${nativeDirs.length} 个目录`)
                  : null,
                h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  disabled: busy === 'openDir:skills',
                  onClick: async () => {
                    setBusy('openDir:skills');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'skills' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录'),
                h('span', { style: { ...S.status, fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `（可在资源管理器中直接查看 / 编辑技能文件）`)),
              h('div', { style: S.grid }, installedSkills),
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `回收站（${trashList ? trashList.items.length : '?'}）`,
                h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: trashBusy === 'list', onClick: loadTrash }, trashBusy === 'list' ? '读取中…' : '读取回收站'),
                trashList && trashList.items.length > 0
                  ? h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: trashBusy === 'empty', onClick: emptyTrashAll }, trashBusy === 'empty' ? '清空中…' : '清空回收站')
                  : null,
                h('span', { style: { ...S.status, fontSize: 12 } }, '删除即移入 .trash，可随时恢复')),
              trashList && trashList.items.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto', width: '100%' } },
                    trashList.items.map((item) => h('div', { key: item.path, style: { ...S.row, fontSize: 11, gap: 8 } },
                      h('span', { style: { fontWeight: 600, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.slug),
                      h('span', { style: { opacity: 0.7 } }, item.kind === 'file' ? '单文件' : '目录'),
                      h('span', { style: { flex: '1', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.stamp || item.name),
                      h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: trashBusy === `restore:${item.path}`, onClick: () => restoreTrashEntry(item) }, trashBusy === `restore:${item.path}` ? '恢复中…' : '恢复'))))
                : (trashList ? h('div', { style: S.status }, '回收站是空的。') : null),
              )) : null,
              manageTab === 'mcp' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%' } },
              h('div', { style: S.row },
                h('input', {
                  style: { ...S.input, flex: 1 },
                  placeholder: '搜索已装 MCP（名称、描述）',
                  value: manageMcpFilter,
                  onChange: (e) => setManageMcpFilter(e.target.value),
                }),
                manageMcpFilter ? h('button', { style: S.btn(), onClick: () => setManageMcpFilter('') }, '清除') : null),
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `已装 MCP（${filteredMounted.length}）`,
                h('button', {
                  style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 },
                  disabled: busy === 'openDir:mcp',
                  onClick: async () => {
                    setBusy('openDir:mcp');
                    setError('');
                    try {
                      const r = await call('market.openDir', { kind: 'mcp' });
                      setNotice(`已在文件管理器中打开：${r.opened}`);
                    } catch (e) {
                      setError(`打开目录失败：${e.message || e}`);
                    } finally {
                      setBusy('');
                    }
                  },
                }, '打开目录')),
              h('div', { style: S.grid }, installedMcps),
              h('div', { style: { ...S.title, margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 8, width: '100%' } },
                `MCP 回收站（${mcpTrashList ? mcpTrashList.items.length : '?'}）`,
                h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: mcpTrashBusy === 'list', onClick: () => loadMcpTrash() }, '读取回收站'),
                mcpTrashList && mcpTrashList.items.length > 0
                  ? h('button', { style: { ...S.btn(), padding: '2px 10px', height: 24, fontSize: 12 }, disabled: mcpTrashBusy === 'empty', onClick: () => emptyMcpTrash() }, '清空')
                  : null,
                h('span', { style: { ...S.status, fontSize: 12 } }, '卸载即移入 .trash，可随时恢复')),
              mcpTrashList && mcpTrashList.items.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflow: 'auto', width: '100%' } },
                    mcpTrashList.items.map((item) => h('div', { key: item.path, style: { ...S.row, fontSize: 11, gap: 8 } },
                      h('span', { style: { fontWeight: 600, minWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.serverName),
                      h('span', { style: { opacity: 0.7 } }, item.transport || 'stdio'),
                      h('span', { style: { opacity: 0.6 } }, item.deletedAt ? item.deletedAt.slice(0, 16).replace('T', ' ') : ''),
                      h('span', { style: { flex: '1', opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || ''),
                      h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: mcpTrashBusy === `restore:${item.path}`, onClick: () => restoreMcpTrashEntry(item) }, '恢复'))))
                : (mcpTrashList ? h('div', { style: S.status }, 'MCP 回收站是空的。') : null),
              ) : null,
            ) : null,
            tab === 'settings' && settings
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                  h('div', { style: S.status }, '每行一个目录；技能列表的第一个目录是安装目标。保存后立即重挂，无需重启。'),
                  setPathRows('技能目录', skillDraft, setSkillDraft),
                  setPathRows('MCP 目录', mcpDraft, setMcpDraft),
                  h('div', { style: S.row },
                    h('button', { style: S.btn('primary'), disabled: busy === 'settings.set', onClick: savePaths }, '保存路径'),
                    h('span', { style: S.status }, `配置文件：${settings.settings.settingsPath}`)),
                  h('div', { style: S.status },
                    `技能 provider：${settings.skillProvider && settings.skillProvider.mounted ? '已挂载' : '未挂载'}`),
                  h('div', { style: S.status }, `MCP 客户端：${settings.shipped && settings.shipped.mcpClient}`),
                  h('div', { style: { ...S.title, marginTop: 14 } }, '会话日志体检'),
                  h('div', { style: S.status }, '检测并修复「空 tool-call」导致的会话永久损坏：只截断损坏点、保留其前全部事件，原文件自动备份。'),
                  h('div', { style: S.row },
                    h('button', { style: S.btn(), disabled: sessionBusy === 'scan', onClick: () => scanSessions(false) }, sessionBusy === 'scan' ? '扫描中…' : '列出会话'),
                    h('button', { style: S.btn('primary'), disabled: sessionBusy === 'scan-deep', onClick: () => scanSessions(true) }, sessionBusy === 'scan-deep' ? '检测中…' : '深度检测损坏')),
                  sessionScan && sessionScan.items
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' } },
                        sessionScan.items.map((item) => h('div', { key: item.file, style: { ...S.row, fontSize: 11, gap: 6, opacity: item.corrupt ? 1 : 0.75 } },
                          h('span', { style: { fontWeight: 600, color: item.corrupt ? '#c62828' : undefined } }, item.corrupt ? '损坏' : (item.scanned ? '正常' : '—')),
                          h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.sessionId),
                          item.corrupt
                            ? h('span', null, `seq ${item.corruption.seq}：${item.corruption.reason}`)
                            : h('span', null, item.scanned ? `${item.events} 条事件` : `${Math.round((item.bytes || 0) / 1024)} KB`),
                          item.corrupt
                            ? h('button', { style: { ...S.btn(), padding: '0 6px', height: 22, fontSize: 11 }, disabled: sessionBusy === `repair:${item.file}`, onClick: () => repairSession(item.file, false) }, sessionBusy === `repair:${item.file}` ? '修复中…' : '修复')
                            : null)))
                    : null)
              : null)));
    }

    /**
     * Composer toolbar entry: two 28px buttons ("技能" / "MCP") on the left of the
     * composer input row. Each opens a popover listing installed items (via the host
     * RPC) with a "go to market" footer that activates the dsh-market panel.
     * Picking an item inserts a prompt snippet into the draft (does NOT submit).
     */
    function ComposerButtons(props) {
      const inputActions = props.inputActions;
      const draft = props.useInput ? props.useInput((state) => state.draft) : '';
      const [open, setOpen] = useState(null); // 'skill' | 'mcp' | null
      const [skills, setSkills] = useState(null);
      const [mcps, setMcps] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const rootRef = useRef(null);
      const timers = useRef([]);

      const later = (fn, ms) => { const id = setTimeout(() => { timers.current = timers.current.filter((pending) => pending !== id); fn(); }, ms); timers.current.push(id); return id; };
      useEffect(() => () => { for (const id of timers.current) clearTimeout(id); timers.current = []; }, []);

      // Popover dismissal: outside click or Escape (quick-resume pattern).
      useEffect(() => {
        if (!open) return undefined;
        if (rootRef.current) rootRef.current.scrollTop = 0;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
          setOpen(null);
        };
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(null); };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => { document.removeEventListener('mousedown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown); };
      }, [open]);

      const load = async (kind) => {
        if (kind === 'skill') {
          if (skills !== null) { setOpen(open === 'skill' ? null : 'skill'); return; }
        } else {
          if (mcps !== null) { setOpen(open === 'mcp' ? null : 'mcp'); return; }
        }
        setOpen(kind);
        setLoading(true);
        setError('');
        try {
          if (kind === 'skill') {
            const data = await call('skills.list');
            setSkills((data.items || []).map((item) => ({
              slug: item.slug,
              name: item.name || item.slug,
              description: item.description || '',
            })));
          } else {
            const data = await call('mcp.list');
            setMcps((data.items || []).map((item) => ({
              serverName: item.serverName,
              title: item.title || item.serverName,
              transport: item.transport || 'stdio',
              mounted: item.mounted === true,
              tools: item.tools || [],
            })));
          }
        } catch (e) {
          setError(String((e && e.message) || e));
          setOpen(null);
        } finally {
          setLoading(false);
        }
      };

      /** Insert a snippet into the draft (append a new line when draft is non-empty). Never submits. */
      const insertSnippet = (text) => {
        if (!inputActions || typeof inputActions.setDraft !== 'function') return;
        const current = String(draft || '').trim();
        inputActions.setDraft(current === '' ? text : `${draft}\n${text}`);
        setOpen(null);
      };

      const skillItemText = (item) => {
        const desc = item.description ? `（${item.description.slice(0, 80)}）` : '';
        return `使用技能 /${item.slug}${desc}。请加载并按需使用它。`;
      };
      const mcpItemText = (item) => {
        const tools = item.tools && item.tools.length > 0 ? `，可用工具：${item.tools.slice(0, 8).join('、')}${item.tools.length > 8 ? ' 等' : ''}` : '';
        const state = item.mounted ? '已挂载' : '未挂载（可先调用 mcp_market_set_enabled 启用）';
        return `使用 MCP 连接器 ${item.serverName}（${item.transport}，${state}${tools}）。需要时直接调用它的工具。`;
      };

      const marketPanel = () => {
        try {
          if (typeof props.openMarketPanel === 'function') props.openMarketPanel();
        } catch { /* layout service unavailable; ignore */ }
        setOpen(null);
      };

      const btnStyle = (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 28,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid ' + (active ? 'var(--dsh-border-strong, #9aa4b2)' : 'var(--dsh-border, #d0d7de)'),
        background: active ? 'var(--dsh-surface-raised, #eef1f5)' : 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-secondary, #57606a)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        userSelect: 'none',
      });

      const popStyle = {
        position: 'absolute',
        left: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 60,
        width: 360,
        maxHeight: 420,
        overflow: 'auto',
        border: '1px solid var(--dsh-border, #d0d7de)',
        borderRadius: 10,
        background: 'var(--dsh-surface, #ffffff)',
        color: 'var(--dsh-text-primary, #1f2328)',
        boxShadow: '0 10px 30px rgba(0,0,0,.18)',
        padding: 10,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      };
      const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer' };
      const rowHover = { background: 'var(--dsh-surface-hover, #f0f3f6)' };

      const renderList = (kind, items, textOf, emptyText) => {
        if (loading) return h('div', { style: { ...S.status, padding: 8 } }, '加载中…');
        if (error && items === null) return h('div', { style: { ...S.status, padding: 8 } }, `加载失败：${error}`);
        if (!items || items.length === 0) return h('div', { style: { ...S.status, padding: 8 } }, emptyText);
        return items.map((item) => {
          const key = kind === 'skill' ? item.slug : item.serverName;
          const title = kind === 'skill' ? item.name : item.title;
          const sub = kind === 'skill' ? (item.description || '').slice(0, 60) : `${item.transport} · ${item.mounted ? '已挂载' : '未挂载'} · ${item.tools.length} 工具`;
          return h('div', {
            key,
            style: rowStyle,
            onMouseEnter: (e) => { e.currentTarget.style.background = rowHover.background; },
            onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
            onClick: () => insertSnippet(textOf(item)),
            title: textOf(item),
          },
            h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            h('div', { style: { ...S.status, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sub));
        });
      };

      return h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, order: 1 } },
        h('button', {
          type: 'button',
          style: btnStyle(open === 'skill'),
          'aria-label': '技能',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('skill'),
        }, h('span', { style: { fontSize: 13 } }, '⚡'), '技能'),
        h('button', {
          type: 'button',
          style: btnStyle(open === 'mcp'),
          'aria-label': 'MCP',
          onMouseDown: (e) => e.preventDefault(),
          onClick: () => load('mcp'),
        }, h('span', { style: { fontSize: 13 } }, '⇄'), 'MCP'),
        open ? h('div', { ref: rootRef, style: popStyle, role: 'dialog' },
          h('div', { style: { ...S.status, fontSize: 11, padding: '0 8px 6px' } },
            open === 'skill' ? `已安装技能（${skills ? skills.length : '…'}）` : `已安装 MCP（${mcps ? mcps.length : '…'}）`),
          open === 'skill' ? renderList('skill', skills, skillItemText, '还没有已安装技能。点下方按钮去技能市场安装。')
            : renderList('mcp', mcps, mcpItemText, '还没有已安装 MCP 连接器。点下方按钮去 MCP 市场安装。'),
          h('div', { style: { borderTop: '1px solid var(--dsh-border, #eaeef2)', marginTop: 8, paddingTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', style: { ...S.btn(), height: 26, fontSize: 12 }, onClick: marketPanel },
              open === 'skill' ? '去技能市场' : '去 MCP 市场'),
            h('span', { style: { ...S.status, fontSize: 11 } }, '点击条目把提示插入输入框（不会直接发送）'))) : null);
    }

    /** Icon shown by the left sidebar's panel list (the sidebar owns the button chrome). */
    function MarketIcon(props) {
      const size = props && props.size ? props.size : 18;
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.6 8.4h16.8l-1.3 10.1a2 2 0 0 1-2 1.7H6.9a2 2 0 0 1-2-1.7L3.6 8.4Z', ...stroke }),
        h('path', { d: 'M8.5 8.4V6.6a3.5 3.5 0 0 1 7 0v1.8', ...stroke }),
        h('path', { d: 'M12 12.2v3.4M10.3 13.9h3.4', ...stroke }));
    }

    return {
      inject: ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        // Left sidebar entry: the sidebar renders the button and reads the label from here.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-skill-mcp-market', order: 20, label: () => 'SKILL技能&MCP连接器' },
            MarketIcon,
          ));
        // Central panel addressed by that same sidebar id.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: 'dsh-skill-mcp-market', inject: () => ({ sidebarRight: ctx.sidebarRight, layout: ctx.layout }) },
            Market,
          ));
        // Composer toolbar: 技能 / MCP quick buttons on the input row (left group).
        // inputActions + useInput are provided by the host to conversation.input.* entries;
        // openMarketPanel is our inject face, closing over ctx for the layout service.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'dsh-market-composer',
              order: 10,
              inject: () => ({
                openMarketPanel: () => {
                  try {
                    const layout = ctx.layout;
                    if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('dsh-skill-mcp-market');
                  } catch { /* layout service unavailable; ignore */ }
                },
              }),
            },
            ComposerButtons,
          ));
        // 右侧栏 tab 类型：把市场面板注册为 sidebar-right 的页面 tab。
        // 在 tab 上下文中 sidebarRight 可用（tab 自身就是会话面），
        // openDetail 无需 selectPanel(null) 回会话，直接开内置浏览器 tab。
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: 'dsh-skill-mcp-market',
              inject: () => ({ sidebarRight: ctx.sidebarRight, layout: ctx.layout }),
            },
            Market,
          ));
        // tab 类型的注册必须把 disposer 交回 effect：不返回它，客户端热重载时
        // 上一次的 id/kind 仍在注册表里，第二次 register() 会抛「already registered」，
        // 异常冒到 cordis 就会把整个插件卸载（表现为侧边栏入口消失）。
        ctx.effect(() => {
          const tabs = ctx.sidebarRightTabs;
          if (!tabs || typeof tabs.register !== 'function') return;
          try {
            const dispose = tabs.register({
              id: 'dsh-skill-mcp-market',
              kind: 'dsh-skill-mcp-market',
              multiple: false,
              priority: 'extension',
              title: () => '技能市场',
              guide: [{
                id: 'new',
                order: 50,
                title: () => '技能市场',
                description: () => '浏览、搜索、安装 SKILL 技能与 MCP 连接器',
              }],
            });
            return typeof dispose === 'function' ? dispose : undefined;
          } catch (e) {
            // 注册失败绝不能连累市场面板本身
            console.warn('[dsh-skill-mcp-market] 右侧栏 tab 注册失败（不影响市场面板）:', e && e.message);
            return undefined;
          }
        }, 'dsh-skill-mcp-market.tab-type');
      },
    };
  },
});
