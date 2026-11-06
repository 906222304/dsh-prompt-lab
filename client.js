/**
 * 提示词（Prompt Lab）的浏览器端插件（DSH 客户端）。
 *
 * 模块形态：用 `window.__ModuleLoader__.load` 注册一个惰性工厂，工厂返回宿主约定的插件契约
 * `{ name, inject, apply }`。浏览器侧只注册一个挂载点——会话页签（conversation.view 插槽，
 * 与「对话」「轨迹」并排）；选中该页签时，宿主在会话视图区里就地挂载本文件的 Panel 组件。
 *
 * 数据来源：组件不直接读宿主状态，全部通过本地接口 GET/POST `/prompt-lab/api` 读写快照与配置。
 * 该接口由 lib/ui.js 提供、状态由 lib/state.js 持有，与宿主进程侧的提示词注入共用同一份状态，
 * 所以面板里看到的「实际注入文本」就是 text() 回调当次返回的内容。
 *
 * 写法约定：React 由宿主运行时提供（不打包、不引入依赖），视图用 React.createElement 手写，
 * 因此不需要 JSX，也不需要构建工具；样式通过一个 `<style>` 标签注入，类名统一 pl- 前缀。
 */
// 宿主按需物化本 bundle：执行这个文件只会注册一个惰性工厂，模块副作用要等工厂被调用。
window.__ModuleLoader__.load({
  // 工厂 id 必须等于包名，宿主据此把它和 Node 侧的插件条目对应起来。
  id: "dsh-prompt-lab",
  factory: (require) => {
    const module = { exports: {} };
    // React 由宿主运行时提供，不打包进插件（也就不会出现第二份 React 实例）。
    const React = require("react");
    // h 是 createElement 的简写，用于逐层构建虚拟 DOM。
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    // 面板样式：全部写成 `.pl-*` 前缀的类，避免与宿主或其他插件冲突；
    // 颜色一律取 dsw-* 主题变量并带兜底色（var(--token, 兜底值)），深浅色主题都能读。
    // 整份样式只注入一次（见 apply()），面板内部不再写内联样式，只有少量布局微调用 style 属性。
    const CSS = `
/* ── 容器 ──
   宿主把本组件渲染在 conversation.view 的视图区里，宿主 .viewArea 是 flex:1 的纵向容器，
   所以这里同样用 flex:1 + min-height:0 把空间撑满，滚动交给内部的 .pl-body。 */
.pl-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary,#f1f1f1);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
.pl-view *{box-sizing:border-box}
/* ── 头部：左侧标题 + 副标题，右侧操作按钮 ── */
.pl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 17px;border-bottom:1px solid var(--dsw-alias-border-l1,#444)}
.pl-title{font-size:16px;font-weight:700}.pl-sub{color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}
/* ── 通用控件：按钮（.accent 用品牌色，:disabled 降透明度）与面板内页签 ── */
.pl-btn{color:inherit;background:var(--dsw-alias-bg-layer-2,#333);border:1px solid var(--dsw-alias-border-l1,#555);border-radius:7px;padding:6px 11px;font:inherit;cursor:pointer}.pl-btn:disabled{opacity:.45;cursor:default}
.pl-btn.accent{border-color:var(--dsw-alias-brand-primary,#5ca981)}.pl-tabs{display:flex;gap:6px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#444)}
.pl-tab{border:0;border-radius:6px;color:inherit;background:transparent;padding:7px 12px;cursor:pointer;font:inherit}.pl-tab.current{background:var(--dsw-alias-bg-layer-2,#444);font-weight:700}
/* ── 概览卡片：三列网格（插件状态 / 当前规则集 / 组装快照），窄屏改两列见文件末尾 ── */
.pl-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 14px 0}.pl-card{border-radius:9px;background:var(--dsw-alias-bg-layer-2,#333);border:1px solid var(--dsw-alias-border-l1,#444);padding:10px}.pl-card .label{color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.pl-card .value{font-weight:650;margin-top:5px;overflow-wrap:anywhere}
/* ── 正文：面板唯一的滚动区（flex:1 + overflow:auto）；.pl-warning 用于「本机可见 / 不等于模型已接收」这类提醒 ── */
.pl-body{padding:12px 14px 18px;overflow:auto;flex:1;min-height:0}.pl-warning{color:#edc481;background:#8a641824;border:1px solid #8a641851;border-radius:8px;padding:9px 11px;margin:0 0 12px;font-size:12px}
/* ── 排版助手：.pl-inline 是一行内自动换行的控件组（strong 靠左、其余靠右排开），.pl-muted 是次要文案 ── */
.pl-inline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:9px}.pl-inline strong{margin-right:auto}.pl-muted{color:var(--dsw-alias-label-secondary,#aaa)}
/* ── 表单：配置选择框与两个文本域；文本域用等宽字体，方便核对提示词里的空格与换行 ── */
.pl-select,.pl-textarea{background:var(--dsw-alias-bg-layer-2,#333);border:1px solid var(--dsw-alias-border-l1,#555);border-radius:8px;color:inherit;font:inherit;max-width:100%}.pl-select{padding:7px 10px}.pl-textarea{width:100%;min-height:180px;line-height:1.65;font-family:ui-monospace,Consolas,monospace;resize:vertical;padding:10px}.pl-textarea.rules{min-height:100px}.pl-field{display:block;font-weight:600;margin:12px 0 6px}
/* ── 代码块与折叠块：提示词全文、组装段正文、编辑器预览都用它；长文本换行而不是横向滚动 ── */
.pl-pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:var(--dsw-alias-bg-layer-2,#303030);border:1px solid var(--dsw-alias-border-l1,#444);border-radius:8px;padding:12px;font:12px/1.7 ui-monospace,Consolas,monospace;max-height:300px;overflow:auto;user-select:text}
.pl-details{border:1px solid var(--dsw-alias-border-l1,#444);border-radius:8px;margin:8px 0;padding:9px 12px}.pl-details summary{cursor:pointer;font-weight:600}.pl-error{color:#ee9292;padding:8px}.pl-foot{display:flex;justify-content:space-between;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#444);font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}
/* ── 窄屏（会话分栏被压窄或窗口很小时）：概览卡片改两列，第三张跨整行 ── */
@media(max-width:650px){.pl-cards{grid-template-columns:1fr 1fr}.pl-cards .pl-card:last-child{grid-column:1/-1}}
`;

    /**
     * 调用本地接口。GET 取快照（支持 since 增量），POST 提交配置修改。
     * 必须携带 x-prompt-lab-ui 自定义头，否则服务端按非 UI 请求拒绝（403）。
     *
     * @param {"GET"|"POST"} [method] 请求方法。
     * @param {unknown} [payload] POST 时的请求体。
     * @param {number} [since] GET 时已知的状态版本号；与服务端一致就只回 { unchanged: true }。
     * @returns {Promise<object>} 服务端返回的快照对象。
     */
    async function api(method = "GET", payload, since = 0) {
      // 增量轮询：把已知版本号带在查询串上，状态没变时服务端只回一个几十字节的响应。
      const query = method === "GET" && since > 0 ? `?since=${encodeURIComponent(since)}` : "";
      const response = await fetch("/prompt-lab/api" + query, {
        method,
        // 快照必须实时：既声明不缓存，也要求浏览器不要复用上次响应。
        cache: "no-store",
        credentials: "same-origin",
        // 超时兜底：宿主忙时不让单次请求一直挂着，否则 inFlight 会把后续轮询全都堵在门外。
        ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? { signal: AbortSignal.timeout(8000) } : {}),
        headers: {
          // 服务端要求这个自定义头存在。跨站表单无法在不触发 CORS 预检的情况下携带它，
          // 因此它同时充当本地接口的 CSRF 防线；缺失时服务端直接返回 403。
          "x-prompt-lab-ui": "1",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        // GET 不带请求体；POST 的请求体是 { action, id, prompt?, rules? }。
        ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
      });
      const data = await response.json();
      // 服务端约定：只有 ok === true 才算成功，否则把 error 文案抛给调用方展示。
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    }
    /**
     * 把服务端返回的 ISO 时间格式化成 24 小时制本地时间。
     * 时间可能缺失或格式异常（例如尚未求值、快照未生成），此时返回占位符而不是抛错。
     *
     * @param {unknown} value ISO 时间字符串。
     * @returns {string} 形如 "09:31:07" 的本地时间文本。
     */
    const timeText = (value) => {
      try { return new Date(value).toLocaleTimeString("zh-CN", { hour12: false }); }
      catch { return "--:--:--"; }
    };
    // 后端状态阶段到界面文案的映射；键来自 lib/state.js 里 status.phase 的取值集合。
    const statusNames = {
      "not-started": "尚未启动", starting: "启动中", registered: "已注册",
      disabled: "自定义注入已关闭", "empty-prompt": "提示词为空", error: "注册错误", disposed: "已卸载",
    };
    /**
     * 构建一张概览卡片。
     *
     * @param {string} label 卡片标题（如「插件状态」）。
     * @param {unknown} value 卡片取值；调用方负责传入可渲染的字符串。
     * @returns {object} React 元素。
     */
    const field = (label, value) => h("div", { className: "pl-card" },
      h("div", { className: "label" }, label), h("div", { className: "value" }, value));
    /**
     * 构建一个面板按钮。
     *
     * @param {string} label 按钮文案。
     * @param {() => void} onClick 点击回调。
     * @param {string} [cls] 追加类名；传 "accent" 时使用品牌色强调（主操作）。
     * @param {boolean} [disabled] 是否禁用（例如正文为空或请求进行中）。
     * @returns {object} React 元素。
     */
    const btn = (label, onClick, cls = "", disabled = false) => h("button", {
      type: "button", className: "pl-btn " + cls, onClick, disabled,
    }, label);

    /**
     * 会话页签里的主面板：提示词与规则、组装快照、设置三个页签。
     *
     * 组件自身不持有业务状态：展示的内容都是最近一次 GET /prompt-lab/api 的快照，
     * 编辑动作再 POST 回同一接口；真正的状态在宿主进程侧的 lib/state.js 里。
     * 挂载时机由宿主的页签切换决定（未选中的 View 不渲染），所以「进入页签 = 开始拉取，
     * 切走 = 卸载并停止轮询」。
     */
    // 仅在当前模块内存保留一份未保存草稿，切走宿主页签后再回来可恢复；不写磁盘。
    let retainedDraft = null;
    function Panel() {
      // —— 界面状态：只影响本组件的渲染 ——
      // 当前页签：profile（提示词与规则）/ assembly（组装快照）。
      const [tab, setTab] = useState("profile");
      // 组装快照页签下是否展开每个段的完整正文（勾选框，切换页签时复位）。
      const [showText, setShowText] = useState(false);

      // —— 数据状态：最近一次快照，以及编辑器的草稿 ——
      // 最近一次成功获取到的快照；null 表示尚未拿到数据。
      const [data, setData] = useState(null);
      // 请求失败时的错误文案；为空表示当前没有错误。
      const [error, setError] = useState("");
      // 是否有保存/启用请求正在进行，用于禁用按钮、避免重复提交。
      const [saving, setSaving] = useState(false);
      // 编辑器当前编辑的配置 id；为空表示还没选定编辑目标。
      const [editId, setEditId] = useState(() => retainedDraft?.id || "");
      // 编辑器里的提示词正文草稿：未保存的修改只存在于这里，不与宿主状态混在一起。
      const [draft, setDraft] = useState(() => retainedDraft?.prompt || "");
      // 编辑器里的规则草稿（同样是本地草稿）。
      const [ruleDraft, setRuleDraft] = useState(() => retainedDraft?.rules || "");
      const editor = useRef(retainedDraft ? { ...retainedDraft } : {
        id: "", prompt: "", rules: "", savedPrompt: "", savedRules: "",
      });
      const lifecycle = useRef({ mounted: false, epoch: 0, mutating: false });
      const isDirty = () => editor.current.prompt !== editor.current.savedPrompt
        || editor.current.rules !== editor.current.savedRules;

      function loadEditor(profile) {
        editor.current = { id: profile.id, prompt: profile.prompt, rules: profile.rules,
          savedPrompt: profile.prompt, savedRules: profile.rules };
        retainedDraft = null;
        setEditId(profile.id); setDraft(profile.prompt); setRuleDraft(profile.rules);
      }

      function edit(field, value) {
        editor.current = { ...editor.current, [field]: value };
        retainedDraft = isDirty() ? { ...editor.current } : null;
        if (field === "prompt") setDraft(value); else setRuleDraft(value);
      }

      // —— 轮询用的可变状态：放 ref 里，只影响「发不发请求」，不应触发重渲染 ——
      const inFlight = useRef(false);   // 是否有请求在途：慢接口下用它挡住重复请求
      const revision = useRef(0);       // 最近一次成功快照的版本号，用于增量轮询
      const backoff = useRef(0);        // 失败后的退避间隔（毫秒），成功一次即清零
      const lastRun = useRef(0);        // 上次发起请求的时间戳，配合 backoff 判断是否该发

      /**
       * 拉取一次快照（增量）。
       * - 有请求在途、或仍在退避窗口内：直接跳过，避免请求堆积与空转；
       * - 服务端回 unchanged：状态没变，保持现有界面，一次重渲染都不触发；
       * - 成功：更新版本号与数据、清空错误、复位退避；
       * - 失败：只记录错误文案（保留上次数据显示），按 3s→6s→12s→24s→30s 退避。
       * 编辑器尚未初始化（editId 为空）时用当前启用配置填充草稿，让用户一进来就看到正文；
       * 已经在编辑时不覆盖草稿，避免轮询把用户输入冲掉。
       */
      async function refresh(force = false) {
        if (inFlight.current || lifecycle.current.mutating || !lifecycle.current.mounted) return;
        if (force !== true && backoff.current > 0 && Date.now() - lastRun.current < backoff.current) return;
        const epoch = lifecycle.current.epoch;
        inFlight.current = true;
        lastRun.current = Date.now();
        try {
          const result = await api("GET", undefined, revision.current);
          // POST 开始就使旧 GET 失效；卸载后的响应也不能更新界面。
          if (!lifecycle.current.mounted || epoch !== lifecycle.current.epoch) return;
          if (result.unchanged) {
            backoff.current = 0;
            setError("");
            return;
          }
          revision.current = Number(result.revision) || 0;
          setData(result);
          setError("");
          backoff.current = 0;
          if (!editor.current.id) {
            const p = result.profiles?.find((x) => x.id === result.selected);
            if (p) loadEditor(p);
          }
        } catch (err) {
          if (!lifecycle.current.mounted || epoch !== lifecycle.current.epoch) return;
          setError(String(err?.message || err));
          // 指数退避：首次失败 3s，之后翻倍，上限 30s；成功一次立即归零。
          backoff.current = Math.min(Math.max(backoff.current * 2, 3000), 30000);
        } finally {
          inFlight.current = false;
        }
      }
      // 挂载后立即拉取一次，之后每 3 秒轮询（没有开关：这个面板本身就是用来看实时状态的）。
      // 节拍固定 3 秒，但「这次要不要真的发请求」由 refresh() 里的 inFlight / 退避判断决定：
      // 增量轮询下状态没变时服务端只回几十字节，界面完全不动。
      // 轮询只访问 ref，编辑目标改变不会重建定时器或使用过期闭包。
      useEffect(() => {
        lifecycle.current.mounted = true;
        refresh();
        const timer = window.setInterval(refresh, 3000);
        const beforeUnload = (event) => {
          if (isDirty()) { event.preventDefault(); event.returnValue = ""; }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => {
          lifecycle.current.mounted = false;
          lifecycle.current.epoch += 1;
          window.clearInterval(timer);
          window.removeEventListener("beforeunload", beforeUnload);
        };
      }, []);

      /** 切换编辑器目标配置，并把该配置的正文与规则载入草稿（未保存的草稿会被丢弃）。 */
      function switchEditor(id) {
        if (lifecycle.current.mutating || id === editor.current.id) return;
        if (isDirty() && !window.confirm("放弃未保存的修改并切换配置？")) return;
        const profile = data?.profiles?.find((item) => item.id === id);
        if (profile) loadEditor(profile);
      }
      /**
       * 提交变更。三类动作共用一条路径，成功后都用返回的快照刷新界面：
       * - save：把草稿正文与规则一并提交，由服务端校验长度与格式；
       * - activate：只把 editId 指到的配置设为当前启用项，不提交草稿（避免误存半成品）；
       * - settings.update：附带设置字段（目前只有 contextFilter），写到 settings.json。
       * 失败时展示服务端返回的错误文案，界面状态保持不变。
       * 成功后同步版本号，避免紧接着的一次轮询又白拿一份同样的全量快照。
       *
       * @param {"save"|"activate"|"settings.update"} action 动作名。
       * @param {object} [extra] 随动作一起提交的附加字段。
       */
      async function mutate(action, extra = {}) {
        if (lifecycle.current.mutating) return;
        if (action === "activate" && isDirty()
            && !window.confirm("放弃未保存的修改，并启用这套配置已保存的版本？")) return;
        const submitted = { ...editor.current };
        lifecycle.current.mutating = true;
        lifecycle.current.epoch += 1;
        setSaving(true);
        try {
          const result = await api("POST", {
            action,
            ...(action === "settings.update" ? extra : { id: submitted.id, ...extra }),
            ...(action === "save" ? { prompt: submitted.prompt, rules: submitted.rules } : {}),
          });
          if (!lifecycle.current.mounted) return;
          revision.current = Number(result.revision) || 0;
          setData(result);
          setError("");
          if (action === "activate" || action === "save") {
            const p = result.profiles?.find((x) => x.id === submitted.id);
            if (p) loadEditor(p);
          }
        } catch (err) { if (lifecycle.current.mounted) setError(String(err?.message || err)); }
        finally {
          lifecycle.current.mutating = false;
          if (lifecycle.current.mounted) setSaving(false);
        }
      }
      // 派生数据：全部取自最近一次快照，缺数据时用空值兜底，保证首帧渲染不报错。
      const selected = data?.selected || "";                  // 当前启用的配置 id
      const st = data?.status || {};                          // 宿主侧状态：阶段、注册结果、提示词字数等
      const assembly = data?.assembly;                        // 最近一次组装观察快照，可能尚未捕获
      const activeProfile = data?.profiles?.find((p) => p.id === selected);
      // 上下文过滤模式（设置页签的可选项与组装页签的状态徽标都用它）。
      const filterMode = data?.settings?.contextFilter || "off";
      // 渠道指纹脱敏开关（与上下文过滤独立、可叠加）。
      const identityOn = data?.settings?.identityBreak === true;
      // 编辑器预览文本：与宿主端 lib/state.js 的 profileText() 拼装规则保持一致
      // （正文 + 可选的「## 当前规则集」段），因此预览看到的就是下一次注入会用的文本。
      const profileText = draft.trim()
        ? [draft.trim(), ruleDraft.trim() && `## 当前规则集\n${ruleDraft.trim()}`].filter(Boolean).join("\n\n") : "";

      // 面板骨架：头部 + 页签 + 概览卡片 + 正文（唯一滚动区）+ 页脚。
      // 这里先拼成一个 Fragment，返回时再交给宿主的视图区容器。
      const content = h(React.Fragment, null,
        // 头部：左标题/副标题，右侧只有刷新按钮（面板由页签控制显示，不需要关闭按钮）。
        h("header", { className: "pl-head" },
          h("div", null, h("div", { className: "pl-title" }, "提示词 · Prompt Lab"),
            h("div", { className: "pl-sub" }, "系统提示词 · 配置 / 组装 / 过滤")),
           h("div", { className: "pl-inline", style: { margin: 0 } }, btn("↻", () => refresh(true), "", saving))),
        // 面板内页签（三选一）。切换时顺带把组装快照的「展开全文」复位，避免串页残留。
        h("nav", { className: "pl-tabs" },
          ...[["profile", "提示词与规则"], ["assembly", "组装快照"], ["settings", "设置"]].map(([k, title]) =>
            h("button", { key: k, type: "button", className: "pl-tab" + (tab === k ? " current" : ""), onClick: () => { setTab(k); setShowText(false); } }, title))),
          // 概览卡片：插件状态 / 当前配置 / 组装快照段数。
          h("div", { className: "pl-cards" },
            field("插件状态", statusNames[st.phase] || st.phase || "未知"),
            field("当前配置", activeProfile?.name || "未知"),
            field("进程最近一次快照", assembly ? `${assembly.sectionCount} 段${assembly.stale ? " · 待新请求验证" : ""}` : "尚未捕获")),
          // 正文：唯一滚动区。错误条与「加载中」占位排在最上面，下面只渲染当前页签的内容。
          h("div", { className: "pl-body" },
            error ? h("div", { className: "pl-error" }, "请求失败：" + error) : null,
            !data ? h("div", { className: "pl-muted" }, "正在加载本地接口…") : null,
            data && !st.observerRegistered ? h("p", { className: "pl-warning" }, "组装观察与过滤未就绪：请确认 prompt-lab 插件行已启用，且宿主暴露了组装事件。") : null,
            // —— 页签一：提示词与规则编辑 ——
            tab === "profile" && data ? h(React.Fragment, null,
              h("p", { className: "pl-warning" }, "参考 dsh-purge 的配置优先级与规则集管理；这里的规则是追加到提示词的普通文本，不会修改 DSH 的 AGENTS.md、CLAUDE.md 或宿主代码。"),
              // ① 选择要编辑的配置；右侧标记它是否就是当前启用项。
              h("div", { className: "pl-inline" },
                h("strong", null, "选择编辑的配置"),
                h("select", { className: "pl-select", value: editId, disabled: saving, onChange: (e) => switchEditor(e.target.value) },
                  ...(data.profiles || []).map((p) => h("option", { value: p.id, key: p.id }, p.name))),
                h("span", { className: "pl-muted" }, selected === editId ? "● 当前启用" : "未启用")),
              // ② 两个文本域就是这份配置的全部内容：系统提示词正文 + 追加规则。
              h("label", { className: "pl-field" }, "系统提示词正文"),
              h("textarea", { className: "pl-textarea", value: draft, disabled: saving, spellCheck: false, onChange: (e) => edit("prompt", e.target.value) }),
              h("label", { className: "pl-field" }, "附加规则（自然语言，每行一条）"),
              h("textarea", { className: "pl-textarea rules", value: ruleDraft, disabled: saving, spellCheck: false, onChange: (e) => edit("rules", e.target.value) }),
              // ③ 保存 / 启用；两个动作都只影响下一次 text() 求值，不改变已发出的请求。
              h("div", { className: "pl-inline", style: { marginTop: 12 } },
                // 正文为空或正在保存时禁止提交。
                btn("保存配置", () => mutate("save"), "accent", saving || !draft.trim()),
                // 已是当前启用项时无需重复启用。
                btn("启用这套配置", () => mutate("activate"), "", saving || selected === editId),
                h("span", { className: "pl-muted" }, "保存后下次 text() 求值使用新配置；修改已发请求无效")),
              h("p", { className: "pl-muted" }, isDirty() ? "有未保存修改；切走宿主页签后，草稿会保留在本次页面内存中。" : "草稿与载入版本一致"),
              h("details", { className: "pl-details" },
                h("summary", null, "预览编辑器当前的完整提示词"), h("pre", { className: "pl-pre" }, profileText)),
              h("details", { className: "pl-details" },
                h("summary", null, `已保存的当前配置预览 · 版本 ${data.configRevision}`),
                h("pre", { className: "pl-pre" }, data.configuredPrompt || "（空）")),
              h("details", { className: "pl-details" },
                h("summary", null, data.evaluation
                  ? `最近一次 text() 求值 · ${data.evaluation.evaluatedAt} · 版本 ${data.evaluation.configRevision}${data.evaluation.stale ? " · 配置已变化" : ""}`
                  : "最近一次 text() 求值：尚未观察到"),
                h("pre", { className: "pl-pre" }, data.evaluation?.text || "（空或尚未求值；不代表模型已接收）"))) : null,
            // —— 页签二：组装快照 ——
            tab === "assembly" && data ? h(React.Fragment, null,
              h("p", { className: "pl-warning" }, "这是进程最近一次 system-prompt/assemble 观察快照，可能来自其他会话；事件后仍可能有宿主处理，不等于模型 API 最终请求。"),
              assembly?.stale ? h("p", { className: "pl-warning" }, "配置或设置已变化；以下保留旧快照，待新请求验证。") : null,
              assembly?.processingFailed ? h("p", { className: "pl-warning" }, "本次插件处理失败，返回了未处理结果。") : null,
              h("label", { className: "pl-inline" },
                h("input", { type: "checkbox", checked: showText, onChange: (e) => setShowText(e.target.checked) }),
                " 展开显示完整提示词段"),
              // 每段一个折叠块：段名、order、字数；勾选上面的「展开」时默认全部打开。
              // 尚未捕获到组装事件时给出可操作提示。
              !assembly ? h("p", { className: "pl-muted" }, "尚未观察到组装事件。请新建 DSH 会话并发送一次消息，再刷新；若仍无快照说明当前宿主没有向本插件暴露该事件。") :
                h(React.Fragment, null,
                  h("p", { className: "pl-muted" }, "观察时间：" + assembly.capturedAt + " ｜配置版本：" + assembly.configRevision + " ｜段数：" + assembly.sectionCount + (assembly.truncated ? " ｜因长度上限被截断" : "") + (assembly.identityBroken > 0 ? " ｜指纹脱敏 " + assembly.identityBroken + " 处" : "")),
                  ...(assembly.sections || []).map((s) => h("details", { className: "pl-details", key: s.index, open: showText },
                    h("summary", null, `#${s.index + 1} ${s.name} / order=${s.order ?? "?"} / ${s.retainedChars}/${s.chars} 字${s.truncated ? "（已截断）" : ""}`),
                    h("pre", { className: "pl-pre" }, s.text || "（空）"))),
                  // 动态上下文（“Current runtime context …”那段）：显示过滤后的最终形态。
                  h("p", { className: "pl-inline", style: { marginTop: 14 } },
                    h("strong", null, "动态上下文"),
                    h("span", { className: "pl-muted" },
                      (assembly.contextCount || 0) + " 条 ｜过滤：" + ({
                        off: "关（原样）", strip: "去除", redact: "脱敏",
                      }[assembly.contextFilter] || assembly.contextFilter)
                      + (assembly.contextsRemoved > 0 ? " ｜本次去除 " + assembly.contextsRemoved + " 条" : ""))),
                  ...(assembly.contexts || []).map((cx) => h("details", { className: "pl-details", key: "cx" + cx.index },
                    h("summary", null, `${cx.name} / ${cx.retainedChars}/${cx.chars} 字${cx.truncated ? "（已截断）" : ""}`),
                    h("pre", { className: "pl-pre" }, cx.text || "（空）"))))) : null,
            // —— 页签三：设置 ——
            tab === "settings" && data ? h(React.Fragment, null,
              h("p", { className: "pl-warning" }, "设置在之后的组装中使用，已入库的历史不会回改；最终请求仍可能经过宿主的后续处理。"),
              h("div", { className: "pl-inline" },
                h("strong", null, "运行时上下文过滤"),
                h("select", {
                  className: "pl-select", value: filterMode, disabled: saving,
                  onChange: (e) => mutate("settings.update", { contextFilter: e.target.value }),
                },
                  h("option", { value: "off" }, "关闭（原样注入）"),
                  h("option", { value: "strip" }, "去除（整段不发给模型）"),
                  h("option", { value: "redact" }, "脱敏（保留结构，遮路径/地址/时间）")),
                h("span", { className: "pl-muted" }, saving ? "保存中…" : "已保存设置在之后的组装中使用")),
              h("details", { className: "pl-details", open: true },
                h("summary", null, "两种模式分别适合什么时候用"),
                h("p", { style: { margin: "6px 0" } },
                  "去除（strip）：把 assembly.contexts 整组清空——工作目录、沙箱/审批策略、宿主源码路径、GUI 地址都不再出现。注意其中也包含审批提示（工具要不要先问用户）等功能性句子，全去掉可能让模型更保守。"),
                h("p", { style: { margin: "6px 0" } },
                  "脱敏（redact）：保留每条贡献的结构和功能句，只把路径、URL、时间戳换成 <路径>/<URL>/<时间> 占位符——模型仍知道“有个工作目录、审批策略是什么”，但看不到具体机器信息。"),
                h("p", { style: { margin: "6px 0" }, className: "pl-muted" },
                  "范围说明：只处理这段动态上下文；轨迹里“Time sampled / Elapsed”那几行来自官方 dsh-time-context 插件（注入的是用户消息），不在此过滤范围内。")),
              h("div", { className: "pl-inline", style: { marginTop: 10 } },
                h("strong", null, "渠道指纹脱敏"),
                h("select", {
                  className: "pl-select", value: identityOn ? "on" : "off", disabled: saving,
                  onChange: (e) => mutate("settings.update", { identityBreak: e.target.value === "on" }),
                },
                  h("option", { value: "off" }, "关闭"),
                  h("option", { value: "on" }, "开启（身份句插零宽空格）")),
                h("span", { className: "pl-muted" },
                  (assembly?.identityBroken > 0 ? "上次命中 " + assembly.identityBroken + " 处 ｜" : "") + (saving ? "保存中…" : "已保存设置在之后的组装中使用"))),
              h("details", { className: "pl-details", open: true },
                h("summary", null, "渠道指纹脱敏是干什么的（WorkBuddy 400 / 11128）"),
                h("p", { style: { margin: "6px 0" } },
                  "WorkBuddy 国内网关对系统提示词做精确子串匹配，命中第三方 agent 身份句即拒（400/11128）。本宿主的提示词里有三处这样的句子：coding-agent 身份句（首行，带模型名）、Harness 身份句、Web GUI 说明段——三处全处理才有效，只改一处不够。"),
                h("p", { style: { margin: "6px 0" } },
                  "开启后：在这几处句子的词界插入零宽空格（U+200B）——网关匹配失配，模型读到的每个词不变，体积只增约 0.3%。清单是实测快照，网关加词条时需要更新插件。"),
                h("p", { style: { margin: "6px 0" }, className: "pl-muted" },
                  "只处理系统提示词（sections + contexts）；若历史消息里复述过这些句子（assistant 角色），本层覆盖不到，需要换新会话或让中转层处理。")),
              h("details", { className: "pl-details" },
                h("summary", null, "进程最近一次捕获的上下文形态"),
                assembly?.stale ? h("p", { className: "pl-muted" }, "这是旧配置的观察结果，待新请求验证。") : null,
                !assembly ? h("p", { className: "pl-muted" }, "还没有组装快照：发送一条消息后再回来看。")
                  : h("pre", { className: "pl-pre" },
                    (assembly.contexts || []).map((cx) => cx.text).join("\n\n") || "（空：没有上下文贡献，或已整组去除）")),
              h("details", { className: "pl-details" },
                h("summary", null, "设置存在哪"),
                h("p", { className: "pl-muted", style: { margin: "6px 0" } },
                  "DSH_HOME/prompt-lab/settings.json（原子写），重启后仍然生效；删掉该文件即回到默认“关闭”。"))) : null),
          // 页脚：左侧点明能力边界（只读观察 + 显式保存配置），右侧是这份快照的生成时间。
          h("footer", { className: "pl-foot" },
            h("span", null, "配置管理 · 进程级组装观察"),
            h("span", null, data ? timeText(data.generatedAt) : "未连接")));
      // 宿主把本组件渲染在 conversation.view 的视图区里（.viewArea 是 flex:1 的纵向容器），
      // 这里只负责填满它：显示 / 隐藏由宿主的页签切换决定，组件自己不判断是否可见。
      // role=region + aria-label 让读屏用户知道这里是插件自己的一个区域。
      return h("section", { className: "pl-view", role: "region", "aria-label": "提示词（Prompt Lab）" }, content);
    }

    /**
     * 客户端插件入口：注入样式，并把面板注册到会话页签（conversation.view）。
     *
     * @param {object} ctx 客户端插件上下文，提供 effect 生命周期与 slots 插槽服务。
     */
    function apply(ctx) {
      // 样式走一个独立的 <style> 标签（而不是内联样式）：整份 CSS 只写一遍，
      // 卸载时也能靠这个标签一次性移除；data-prompt-lab 方便在开发者工具里辨认。
      const style = document.createElement("style");
      style.setAttribute("data-prompt-lab", "1");
      style.textContent = CSS;
      document.head.appendChild(style);
      // 通过 effect 注册清理函数：插件卸载/热替换时移除样式标签，避免样式残留。
      ctx.effect(() => () => style.remove());

      // 注册会话页签：与「对话」（order 0）、「轨迹」（order 10）并排的第三个 View。
      // - order 20 让它排在两个内置 View 之后；label 就是页签上显示的文字。
      // - inject("conversation.view", ...)：等宿主声明出这个插槽后再注册；声明塌缩时
      //   自动撤回贡献，恢复后重新注册（插槽契约见 references/dsh-client-slots.md）。
      // - register 的第二个参数是条目组件：选中该页签时宿主在会话视图区里渲染它；
      //   返回值是注销函数，交给 inject 管理生命周期，这里不需要自己保存。
      // 注意：宿主只在注册了 ≥2 个 View 时才画页签条。
      ctx.slots.inject("conversation.view", () => ctx.slots.register(
        { name: "conversation.view", id: "prompt-lab", order: 20, label: "提示词" },
        () => h(Panel),
      ));
    }
    // 导出宿主约定的插件契约：name 是插件标识，inject 声明依赖的宿主服务（slots），
    // apply 在依赖就绪时被调用一次。这里只依赖 slots —— 其余数据都走本地 HTTP 接口，
    // 因此宿主即便没有 systemPrompt 之类的服务，浏览器端也能正常加载。
    module.exports.name = "dsh-prompt-lab";
    module.exports.inject = ["slots"];
    module.exports.apply = apply;
    return module.exports;
  },
});
