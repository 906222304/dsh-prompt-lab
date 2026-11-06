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
.pl-view{--pl-fb-bg:#f4f4f6;--pl-fb-paper:#fff;--pl-fb-text:#202025;--pl-fb-muted:#777780;--pl-fb-line:#e3e3e8;--pl-fb-soft:#f9f9fb;--pl-fb-green:#168550;--pl-fb-accent:#6d65b8;--pl-fb-on:#fff;
 --pl-bg:var(--dsw-alias-bg-layer-1,var(--pl-fb-bg));--pl-paper:var(--dsw-alias-bg-layer-2,var(--pl-fb-paper));--pl-text:var(--dsw-alias-label-primary,var(--pl-fb-text));--pl-muted:var(--dsw-alias-label-secondary,var(--pl-fb-muted));--pl-line:var(--dsw-alias-border-l1,var(--pl-fb-line));--pl-soft:color-mix(in srgb,var(--pl-text) 2%,var(--pl-paper));--pl-pill:color-mix(in srgb,var(--pl-text) 4%,var(--pl-paper));--pl-hover:color-mix(in srgb,var(--pl-text) 7%,var(--pl-paper));--pl-green:var(--pl-fb-green);--pl-accent:var(--pl-fb-accent);--pl-selected:color-mix(in srgb,var(--pl-accent) 9%,var(--pl-paper));--pl-on:var(--dsw-alias-bg-layer-1,var(--pl-fb-on));
 flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--pl-bg);color:var(--pl-text);font:13px/1.55 'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;container-type:size}
@media(prefers-color-scheme:dark){.pl-view{--pl-fb-bg:#1a1a1e;--pl-fb-paper:#232327;--pl-fb-text:#ededf1;--pl-fb-muted:#9898a2;--pl-fb-line:#34343b;--pl-fb-soft:#1f1f23;--pl-fb-green:#77cfa1;--pl-fb-accent:#aca5e1;--pl-fb-on:#1a1a1e}}
.pl-view *{box-sizing:border-box}.pl-view :where(h1,h2,h3,p,pre){margin:0}.pl-view :where(button,input,select,textarea){font:inherit;color:inherit}.pl-view button{cursor:pointer}.pl-view :where(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--pl-accent);outline-offset:3px}.pl-view button:disabled{opacity:.4;cursor:default}.pl-view svg{width:17px;height:17px;flex:none;stroke-width:1.65}.pl-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pl-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:21px 28px 12px;flex:none}.pl-brand{display:flex;align-items:center;gap:11px;min-width:0}.pl-brand-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--pl-line);border-radius:11px;background:var(--pl-paper);font-size:12px;letter-spacing:-.5px;font-weight:700}.pl-title{font-size:17px;font-weight:650;letter-spacing:-.45px}.pl-sub{font-size:11px;color:var(--pl-muted);margin-top:1px}.pl-header-actions{display:flex;align-items:center;gap:12px}.pl-connection{display:flex;align-items:center;gap:6px;color:var(--pl-muted);font-size:11px;white-space:nowrap}.pl-dot{width:6px;height:6px;border-radius:50%;display:inline-block;background:var(--pl-green);flex:none}.pl-dot.pending{background:var(--pl-muted)}
.pl-tabs{display:flex;gap:5px;padding:0 28px 17px;border-bottom:1px solid var(--pl-line);flex:none;flex-wrap:wrap}.pl-tab{display:flex;align-items:center;gap:7px;min-height:34px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--pl-muted);padding:6px 12px;font-size:12px;white-space:nowrap}.pl-tab:hover{color:var(--pl-text);background:var(--pl-pill)}.pl-tab.current{background:var(--pl-paper);color:var(--pl-text);border-color:var(--pl-line);box-shadow:0 1px 2px #00000008}.pl-tab svg{width:14px;height:14px}
.pl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 12px;border:1px solid var(--pl-line);border-radius:7px;background:var(--pl-paper);font-size:12px;white-space:nowrap;transition:background .12s,color .12s}.pl-btn:hover:not(:disabled){background:var(--pl-hover)}.pl-btn.accent{background:var(--pl-text);border-color:var(--pl-text);color:var(--pl-on)}.pl-btn.accent:hover:not(:disabled){opacity:.85;background:var(--pl-text)}.pl-btn.quiet{background:transparent;border-color:transparent;color:var(--pl-muted)}.pl-btn.quiet:hover:not(:disabled){background:var(--pl-pill);color:var(--pl-text)}.pl-btn.danger{color:#c75a5a}.pl-icon-button{display:inline-grid;place-items:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--pl-muted);padding:0}.pl-icon-button:hover:not(:disabled){background:var(--pl-pill);color:var(--pl-text)}
.pl-body{padding:25px 28px 30px;overflow:auto;flex:1;min-height:0;scrollbar-width:thin;scrollbar-color:var(--pl-line) transparent}.pl-page{width:100%;max-width:1180px;margin:auto;min-width:0}.pl-page-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.pl-page-heading h1{font-size:19px;letter-spacing:-.6px;font-weight:620}.pl-page-heading p{color:var(--pl-muted);font-size:12px;margin-top:3px}.pl-kicker{color:var(--pl-muted);font-size:11px;letter-spacing:.03em}.pl-count{font-size:10px;padding:1px 6px;min-width:19px;text-align:center;border-radius:5px;background:var(--pl-pill);color:var(--pl-muted);font-variant-numeric:tabular-nums}.pl-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:12px;background:var(--pl-pill);font-size:10px;color:var(--pl-muted);white-space:nowrap}.pl-badge.active{color:var(--pl-green);background:color-mix(in srgb,var(--pl-green) 8%,var(--pl-paper))}
.pl-workspace{display:grid;grid-template-columns:218px minmax(0,1fr);align-items:start;gap:22px;min-width:0}.pl-collection{border:1px solid var(--pl-line);border-radius:12px;background:var(--pl-paper);overflow:hidden;position:sticky;top:0}.pl-collection-head{display:flex;align-items:center;gap:7px;padding:13px 13px 9px;font-size:12px;font-weight:600}.pl-collection-head .pl-icon-button{margin-left:auto}.pl-search{margin:0 10px 10px;display:flex;gap:7px;align-items:center;padding:7px 9px;border-radius:7px;background:var(--pl-pill);color:var(--pl-muted)}.pl-search svg{width:13px;height:13px}.pl-search input{min-width:0;width:100%;border:0;outline:none;background:transparent;font-size:11px}.pl-profile-items{padding:0 6px 7px;max-height:62vh;overflow:auto;scrollbar-width:thin}.pl-profile-item{display:flex;width:100%;align-items:center;gap:8px;text-align:left;padding:11px 9px;border:0;border-radius:7px;background:transparent;margin:2px 0;color:var(--pl-text)}.pl-profile-item:hover{background:var(--pl-pill)}.pl-profile-item.selected{background:var(--pl-selected)}.pl-profile-item>svg{color:var(--pl-muted);width:16px;height:16px}.pl-profile-copy{min-width:0;flex:1}.pl-profile-name{display:block;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pl-profile-snippet{display:block;color:var(--pl-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.pl-collection-foot{padding:11px 13px;border-top:1px solid var(--pl-line);font-size:10px;color:var(--pl-muted)}.pl-mobile-picker{display:none}
.pl-editor-card,.pl-surface{background:var(--pl-paper);border:1px solid var(--pl-line);border-radius:12px;min-width:0}.pl-editor-card{display:flex;flex-direction:column;overflow:clip}.pl-editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 22px;border-bottom:1px solid var(--pl-line)}.pl-editor-head h2{font-size:15px;font-weight:600;letter-spacing:-.2px;overflow-wrap:anywhere}.pl-editor-head p{margin-top:3px;color:var(--pl-muted);font-size:11px}.pl-editor-head-actions{display:flex;align-items:center;gap:10px;flex:none}.pl-manage{position:relative}.pl-manage-panel{position:absolute;right:0;top:40px;z-index:20;width:284px;max-width:calc(100cqw - 44px);padding:14px;border:1px solid var(--pl-line);border-radius:11px;background:var(--pl-paper);box-shadow:0 12px 35px #0002}.pl-manage-panel .pl-select{width:100%;margin:7px 0 12px}.pl-menu-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.pl-menu-actions .pl-btn{white-space:normal}.pl-menu-actions .danger{grid-column:1/-1}.pl-editor-section{padding:21px 22px}.pl-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}.pl-section-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600}.pl-section-head p{font-size:11px;color:var(--pl-muted);margin-top:2px}.pl-section-meta{display:flex;align-items:center;gap:11px;font-size:10px;color:var(--pl-muted);white-space:nowrap}.pl-divider{height:1px;background:var(--pl-line);margin:0 22px}
.pl-editor-card{height:clamp(430px,calc(100cqh - 320px),900px)}.pl-editor-content{flex:1;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--pl-line) transparent}.pl-editor-head{flex:none}.pl-editor-card>.pl-actionbar{position:relative;bottom:auto;flex:none}
.pl-select,.pl-textarea{max-width:100%;background:var(--pl-pill);border:1px solid transparent;border-radius:7px;min-width:0}.pl-select{padding:8px 10px;min-height:32px}.pl-select::placeholder,.pl-textarea::placeholder{color:var(--pl-muted);opacity:.7}.pl-select:focus,.pl-textarea:focus{border-color:color-mix(in srgb,var(--pl-accent) 45%,var(--pl-line));outline:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--pl-accent) 10%,transparent)}.pl-textarea{width:100%;min-height:180px;padding:15px 16px;line-height:1.85;font:12px/1.85 'Cascadia Code',Consolas,'Microsoft YaHei UI',monospace;resize:vertical;display:block;tab-size:2;background:var(--pl-soft);border-color:var(--pl-line)}.pl-textarea.main{height:clamp(240px,32vh,390px);min-height:230px}.pl-textarea.rules{min-height:125px}.pl-field{display:block;font-weight:500;font-size:12px;margin:15px 0 7px}.pl-switch{position:relative;display:inline-flex;align-items:center;flex:none}.pl-switch-control{appearance:none;-webkit-appearance:none;width:30px;height:18px;margin:0;border:0;border-radius:12px;background:color-mix(in srgb,var(--pl-text) 22%,var(--pl-paper));cursor:pointer;position:relative;transition:background .15s}.pl-switch-control::before{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--pl-paper);box-shadow:0 1px 2px #0003;transition:transform .15s}.pl-switch-control:checked{background:var(--pl-text)}.pl-switch-control:checked::before{transform:translateX(12px);background:var(--pl-on)}.pl-switch-control:disabled{opacity:.4;cursor:default}
.pl-inline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:9px;min-width:0}.pl-inline>span{min-width:0;overflow-wrap:anywhere}.pl-inline strong{margin-right:auto}.pl-muted{color:var(--pl-muted)}.pl-empty{padding:20px 14px;text-align:center;color:var(--pl-muted);font-size:11px;line-height:1.8}.pl-rule-list{border:1px solid var(--pl-line);border-radius:8px;overflow:hidden}.pl-rule-list .pl-inline{margin:0;padding:10px 12px;flex-wrap:nowrap;gap:5px;min-height:47px}.pl-rule-list .pl-inline+.pl-inline{border-top:1px solid var(--pl-line)}.pl-rule-list .pl-inline>span{flex:1;font-size:12px}.pl-rule-list .pl-inline .pl-btn{border-color:transparent;background:var(--pl-pill);font-size:10px;padding:3px 7px;min-height:26px}.pl-rule-picker{padding:8px 0 0}.pl-add-rule-row{display:flex;align-items:center;gap:8px;padding:7px 3px}.pl-add-rule-row>span{flex:1;font-size:11px;color:var(--pl-muted)}
.pl-actionbar{position:sticky;bottom:-1px;display:flex;align-items:center;gap:8px;padding:14px 22px;background:var(--pl-paper);border-top:1px solid var(--pl-line);z-index:4;flex-wrap:wrap}.pl-actionbar .pl-save-state{display:flex;align-items:center;gap:5px;margin-right:auto;font-size:10px;color:var(--pl-muted)}.pl-save-state.dirty{color:var(--pl-accent)}.pl-actionbar .pl-btn{min-height:34px}.pl-inspector{margin:16px 0 0;font-size:11px;color:var(--pl-muted)}.pl-inspector>summary{cursor:pointer;padding:8px 2px}.pl-inspector[open]>summary{margin-bottom:8px}.pl-details{border:1px solid var(--pl-line);border-radius:9px;margin:10px 0;background:var(--pl-paper);overflow:hidden}.pl-details summary{cursor:pointer;font-size:12px;font-weight:500;padding:13px 15px}.pl-details[open]>summary{border-bottom:1px solid var(--pl-line)}.pl-details-content{padding:14px 16px}.pl-details .pl-pre{margin:12px}.pl-details-content .pl-pre{margin:0}.pl-pre{white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;background:var(--pl-soft);border:1px solid var(--pl-line);border-radius:7px;padding:14px;font:11px/1.8 Consolas,'Microsoft YaHei UI',monospace;max-height:340px;overflow:auto;user-select:text;color:var(--pl-text)}
.pl-warning,.pl-notice{color:var(--pl-muted);background:var(--pl-pill);border:1px solid var(--pl-line);border-radius:8px;padding:10px 13px;margin:0 0 16px;font-size:11px;line-height:1.7}.pl-error{color:#c75a5a;background:color-mix(in srgb,#c75a5a 7%,var(--pl-paper));border-radius:8px;padding:11px 14px;font-size:12px;margin-bottom:14px}.pl-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--pl-line);border-radius:11px;background:var(--pl-paper);margin-bottom:18px;overflow:hidden}.pl-card{padding:15px 18px}.pl-card+.pl-card{border-left:1px solid var(--pl-line)}.pl-card .label{color:var(--pl-muted);font-size:10px}.pl-card .value{font-weight:550;font-size:13px;margin-top:4px;overflow-wrap:anywhere}.pl-foot{display:flex;justify-content:space-between;gap:8px;padding:9px 28px;border-top:1px solid var(--pl-line);font-size:10px;color:var(--pl-muted);background:var(--pl-bg);flex:none}
.pl-library-layout{display:grid;grid-template-columns:218px minmax(0,1fr);gap:22px;align-items:start}.pl-library-editor{padding:22px}.pl-library-editor>.pl-field:first-child{margin-top:0}.pl-library-editor .pl-textarea{min-height:300px}.pl-library-editor .pl-select{width:100%}.pl-library-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;padding-top:20px;margin-top:20px;border-top:1px solid var(--pl-line)}.pl-library-actions .pl-btn.accent{margin-left:auto}.pl-library-ref{font-size:11px;color:var(--pl-muted);line-height:1.7;margin-top:14px}.pl-library-more{position:relative}.pl-library-more>summary{list-style:none}.pl-library-more>summary::-webkit-details-marker{display:none}.pl-library-more[open]>.pl-menu-actions{position:absolute;bottom:40px;left:0;width:240px;padding:10px;border:1px solid var(--pl-line);border-radius:9px;background:var(--pl-paper);box-shadow:0 8px 24px #0002;z-index:8}.pl-transfer-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.pl-transfer-card{padding:24px;min-width:0}.pl-transfer-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:var(--pl-pill);margin-bottom:17px}.pl-transfer-card h2{font-size:14px;font-weight:600;margin-bottom:7px}.pl-transfer-card p{font-size:12px;color:var(--pl-muted);line-height:1.8;margin-bottom:20px}.pl-file-input{font-size:11px;max-width:100%;width:100%;color:var(--pl-muted)}.pl-file-input::file-selector-button{border:1px solid var(--pl-line);background:var(--pl-pill);color:var(--pl-text);padding:7px 10px;border-radius:6px;margin-right:8px;font:inherit;cursor:pointer}.pl-import-preview{margin-top:18px;padding:22px}.pl-import-preview h3{font-size:14px;margin-bottom:7px}.pl-import-preview p{font-size:12px;color:var(--pl-muted);margin-bottom:10px}.pl-setting-group{border:1px solid var(--pl-line);border-radius:12px;background:var(--pl-paper);overflow:hidden;margin-bottom:18px}.pl-setting-row{padding:20px 22px;display:flex;align-items:center;gap:25px}.pl-setting-row+.pl-setting-row{border-top:1px solid var(--pl-line)}.pl-setting-copy{min-width:0;flex:1}.pl-setting-copy h2{font-size:13px;font-weight:550}.pl-setting-copy p{font-size:11px;color:var(--pl-muted);margin-top:4px;max-width:590px;line-height:1.7}.pl-setting-row .pl-select{max-width:210px;font-size:11px;flex:none}.pl-setting-note{font-size:11px;color:var(--pl-muted);padding:0 3px;line-height:1.8}
@container(max-width:850px){.pl-workspace,.pl-library-layout{grid-template-columns:minmax(0,1fr)}.pl-collection{display:none}.pl-mobile-picker{display:flex;align-items:center;gap:8px;margin-bottom:14px}.pl-mobile-picker>.pl-select{flex:1;width:100%}.pl-editor-section{padding:19px}.pl-editor-head{padding:18px 19px}.pl-divider{margin:0 19px}.pl-library-editor{padding:20px}.pl-actionbar{padding:13px 19px}.pl-transfer-grid{grid-template-columns:1fr}}
@container(max-width:500px){.pl-head{padding:16px 16px 12px}.pl-tabs{padding:0 16px 13px;gap:4px}.pl-tab{padding:6px 9px;font-size:11px;gap:5px}.pl-tab svg{width:12px;height:12px}.pl-body{padding:20px 15px 24px}.pl-title{font-size:15px}.pl-connection{display:none}.pl-page-heading{margin-bottom:15px}.pl-page-heading h1{font-size:17px}.pl-editor-head{flex-wrap:wrap;gap:8px}.pl-editor-head-actions{width:100%;justify-content:space-between}.pl-editor-section{padding:16px}.pl-divider{margin:0 16px}.pl-manage{margin-left:auto}.pl-actionbar{padding:12px 16px}.pl-actionbar .pl-save-state{width:100%;margin-bottom:2px}.pl-actionbar .pl-btn{flex:1}.pl-setting-row{padding:17px 18px;align-items:flex-start;gap:13px;flex-direction:column}.pl-setting-row .pl-select{width:100%;max-width:100%}.pl-foot{padding:8px 16px}.pl-cards{grid-template-columns:1fr}.pl-card+.pl-card{border-left:0;border-top:1px solid var(--pl-line)}.pl-transfer-card{padding:20px}.pl-section-meta{gap:8px}.pl-library-actions .pl-btn{flex:1}.pl-library-editor{padding:17px}.pl-rule-list .pl-inline{flex-wrap:wrap}.pl-rule-list .pl-inline>span{flex-basis:100%;margin-bottom:3px}}
@media(prefers-reduced-motion:reduce){.pl-view *{transition:none!important}}
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
    async function api(method = "GET", payload, since = 0, endpoint = "/prompt-lab/api") {
      // 增量轮询：把已知版本号带在查询串上，状态没变时服务端只回一个几十字节的响应。
      const query = method === "GET" && since > 0 ? `?since=${encodeURIComponent(since)}` : "";
      const response = await fetch(endpoint + query, {
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
      if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { statusCode: response.status });
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
    const icon = (name) => {
      const paths = {
        document: "M7 3h7l4 4v14H6V3h1m7 0v5h5M9 12h6M9 16h6",
        layers: "m12 3 9 5-9 5-9-5 9-5m-9 9 9 5 9-5M3 16l9 5 9-5",
        transfer: "M7 3v13m-4-4 4 4 4-4m6 9V8m-4 4 4-4 4 4",
        activity: "M3 12h4l3-8 4 16 3-8h4",
        settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
        refresh: "M20 8a8 8 0 1 0 1 6M20 3v5h-5",
        plus: "M12 5v14M5 12h14",
        search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
        more: "M5 12h.01M12 12h.01M19 12h.01",
        check: "m5 12 4 4L19 6",
      };
      return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: paths[name] || paths.document }));
    };
    const iconButton = (label, name, onClick, disabled = false) => h("button", {
      type: "button", className: "pl-icon-button", title: label === "↻" ? "刷新配置" : label, "aria-label": label === "↻" ? "刷新配置" : label, onClick, disabled,
    }, icon(name), h("span", { className: "pl-sr" }, label));
    const toggle = (label, checked, onChange, disabled) => h("label", { className: "pl-switch" },
      h("input", { type: "checkbox", role: "switch", className: "pl-switch-control", "aria-label": label, checked, onChange: e => onChange(e.target.checked), disabled }),
      h("span", { className: "pl-sr" }, label));

    async function downloadBundle(kind = "all", id = "") {
      const result = await api("GET", undefined, 0,
        `/prompt-lab/api/export?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.bundle, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `prompt-lab-${kind}-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    let retainedRuleDraft = null;
    function RuleManager({ data, onCommitted }) {
      const empty = () => ({ id: "", name: "", text: "", enabled: true });
      const [draft, setDraft] = useState(() => retainedRuleDraft?.draft || empty());
      const saved = useRef(retainedRuleDraft?.saved || empty());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [moreOpen, setMoreOpen] = useState(false);
      const working = useRef(false);
      const mounted = useRef(false);
      const current = useRef(draft); current.current = draft;
      const dirty = () => JSON.stringify(current.current) !== JSON.stringify(saved.current);
      const change = (field, value) => {
        const next = { ...draft, [field]: value };
        current.current = next; setDraft(next);
        retainedRuleDraft = JSON.stringify(next) !== JSON.stringify(saved.current) ? { draft: next, saved: saved.current } : null;
      };
      const load = item => { const next = item ? { id: item.id, name: item.name, text: item.text, enabled: item.enabled, version: item.version } : empty();
        current.current = next; saved.current = next; retainedRuleDraft = null; setDraft(next); setMoreOpen(false); };
      const choose = item => { if (!dirty() || window.confirm("放弃规则草稿并切换？")) load(item); };
      useEffect(() => {
        mounted.current = true;
        const beforeUnload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", beforeUnload);
        return () => { mounted.current = false; window.removeEventListener("beforeunload", beforeUnload); };
      }, []);
      async function mutate(action) {
        if (working.current) return;
        if (action === "delete" && !window.confirm(`删除规则“${draft.name}”？`)) return;
        if (action === "duplicate" && dirty() && !window.confirm("复制使用已保存版本，是否放弃当前规则草稿？")) return;
        working.current = true; setBusy(true); setError("");
        try {
          const result = await api("POST", { action: `rule.${action}`, id: draft.id,
            name: action === "duplicate" ? undefined : draft.name, text: draft.text, enabled: draft.enabled,
            expectedVersion: draft.version, confirm: action === "delete" });
          onCommitted(result);
          if (mounted.current) load(result.ruleSets.find(item => item.id === (result.editedRuleId || draft.id)));
        } catch (failure) {
          if (mounted.current) setError(failure.message);
          if (failure.statusCode === 409 || failure.statusCode === 428) {
            try { onCommitted(await api()); } catch { /* 保留冲突和草稿 */ }
          }
        }
        finally { working.current = false; if (mounted.current) setBusy(false); }
      }
      const selectedRule = data.ruleSets.find(item => item.id === draft.id);
      return h("section", { "aria-label": "共享规则库", onPointerDown: e => { if (moreOpen && !e.target.closest(".pl-library-more")) setMoreOpen(false); } },
        h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "共享规则库"), h("p", null, "写一次规则，在多套配置中重复使用。")), btn("新建规则", () => choose(null), "", busy)),
        error ? h("p", { className: "pl-error" }, error) : null,
        h("div", { className: "pl-mobile-picker" },
          h("select", { className: "pl-select", "aria-label": "选择共享规则", value: draft.id, disabled: busy,
            onChange: e => choose(data.ruleSets.find(item => item.id === e.target.value)) },
            h("option", { value: "" }, "新建规则草稿"),
            ...data.ruleSets.map(item => h("option", { key: item.id, value: item.id }, item.name)))),
        h("div", { className: "pl-library-layout" },
          h("aside", { className: "pl-collection" }, h("div", { className: "pl-collection-head" }, "全部规则", h("span", { className: "pl-count" }, data.ruleSets.length)),
            h("div", { className: "pl-profile-items" }, ...data.ruleSets.map(item => h("button", { key: item.id, type: "button", className: "pl-profile-item" + (draft.id === item.id ? " selected" : ""), "data-rule-id": item.id, disabled: busy, onClick: () => choose(item) },
              icon("layers"), h("span", { className: "pl-profile-copy" }, h("span", { className: "pl-profile-name" }, item.name), h("span", { className: "pl-profile-snippet" }, (item.usedBy?.length || 0) + " 套配置引用")), h("i", { className: "pl-dot" + (item.enabled ? "" : " pending"), title: item.enabled ? "已启用" : "已停用" }))),
              !data.ruleSets.length ? h("div", { className: "pl-empty" }, "规则库还是空的，", h("br"), "从右侧创建第一条规则。") : null),
            h("div", { className: "pl-collection-foot" }, "停用规则会影响所有引用它的配置")),
          h("div", { className: "pl-surface pl-library-editor" },
            h("div", { className: "pl-section-head" }, h("h2", { className: "pl-section-title" }, draft.id ? "编辑规则" : "新建规则"), toggle("启用此共享规则", draft.enabled, value => change("enabled", value), busy)),
            h("label", { className: "pl-field" }, "规则名称"),
            h("input", { className: "pl-select", "aria-label": "规则名称", maxLength: 80, placeholder: "例如：代码审查规范", value: draft.name, disabled: busy, onChange: e => change("name", e.target.value) }),
            h("label", { className: "pl-field" }, "规则正文"),
            h("textarea", { className: "pl-textarea", "aria-label": "规则正文", placeholder: "编写可复用的约定与要求…", value: draft.text, disabled: busy, onChange: e => change("text", e.target.value) }),
            h("p", { className: "pl-library-ref" }, selectedRule?.usedBy?.length ? "引用此规则的配置：" + selectedRule.usedBy.map(item => item.name).join("、") + "。删除前须解除全部引用。" : "暂无配置引用"),
            h("div", { className: "pl-library-actions" },
              h("div", { className: "pl-library-more" }, h("button", { className: "pl-btn quiet", type: "button", "aria-expanded": moreOpen, onClick: () => setMoreOpen(!moreOpen) }, icon("more"), "更多操作"),
                moreOpen ? h("div", { className: "pl-menu-actions", style: { position: "absolute", bottom: 40, left: 0, width: 248, padding: 12, background: "var(--pl-paper)", border: "1px solid var(--pl-line)", borderRadius: 10, boxShadow: "0 8px 28px #0002", zIndex: 8 } },
                  btn("复制规则", () => mutate("duplicate"), "", busy || !draft.id),
                  btn("导出规则", () => downloadBundle("rule", draft.id).catch(e => setError(e.message)), "", busy || !draft.id),
                  btn("删除规则", () => mutate("delete"), "danger", busy || !draft.id || !!selectedRule?.usedBy?.length)) : null),
              btn("载入最新规则", () => choose(selectedRule), "quiet", busy || !draft.id),
              btn("保存规则", () => mutate(draft.id ? "save" : "create"), "accent", busy || !draft.name.trim() || !draft.text.trim())),
            h("p", { className: "pl-library-ref" }, dirty() ? "有未保存规则草稿；切换页签后仍保留在本次页面内存。" : "规则草稿与载入版本一致"))));
    }

    function TransferPanel({ data, onCommitted }) {
      const [pending, setPending] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const sequence = useRef(0);
      const committing = useRef(false);
      useEffect(() => () => { sequence.current += 1; }, []);
      async function preview(bundle, request = ++sequence.current) {
        setBusy(true); setError("");
        try {
          const result = await api("POST", { action: "preview", bundle }, 0, "/prompt-lab/api/import");
          if (request === sequence.current) setPending({ bundle, preview: result.preview });
        } catch (failure) { if (request === sequence.current) { setPending(null); setError(failure.message); } }
        finally { if (request === sequence.current) setBusy(false); }
      }
      async function selectFile(event) {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        const request = ++sequence.current;
        setPending(null); setError("");
        if (file.size > (data.limits?.importBytes || 34760000)) { setError("导入文件超过大小上限"); return; }
        setBusy(true);
        try {
          const bundle = JSON.parse(await file.text());
          if (request === sequence.current) await preview(bundle, request);
        } catch (failure) { if (request === sequence.current) { setError(`无法读取 JSON：${failure.message}`); setBusy(false); } }
      }
      async function commit() {
        if (!pending || busy || committing.current) return;
        committing.current = true;
        const request = ++sequence.current; setBusy(true); setError("");
        try {
          const result = await api("POST", { action: "commit", bundle: pending.bundle,
            expectedStoreVersion: pending.preview.storeVersion }, 0, "/prompt-lab/api/import");
          onCommitted(result);
          if (request === sequence.current) setPending(null);
        } catch (failure) { if (request === sequence.current) setError(failure.message); }
        finally { committing.current = false; if (request === sequence.current) setBusy(false); }
      }
      return h("section", { "aria-label": "配置与规则导入导出" },
        h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "导入与导出"), h("p", null, "保存本地备份，或把已有配置添加到工作台。"))),
        error ? h("p", { className: "pl-error" }, error) : null,
        h("div", { className: "pl-transfer-grid" },
          h("section", { className: "pl-surface pl-transfer-card" }, h("div", { className: "pl-transfer-icon" }, icon("document")), h("h2", null, "导出备份"),
            h("p", null, "将全部已保存的配置和共享规则导出为 JSON 文件。文件包含正文，请妥善保管。"), btn("导出全部配置与规则", () => downloadBundle().catch(e => setError(e.message)), "", busy)),
          h("section", { className: "pl-surface pl-transfer-card" }, h("div", { className: "pl-transfer-icon" }, icon("transfer")), h("h2", null, "导入配置"),
            h("p", null, "先预览，再追加。已有配置保持原样，重复的 id 会自动重新分配，导入后不会自动启用。"),
            h("input", { className: "pl-file-input", type: "file", "aria-label": "选择配置或规则 JSON 文件", accept: ".json,application/json", disabled: busy, onChange: selectFile }))),
        pending ? h("div", { className: "pl-surface pl-import-preview" },
          h("h3", null, "导入预览"),
          h("p", null, `${pending.preview.profiles.length} 套配置、${pending.preview.ruleSets.length} 套共享规则`),
          ...pending.preview.profiles.map(item => h("p", { key: "p"+item.id }, "配置：" + item.name + (item.renamedId ? "（id 冲突，将分配新 id）" : ""))),
          ...pending.preview.ruleSets.map(item => h("p", { key: "r"+item.id }, "规则：" + item.name + (item.renamedId ? "（id 冲突，将分配新 id）" : ""))),
          btn("确认追加导入", commit, "accent", busy),
          btn("重新预览", () => preview(pending.bundle), "", busy),
          btn("取消导入", () => setPending(null), "quiet", busy)) : null);
    }

    /**
     * 会话页签里的主面板：配置、规则库、导入导出、组装快照和设置。
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
      const [nameInput, setNameInput] = useState("");
      const [manageOpen, setManageOpen] = useState(false);
      const [profileQuery, setProfileQuery] = useState("");
      const [, setEditorTick] = useState(0);
      const editor = useRef(retainedDraft ? { ...retainedDraft } : {
        id: "", prompt: "", rules: "", savedPrompt: "", savedRules: "", version: 1,
        ruleIds: [], savedRuleIds: [], promptEnabled: true, savedPromptEnabled: true,
        rulesEnabled: true, savedRulesEnabled: true,
      });
      const lifecycle = useRef({ mounted: false, epoch: 0, mutating: false });
      const isDirty = () => editor.current.prompt !== editor.current.savedPrompt
        || editor.current.rules !== editor.current.savedRules
        || JSON.stringify(editor.current.ruleIds) !== JSON.stringify(editor.current.savedRuleIds)
        || editor.current.promptEnabled !== editor.current.savedPromptEnabled
        || editor.current.rulesEnabled !== editor.current.savedRulesEnabled;

      function loadEditor(profile) {
        editor.current = { id: profile.id, prompt: profile.prompt, rules: profile.rules,
          savedPrompt: profile.prompt, savedRules: profile.rules, version: profile.version ?? 1,
          ruleIds: [...(profile.ruleIds || [])], savedRuleIds: [...(profile.ruleIds || [])],
          promptEnabled: profile.promptEnabled !== false, savedPromptEnabled: profile.promptEnabled !== false,
          rulesEnabled: profile.rulesEnabled !== false, savedRulesEnabled: profile.rulesEnabled !== false };
        retainedDraft = null;
        setManageOpen(false);
        setEditId(profile.id); setDraft(profile.prompt); setRuleDraft(profile.rules);
      }

      function edit(field, value) {
        editor.current = { ...editor.current, [field]: value };
        retainedDraft = isDirty() ? { ...editor.current } : null;
        if (field === "prompt") setDraft(value); else if (field === "rules") setRuleDraft(value);
        else setEditorTick(value => value + 1);
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
        if (["create", "duplicate", "rename", "delete"].includes(action) && isDirty()
            && !window.confirm("此操作使用已保存版本，是否放弃当前未保存修改？")) return;
        const submitted = { ...editor.current };
        lifecycle.current.mutating = true;
        lifecycle.current.epoch += 1;
        setSaving(true);
        try {
          const result = await api("POST", {
            action,
            ...(action === "settings.update" ? extra : { id: submitted.id, expectedVersion: submitted.version, ...extra }),
            ...(action === "save" ? { prompt: submitted.prompt, rules: submitted.rules,
              ruleIds: submitted.ruleIds, promptEnabled: submitted.promptEnabled, rulesEnabled: submitted.rulesEnabled } : {}),
          });
          if (!lifecycle.current.mounted) return;
          revision.current = Number(result.revision) || 0;
          setData(result);
          setError("");
          if (["activate", "save", "create", "duplicate", "rename", "delete"].includes(action)) {
            const target = result.editedId || (action === "delete" ? result.selected : submitted.id);
            const p = result.profiles?.find((x) => x.id === target);
            if (p) loadEditor(p);
            setNameInput("");
          }
        } catch (err) {
          if (lifecycle.current.mounted) {
            setError(String(err?.message || err));
            if (err.statusCode === 409 || err.statusCode === 428) {
              try {
                const latest = await api();
                if (lifecycle.current.mounted) { revision.current = latest.revision; setData(latest); }
              } catch { /* 保留原始冲突提示和草稿 */ }
            }
          }
        }
        finally {
          lifecycle.current.mutating = false;
          if (lifecycle.current.mounted) setSaving(false);
        }
      }
      function acceptData(result) {
        if (!lifecycle.current.mounted) return;
        lifecycle.current.epoch += 1; revision.current = result.revision; setData(result);
      }
      function reloadEditor() {
        if (isDirty() && !window.confirm("放弃草稿并载入最新保存版本？")) return;
        const current = data?.profiles?.find(p => p.id === editor.current.id)
          || data?.profiles?.find(p => p.id === data.selected);
        if (current) { loadEditor(current); setError(""); }
      }
      function deleteProfile() {
        const target = data?.profiles?.find(p => p.id === editId);
        const fallback = data?.profiles?.find(p => p.id !== editId);
        if (!target || !fallback) return;
        if (!window.confirm(`删除配置“${target.name}”？${selected === editId ? `将回退到“${fallback.name}”。` : ""}`)) return;
        mutate("delete", { confirm: true, fallbackId: fallback.id });
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
      const sharedRules = (editor.current.ruleIds || []).map(id => data?.ruleSets?.find(r => r.id === id))
        .filter(r => r?.enabled).map(r => `## ${r.name}\n${r.text.trim()}`);
      const profileText = [editor.current.promptEnabled && draft.trim(),
        editor.current.rulesEnabled && [ruleDraft.trim() && `## 当前规则集\n${ruleDraft.trim()}`, ...sharedRules].filter(Boolean).join("\n\n")].filter(Boolean).join("\n\n");

      const editProfile = data?.profiles?.find(p => p.id === editId);
      const tabs = [["profile", "提示词与规则", "document"], ["rules", "规则库", "layers"], ["transfer", "导入导出", "transfer"], ["assembly", "组装快照", "activity"], ["settings", "设置", "settings"]];
      const content = h(React.Fragment, null,
        h("header", { className: "pl-head" },
          h("div", { className: "pl-brand" }, h("div", { className: "pl-brand-mark", "aria-hidden": true }, "P/L"),
            h("div", null, h("div", { className: "pl-title" }, "Prompt Lab"), h("div", { className: "pl-sub" }, "提示词工作台"))),
          h("div", { className: "pl-header-actions" },
            h("span", { className: "pl-connection" }, h("i", { className: "pl-dot" + (!data || error ? " pending" : "") }), data ? (error ? "连接异常" : "本地已连接") : "连接中"),
            iconButton("↻", "refresh", () => refresh(true), saving))),
        h("nav", { className: "pl-tabs", "aria-label": "提示词工作台导航" },
          ...tabs.map(([key, title, glyph]) => h("button", { key, type: "button", className: "pl-tab" + (tab === key ? " current" : ""), "aria-pressed": tab === key,
            onClick: () => { setTab(key); setShowText(false); setManageOpen(false); } }, icon(glyph), h("span", null, title)))),
        h("div", { className: "pl-body" }, h("div", { className: "pl-page" },
          error ? h("div", { className: "pl-error", role: "alert" }, "请求失败：" + error) : null,
          !data ? h("div", { className: "pl-empty", role: "status" }, "正在加载本地配置…") : null,
          data?.storage?.error ? h("p", { className: "pl-error", role: "alert" }, data.storage.error) : null,
          data && !st.observerRegistered ? h("p", { className: "pl-notice" }, "组装观察尚未就绪，请确认插件已启用。配置仍可编辑。") : null,
          tab === "profile" && data ? h(React.Fragment, null,
            h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "提示词配置"), h("p", null, "为不同任务保存配置，自由组合正文与规则。")),
              h("span", { className: "pl-kicker" }, (data.profiles || []).length + " 套配置")),
            h("div", { className: "pl-mobile-picker" },
              h("select", { className: "pl-select", "aria-label": "选择编辑的配置", value: editId, disabled: saving, onChange: e => switchEditor(e.target.value) },
                ...data.profiles.map(p => h("option", { value: p.id, key: p.id }, p.name)))),
            h("div", { className: "pl-workspace" },
              h("aside", { className: "pl-collection", "aria-label": "配置列表" },
                h("div", { className: "pl-collection-head" }, "我的配置", h("span", { className: "pl-count" }, data.profiles.length), iconButton("打开新建配置", "plus", () => setManageOpen(true), saving)),
                h("label", { className: "pl-search" }, icon("search"), h("input", { type: "search", value: profileQuery, "aria-label": "搜索配置", placeholder: "搜索配置…", onChange: e => setProfileQuery(e.target.value) })),
                h("div", { className: "pl-profile-items" },
                  ...data.profiles.filter(p => (p.name + " " + p.prompt).toLocaleLowerCase().includes(profileQuery.toLocaleLowerCase())).map(p => h("button", {
                    key: p.id, type: "button", className: "pl-profile-item" + (editId === p.id ? " selected" : ""), "data-profile-id": p.id, "aria-pressed": editId === p.id,
                    onClick: () => switchEditor(p.id), disabled: saving }, icon("document"),
                    h("span", { className: "pl-profile-copy" }, h("span", { className: "pl-profile-name" }, p.name), h("span", { className: "pl-profile-snippet" }, p.prompt.trim().split("\n")[0] || "暂无正文")),
                    p.id === selected ? h("i", { className: "pl-dot", title: "当前启用" }) : null))),
                h("div", { className: "pl-collection-foot" }, "切换编辑不会改变当前启用的配置")),
              h("div", null,
                h("section", { className: "pl-editor-card", "aria-label": "配置编辑器" },
                  h("div", { className: "pl-editor-head" }, h("div", null, h("h2", null, editProfile?.name || "配置编辑器"), h("p", null, "编辑后保存，下次组装时生效。")),
                    h("div", { className: "pl-editor-head-actions" }, h("span", { className: "pl-badge" + (selected === editId ? " active" : "") }, selected === editId ? "当前启用" : "未启用"),
                      h("div", { className: "pl-manage" },
                        h("button", { className: "pl-btn quiet", type: "button", "aria-expanded": manageOpen, onClick: () => setManageOpen(!manageOpen), disabled: saving }, icon("more"), "管理配置"),
                        manageOpen ? h("div", { className: "pl-manage-panel", role: "group", "aria-label": "管理配置操作", onKeyDown: e => { if (e.key === "Escape") setManageOpen(false); } },
                          h("label", { className: "pl-kicker", htmlFor: "pl-profile-name" }, "新建 / 重命名"),
                          h("input", { id: "pl-profile-name", className: "pl-select", value: nameInput, placeholder: "输入配置名称", "aria-label": "配置名称", disabled: saving, maxLength: 80, onChange: e => setNameInput(e.target.value) }),
                          h("div", { className: "pl-menu-actions" },
                            btn("新建配置", () => mutate("create", { name: nameInput }), "", saving || !nameInput.trim()),
                            btn("重命名", () => mutate("rename", { name: nameInput }), "", saving || !nameInput.trim()),
                            btn("复制已保存配置", () => mutate("duplicate", nameInput.trim() ? { name: nameInput } : {}), "", saving || !editId),
                            btn("导出此配置", () => downloadBundle("profile", editId).catch(e => setError(e.message)), "", saving || !editId),
                            btn("删除配置", deleteProfile, "danger", saving || data.profiles.length <= 1))) : null))),
                  h("div", { className: "pl-editor-content" },
                  h("div", { className: "pl-editor-section" },
                    h("div", { className: "pl-section-head" }, h("div", null, h("h3", { className: "pl-section-title" }, "系统提示词"), h("p", null, "描述角色、目标与回答方式")),
                      h("div", { className: "pl-section-meta" }, h("span", null, draft.length.toLocaleString() + " 字"), toggle("启用正文段", editor.current.promptEnabled, value => edit("promptEnabled", value), saving))),
                    h("textarea", { className: "pl-textarea main", "aria-label": "系统提示词正文", value: draft, placeholder: "在这里编写你的系统提示词…", disabled: saving, spellCheck: false, onChange: e => edit("prompt", e.target.value) })),
                  h("div", { className: "pl-divider" }),
                  h("div", { className: "pl-editor-section" },
                    h("div", { className: "pl-section-head" }, h("div", null, h("h3", { className: "pl-section-title" }, "规则"), h("p", null, "附加规则仅用于当前配置，共享规则可重复使用")), toggle("启用规则段", editor.current.rulesEnabled, value => edit("rulesEnabled", value), saving)),
                    h("details", { className: "pl-details", key: "extra-" + editId }, h("summary", null, "附加规则", ruleDraft.length ? " · " + ruleDraft.length.toLocaleString() + " 字" : " · 可选"),
                      h("div", { className: "pl-details-content" }, h("textarea", { className: "pl-textarea rules", "aria-label": "附加规则", value: ruleDraft, placeholder: "添加只在这套配置中使用的规则…", disabled: saving, spellCheck: false, onChange: e => edit("rules", e.target.value) }))),
                    h("div", { className: "pl-section-head", style: { marginTop: 19 } }, h("span", { className: "pl-section-title" }, "共享规则", h("span", { className: "pl-count" }, editor.current.ruleIds.length)), h("span", { className: "pl-kicker" }, "按列表顺序注入")),
                    editor.current.ruleIds.length ? h("div", { className: "pl-rule-list" }, ...editor.current.ruleIds.map((id, index, ids) => h("div", { className: "pl-inline", key: id },
                      h("span", null, `${index + 1}. ${data.ruleSets?.find(r => r.id === id)?.name || "规则已删除，请移除引用"}`),
                      btn("↑", () => { const next = [...ids]; [next[index-1],next[index]]=[next[index],next[index-1]]; edit("ruleIds", next); }, "", saving || index === 0),
                      btn("↓", () => { const next = [...ids]; [next[index+1],next[index]]=[next[index],next[index+1]]; edit("ruleIds", next); }, "", saving || index === ids.length-1),
                      btn("移除引用", () => edit("ruleIds", ids.filter(value => value !== id)), "", saving)))) : null,
                    h("div", { className: "pl-rule-picker" },
                      ...(data.ruleSets || []).filter(r => !editor.current.ruleIds.includes(r.id)).map(r => h("div", { className: "pl-add-rule-row pl-inline", key: r.id },
                        h("span", null, r.name + (r.enabled ? "" : "（已停用）")), btn("添加引用", () => edit("ruleIds", [...editor.current.ruleIds, r.id]), "quiet", saving))),
                      !data.ruleSets?.length ? h("div", { className: "pl-empty" }, "还没有共享规则。", btn("前往规则库", () => setTab("rules"), "quiet")) : null))),
                  h("div", { className: "pl-actionbar" },
                    h("span", { className: "pl-save-state" + (isDirty() ? " dirty" : "") }, h("i", { className: "pl-dot" + (isDirty() ? " pending" : "") }), isDirty() ? "有未保存修改" : "草稿与载入版本一致"),
                    btn("载入最新版本", reloadEditor, "quiet", saving),
                    btn("启用这套配置", () => mutate("activate"), "", saving || selected === editId),
                    btn("保存配置", () => mutate("save"), "accent", saving || (editor.current.promptEnabled && !draft.trim())))),
                h("details", { className: "pl-inspector" }, h("summary", null, "预览与运行信息"),
                  h("details", { className: "pl-details" }, h("summary", null, "预览编辑器当前的完整提示词"), h("pre", { className: "pl-pre" }, profileText)),
                  h("details", { className: "pl-details" }, h("summary", null, `已保存的当前配置预览 · 版本 ${data.configRevision}`), h("pre", { className: "pl-pre" }, data.configuredPrompt || "（空）")),
                  h("details", { className: "pl-details" }, h("summary", null, data.evaluation ? `最近一次 text() 求值 · ${data.evaluation.section || "combined"} · ${data.evaluation.evaluatedAt}${data.evaluation.stale ? " · 配置已变化" : ""}` : "最近一次 text() 求值：尚未观察到"), h("pre", { className: "pl-pre" }, data.evaluation?.text || "（空或尚未求值；不代表模型已接收）")))))) : null,
          tab === "rules" && data ? h(RuleManager, { data, onCommitted: acceptData }) : null,
          tab === "transfer" && data ? h(TransferPanel, { data, onCommitted: acceptData }) : null,
          tab === "assembly" && data ? h(React.Fragment, null,
            h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "组装快照"), h("p", null, "查看进程最近一次观察到的提示词与动态上下文。")),
              h("label", { className: "pl-inline" }, h("input", { type: "checkbox", checked: showText, onChange: e => setShowText(e.target.checked) }), "展开正文")),
            h("p", { className: "pl-notice" }, "快照可能来自其他会话，不等于模型 API 最终请求正文。"),
            assembly?.stale ? h("p", { className: "pl-notice" }, "配置或设置已变化，当前快照待新请求验证。") : null,
            assembly?.processingFailed ? h("p", { className: "pl-error" }, "本次处理失败，显示未处理结果。") : null,
            !assembly ? h("div", { className: "pl-surface pl-empty" }, icon("activity"), h("p", null, "尚未捕获组装快照"), h("p", null, "发送一次新请求后，快照会自动出现在这里。")) : h(React.Fragment, null,
              h("div", { className: "pl-cards" }, field("提示词段", assembly.sectionCount), field("动态上下文", assembly.contextCount || 0), field("观察时间", timeText(assembly.capturedAt))),
              h("p", { className: "pl-kicker" }, "配置版本 " + assembly.configRevision + (assembly.truncated ? " · 内容已截断" : "")),
              ...(assembly.sections || []).map(s => h("details", { className: "pl-details", key: s.index, open: showText },
                h("summary", null, `${s.name} · ${s.retainedChars}/${s.chars} 字${s.truncated ? "（已截断）" : ""}`), h("pre", { className: "pl-pre" }, s.text || "（空）"))),
              h("div", { className: "pl-section-head", style: { marginTop: 24 } }, h("h2", { className: "pl-section-title" }, "动态上下文"), h("span", { className: "pl-kicker" }, "过滤：" + ({ off: "关闭", strip: "去除", redact: "脱敏" }[assembly.contextFilter] || assembly.contextFilter))),
              ...(assembly.contexts || []).map(cx => h("details", { className: "pl-details", key: "cx" + cx.index }, h("summary", null, `${cx.name} · ${cx.retainedChars}/${cx.chars} 字${cx.truncated ? "（已截断）" : ""}`), h("pre", { className: "pl-pre" }, cx.text || "（空）"))))) : null,
          tab === "settings" && data ? h(React.Fragment, null,
            h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "设置"), h("p", null, "设置自动保存，并在之后的组装中使用。"))),
            h("section", { className: "pl-setting-group" },
              h("div", { className: "pl-setting-row" }, h("div", { className: "pl-setting-copy" }, h("h2", null, "运行时上下文"), h("p", null, "保留原文、遮盖路径等具体值，或去除整组上下文。去除也会移除其中的审批等功能提示。")),
                h("select", { className: "pl-select", "aria-label": "运行时上下文过滤", value: filterMode, disabled: saving, onChange: e => mutate("settings.update", { contextFilter: e.target.value }) }, h("option", { value: "off" }, "关闭 · 原样保留"), h("option", { value: "redact" }, "脱敏 · 保留结构"), h("option", { value: "strip" }, "去除 · 整组清空"))),
              h("div", { className: "pl-setting-row" }, h("div", { className: "pl-setting-copy" }, h("h2", null, "渠道指纹脱敏"), h("p", null, "沿用现有身份句文本处理，仅影响之后的系统提示词组装。")), toggle("渠道指纹脱敏", identityOn, value => mutate("settings.update", { identityBreak: value }), saving))),
            h("p", { className: "pl-setting-note" }, "修改不会回写历史请求。设置在本地保存，重新打开后仍会保留。"),
            h("details", { className: "pl-details", style: { marginTop: 24 } }, h("summary", null, "设置说明与生效范围"), h("div", { className: "pl-details-content pl-setting-note" },
              h("p", null, "脱敏保留结构和功能句，只遮盖路径、URL、时间戳；去除会把动态上下文整组清空。"),
              h("p", null, "渠道指纹处理沿用已知句子清单，历史消息中的文本不在此范围。轨迹中的官方时间消息不受上下文过滤影响。"),
              h("p", null, "本地文件：DSH_HOME/prompt-lab/settings.json。"))),
            h("details", { className: "pl-details" }, h("summary", null, "进程最近一次捕获的上下文形态"), h("pre", { className: "pl-pre" }, assembly ? (assembly.stale ? "（旧配置观察结果，待新请求验证）\n\n" : "") + ((assembly.contexts || []).map(cx => cx.text).join("\n\n") || "（空）") : "尚未捕获"))) : null)),
        h("footer", { className: "pl-foot" }, h("span", null, "本地配置 · " + (activeProfile?.name || "正在连接")), h("span", null, "v" + (data?.version || "0.5.2") + (data ? " · 更新于 " + timeText(data.generatedAt) : ""))));

      // 宿主把本组件渲染在 conversation.view 的视图区里（.viewArea 是 flex:1 的纵向容器），
      // 这里只负责填满它：显示 / 隐藏由宿主的页签切换决定，组件自己不判断是否可见。
      // role=region + aria-label 让读屏用户知道这里是插件自己的一个区域。
      return h("section", { className: "pl-view", role: "region", "aria-label": "提示词（Prompt Lab）",
        onPointerDown: e => { if (manageOpen && !e.target.closest(".pl-manage")) setManageOpen(false); } }, content);
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
