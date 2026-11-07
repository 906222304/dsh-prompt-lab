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
.pl-diagnostics{margin-top:24px}.pl-diagnostics>summary{display:flex;align-items:center;gap:10px}.pl-diagnostics>summary::before{content:'▸';color:var(--pl-muted);font-size:10px}.pl-diagnostics[open]>summary::before{content:'▾'}.pl-diagnostics>summary .pl-kicker{margin-left:auto}.pl-diagnostics .pl-setting-note{padding:0;margin-bottom:12px}.pl-diagnostics .pl-notice{margin:12px 0}.pl-diagnostic-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 0;font-size:11px;flex-wrap:wrap}.pl-diagnostic-row+.pl-diagnostic-row{border-top:1px solid var(--pl-line)}.pl-diagnostic-row>span:first-child{font-weight:550;flex:none}.pl-diagnostic-row>span:last-child{color:var(--pl-muted);overflow-wrap:anywhere}.pl-diagnostics .pl-pre{margin-top:10px}
.pl-processing-head{padding:20px 22px 0}.pl-processing-head h2{font-size:14px;font-weight:600}.pl-processing-head p{font-size:11px;color:var(--pl-muted);margin-top:5px}.pl-current-setting{margin:0 22px 18px;padding:10px 12px;border-radius:7px;background:var(--pl-pill);font-size:11px;line-height:1.8;color:var(--pl-muted)}.pl-inline-help{margin:0 22px 20px}.pl-inline-help>summary{cursor:pointer;font-size:11px;color:var(--pl-muted);padding:0 0 8px}.pl-help-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.pl-help-item{padding:14px;border:1px solid var(--pl-line);border-radius:8px;min-width:0}.pl-help-item h3,.pl-help-copy h3{font-size:12px;font-weight:550;margin-bottom:5px}.pl-help-item p,.pl-help-copy p{font-size:11px;line-height:1.9;color:var(--pl-muted)}.pl-help-item .pl-example{margin-top:10px;font:11px/1.8 Consolas,'Microsoft YaHei UI',monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--pl-text)}.pl-help-copy p+p{margin-top:8px}.pl-help-copy h3:not(:first-child){margin-top:17px}.pl-advanced{border:0;border-top:1px solid var(--pl-line);border-radius:0;margin:0;background:transparent}.pl-advanced>summary{display:flex;align-items:center;gap:9px;padding:17px 22px;list-style:none}.pl-advanced>summary::-webkit-details-marker{display:none}.pl-advanced>summary::before{content:'▸';font-size:10px;color:var(--pl-muted)}.pl-advanced[open]>summary::before{content:'▾'}.pl-advanced>summary .pl-badge{margin-left:auto}.pl-advanced .pl-setting-row{padding-bottom:14px}.pl-advanced .pl-help-copy{padding:0 22px 21px}.pl-advanced .pl-setting-copy p{max-width:660px}.pl-setting-group:has(.pl-processing-head)>.pl-setting-row{border-top:0}
@container(max-width:850px){.pl-help-grid{grid-template-columns:1fr}}
@container(max-width:500px){.pl-processing-head{padding:18px 18px 0}.pl-current-setting{margin:0 18px 16px}.pl-inline-help{margin:0 18px 17px}.pl-advanced>summary{padding:16px 18px;flex-wrap:wrap}.pl-advanced .pl-help-copy{padding:0 18px 18px}.pl-advanced>summary .pl-badge{font-size:9px}.pl-help-item{padding:12px}}
@media(prefers-reduced-motion:reduce){.pl-view *{transition:none!important}}
.pl-view{position:relative}.pl-studio-overlay{position:absolute;inset:0;z-index:40;background:#0005;display:flex;justify-content:flex-end}.pl-studio{width:min(1050px,100%);height:100%;display:flex;flex-direction:column;background:var(--pl-bg);box-shadow:-10px 0 35px #0002;min-width:0}.pl-studio-head{padding:17px 22px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--pl-paper);border-bottom:1px solid var(--pl-line);flex:none}.pl-studio-head h2{font-size:16px;font-weight:600}.pl-studio-head p{font-size:11px;color:var(--pl-muted);margin-top:2px}.pl-studio-body{padding:20px 22px;overflow:auto;flex:1;min-height:0;scrollbar-width:thin}.pl-studio-grid{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;align-items:start}.pl-studio-form,.pl-candidate{padding:18px;min-width:0}.pl-studio-form .pl-field:first-child{margin-top:0}.pl-studio-form .pl-select{width:100%}.pl-studio-form .pl-textarea{min-height:105px;padding:10px;font-size:12px}.pl-studio-note{font-size:11px;line-height:1.8;color:var(--pl-muted);margin:9px 0;overflow-wrap:anywhere}.pl-studio-buttons{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}.pl-studio-buttons .pl-btn{flex:1}.pl-studio-history{margin-top:17px}.pl-studio-history>summary{cursor:pointer;font-size:11px;color:var(--pl-muted)}.pl-history-item{border:0;border-bottom:1px solid var(--pl-line);background:transparent;padding:9px 0;text-align:left;width:100%;display:block;font-size:11px}.pl-history-item small{display:block;color:var(--pl-muted);margin-top:3px}.pl-candidate h3{font-size:15px}.pl-candidate h4{font-size:12px;margin:16px 0 8px}.pl-candidate .pl-pre{max-height:280px;margin-top:8px}.pl-candidate ul{padding-left:17px;margin:7px 0;font-size:11px;line-height:1.9}.pl-candidate-rule{padding:12px;border:1px solid var(--pl-line);border-radius:8px;margin:9px 0;overflow-wrap:anywhere}.pl-candidate-rule>label{display:flex;align-items:center;gap:8px;font-weight:550;font-size:12px}.pl-candidate-rule p{font-size:11px;color:var(--pl-muted);line-height:1.9;margin-top:5px}.pl-candidate-rule .pl-pre{font-size:11px;max-height:170px}.pl-candidate-rule input{flex:none}.pl-diff{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}.pl-diff pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:290px;overflow:auto;font:11px/1.8 Consolas,'Microsoft YaHei UI',monospace;background:var(--pl-soft);padding:10px;border:1px solid var(--pl-line);border-radius:7px;color:var(--pl-text)}.pl-diff span{display:block;min-height:1.8em}.pl-diff .added{background:color-mix(in srgb,var(--pl-green) 13%,transparent)}.pl-diff .removed{background:color-mix(in srgb,#c75a5a 13%,transparent)}.pl-diff-label{font-size:10px;color:var(--pl-muted);margin-bottom:5px}.pl-studio-status{padding:12px;background:var(--pl-pill);border-radius:8px;font-size:11px;line-height:1.8}.pl-ai-entry{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.pl-ai-entry .pl-btn{font-size:11px}
@container(max-width:850px){.pl-studio-grid{grid-template-columns:1fr}.pl-studio-body{padding:16px}.pl-studio-form,.pl-candidate{padding:16px}.pl-studio-head{padding:15px 17px}.pl-diff{grid-template-columns:1fr}}
.pl-experiment{padding:20px;margin-top:18px}.pl-experiment h3{font-size:14px}.pl-experiment h4{font-size:12px;margin:15px 0 8px}.pl-experiment .pl-textarea{min-height:90px;padding:10px}.pl-experiment .pl-select{max-width:100%}.pl-experiment .pl-diff>div{min-width:0}.pl-experiment .pl-inline input{flex:1;min-width:90px}.pl-studio-body>.pl-select{width:100%}@container(max-width:500px){.pl-experiment{padding:15px}.pl-experiment .pl-select{width:100%}.pl-studio-body>.pl-studio-buttons .pl-btn{white-space:normal}}
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
        close: "M6 6l12 12M18 6L6 18",
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
    function RuleManager({ data, onCommitted, onAI }) {
      const empty = () => ({ id: "", name: "", text: "", enabled: true });
      const [draft, setDraft] = useState(() => retainedRuleDraft?.draft || empty());
      const saved = useRef(retainedRuleDraft?.saved || empty());
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [moreOpen, setMoreOpen] = useState(false);
      const [careOpen,setCareOpen]=useState(false);
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
        h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "共享规则库"), h("p", null, "从规范和反馈提取规则，在多套配置中重复使用。")),
          h("div", { className: "pl-ai-entry" }, onAI ? btn("AI 整理规则", () => onAI(draft.id ? [draft.id] : []), "accent", busy) : null,btn("去重与修剪",()=>setCareOpen(true),"",busy), btn("新建规则", () => choose(null), "", busy))),
        careOpen?h(RuleCarePanel,{data,onCommitted,onAI,onClose:()=>setCareOpen(false)}):null,
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
              !data.ruleSets.length ? h("div", { className: "pl-empty" }, "规则库还是空的，", h("br"), "可以用 AI 从规范或反馈中提取。") : null),
            h("div", { className: "pl-collection-foot" }, "停用规则会影响所有引用它的配置")),
          h("div", { className: "pl-surface pl-library-editor" },
            h("div", { className: "pl-section-head" }, h("h2", { className: "pl-section-title" }, draft.id ? "编辑规则" : "新建规则"), toggle("启用此共享规则", draft.enabled, value => change("enabled", value), busy)),
            h("label", { className: "pl-field" }, "规则名称"),
            h("input", { className: "pl-select", "aria-label": "规则名称", maxLength: 80, placeholder: "例如：代码审查规范", value: draft.name, disabled: busy, onChange: e => change("name", e.target.value) }),
            h("label", { className: "pl-field" }, "规则正文"),
            h("textarea", { className: "pl-textarea", "aria-label": "规则正文", placeholder: "编写可复用的约定与要求…", value: draft.text, disabled: busy, onChange: e => change("text", e.target.value) }),
            h("p", { className: "pl-library-ref" }, selectedRule?.usedBy?.length ? "引用此规则的配置：" + selectedRule.usedBy.map(item => item.name).join("、") + "。删除前须解除全部引用。" : "暂无配置引用"),
            h("div", { className: "pl-library-actions" },
              h("div", { className: "pl-library-more" }, h("button", { className: "pl-btn quiet", type: "button",disabled:busy, "aria-expanded": moreOpen, onClick: () => setMoreOpen(!moreOpen) }, icon("more"), "更多操作"),
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
     * 会话页签里的主面板：配置、规则库、导入导出和设置；诊断收在设置内。
     *
     * 组件自身不持有业务状态：展示的内容都是最近一次 GET /prompt-lab/api 的快照，
     * 编辑动作再 POST 回同一接口；真正的状态在宿主进程侧的 lib/state.js 里。
     * 挂载时机由宿主的页签切换决定（未选中的 View 不渲染），所以「进入页签 = 开始拉取，
     * 切走 = 卸载并停止轮询」。
     */
    // 仅在当前模块内存保留一份未保存草稿，切走宿主页签后再回来可恢复；不写磁盘。
    const studioDraftKey = draft => JSON.stringify([draft.id,draft.version,draft.prompt,draft.rules,draft.ruleIds,draft.promptEnabled,draft.rulesEnabled]);
    function lineDiff(before, after) {
      const a=before.split("\n"), b=after.split("\n");
      if (a.length*b.length>90000) return {left:a.map(text=>({text})),right:b.map(text=>({text})),approximate:true};
      const table=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
      for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i][j]=a[i]===b[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
      const left=[],right=[];let i=0,j=0;
      while(i<a.length||j<b.length){
        if(i<a.length&&j<b.length&&a[i]===b[j]){left.push({text:a[i++]});right.push({text:b[j++]});}
        else if(j<b.length&&(i===a.length||table[i][j+1]>=table[i+1][j]))right.push({text:b[j++],kind:'added'});
        else left.push({text:a[i++],kind:'removed'});
      }
      return {left,right};
    }
    const studioAPI=(method="GET",body,query="")=>api(method,body,0,"/prompt-lab/api/studio"+query);
    const dialogControls=root=>[...root.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(node=>{
      if(node.disabled||!node.getClientRects().length)return false;
      for(let parent=node.parentElement;parent&&parent!==root;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&node!==parent.querySelector(':scope > summary'))return false;
      return true;
    });
    function ToolDialog({title,onClose,children}){
      const ref=useRef(null);
      useEffect(()=>{const previous=document.activeElement;ref.current?.focus();return()=>previous?.focus?.();},[]);
      return h("div",{className:"pl-studio-overlay"},h("section",{className:"pl-studio",role:'dialog','aria-modal':true,'aria-label':title,ref,tabIndex:-1,onKeyDown:e=>{
        if(e.key==='Escape'){e.stopPropagation();onClose();}
        if(e.key==='Tab'){const nodes=dialogControls(ref.current);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
      }},h("header",{className:"pl-studio-head"},h("h2",null,title),iconButton("关闭"+title,'close',onClose)),h("div",{className:"pl-studio-body"},children)));
    }
    function RuleCarePanel({data,onCommitted,onAI,onClose}){
      const [analysis,setAnalysis]=useState(null),[ids,setIds]=useState([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
      async function load(){const r=await studioAPI('GET',undefined,'?kind=rules-analysis');setAnalysis(r);setIds([]);}
      useEffect(()=>{load().catch(e=>setError(e.message));},[]);
      async function maintain(mode){
        const rules=analysis.rules.filter(r=>ids.includes(r.id)),used=[...new Set(rules.flatMap(r=>r.usedBy.map(p=>p.name)))];
        if(!window.confirm((mode==='delete'?'删除':'停用')+'所选 '+ids.length+' 条规则？'+(used.length?'影响引用配置：'+used.join('、'):'所选规则未被引用')+'。操作将记录版本。'))return;
        setBusy(true);setError('');try{const r=await studioAPI('POST',{action:'rules.maintain',mode,ids,versions:Object.fromEntries(rules.map(r=>[r.id,r.version])),confirm:true,expectedStoreVersion:analysis.storeVersion});onCommitted(r);await load();}catch(e){setError(e.message);}finally{setBusy(false);}
      }
      const selected=analysis?.rules.filter(r=>ids.includes(r.id))||[];
      return h(ToolDialog,{title:'规则去重与修剪',onClose},h("p",{className:'pl-notice'},'完全相同正文可直接核对；语义合并由 AI 提案并人工审阅。停用会影响所有引用配置；只允许删除未引用规则。合并另存时只替换新方案引用。'),
        error?h('p',{className:'pl-error'},error):null,analysis?h(React.Fragment,null,h('p',{className:'pl-studio-note'},'发现 '+analysis.duplicates.length+' 组相同正文，'+analysis.rules.filter(r=>!r.usedBy.length).length+' 条未引用规则。'),
          ...analysis.duplicates.map((group,i)=>h('p',{className:'pl-studio-note',key:i},'重复组 '+(i+1)+'：'+group.map(id=>analysis.rules.find(r=>r.id===id).name).join('、'))),
          btn('选择未引用规则',()=>setIds(analysis.rules.filter(r=>!r.usedBy.length).map(r=>r.id)),'quiet',busy),btn('清空选择',()=>setIds([]),'quiet',busy),
          ...analysis.rules.map(r=>h('div',{className:'pl-candidate-rule',key:r.id},h('label',null,h('input',{type:'checkbox',checked:ids.includes(r.id),'aria-label':'维护规则 '+r.name,disabled:busy,onChange:e=>setIds(v=>e.target.checked?[...v,r.id]:v.filter(id=>id!==r.id))}),r.name+' · '+(r.enabled?'启用':'停用')),h('p',{className:'pl-studio-note'},r.usedBy.length?'影响：'+r.usedBy.map(p=>p.name).join('、'):'没有配置引用'),h('details',{className:'pl-details'},h('summary',null,'规则正文'),h('pre',{className:'pl-pre'},r.text)))),
          h('div',{className:'pl-studio-buttons'},btn('AI 合并所选规则',()=>{onClose();onAI(ids,'curate');},'accent',busy||ids.length<2),btn('停用所选规则',()=>maintain('disable'),'',busy||!ids.length),btn('删除未引用规则',()=>maintain('delete'),'danger',busy||!ids.length||selected.some(r=>r.usedBy.length)),btn('重新载入引用关系',()=>load().catch(e=>setError(e.message)),'quiet',busy))):h('p',null,'读取规则引用…'));
    }
    function VersionPanel({data,profileId,onCommitted,onOpenProfile,onClose}){
      const [revisions,setRevisions]=useState([]),[record,setRecord]=useState(null),[side,setSide]=useState('after'),[chosen,setChosen]=useState(profileId),[ruleId,setRuleId]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[restored,setRestored]=useState(null),[loading,setLoading]=useState(true),[pending,setPending]=useState(0);
      async function load(){setLoading(true);try{const r=await studioAPI('GET',undefined,'?kind=versions');setRevisions(r.revisions);setPending(r.pending||0);}finally{setLoading(false);}}
      useEffect(()=>{load().catch(e=>setError(e.message));},[]);
      async function choose(id){setError('');setRecord(null);try{if(id){const r=await studioAPI('GET',undefined,'?kind=revision&id='+encodeURIComponent(id));setRecord(r.revision);}}catch(e){setError(e.message);}}
      const graph=record?.[side],profile=graph?.profiles.find(p=>p.id===chosen),rule=graph?.ruleSets.find(r=>r.id===ruleId);
      async function restore(mode,asRule=false){
        if(mode==='replace'&&!window.confirm('用此快照替换当前编辑配置的已保存正文、规则顺序和开关？旧共享规则会复制恢复，其他配置保持原内容。当前未保存草稿仍保留。'))return;
        setBusy(true);setError('');try{const target=data.profiles.find(p=>p.id===profileId),r=await studioAPI('POST',{action:'revision.restore',revisionId:record.id,side,profileId:chosen,mode,targetId:profileId,expectedVersion:target?.version,ruleId:asRule?ruleId:undefined,confirm:mode==='replace',expectedStoreVersion:data.storage.storeVersion});onCommitted(r);setRestored(r);await load();}catch(e){setError(e.message);}finally{setBusy(false);}
      }
      return h(ToolDialog,{title:'版本记录与恢复',onClose},h('p',{className:'pl-notice'},'保存配置、规则或启用项时记录前后快照，最多保留最近 30 条且总计 32 MiB。恢复会保留正文、规则内容、顺序与开关；不会自动切换全局启用项。设置页开关不属于这些资产版本。'),
        error?h('p',{className:'pl-error'},error):null,h('select',{className:'pl-select','aria-label':'选择资产版本',value:record?.id||'',disabled:busy,onChange:e=>choose(e.target.value)},h('option',{value:''},'选择一次保存记录'),...revisions.map(r=>h('option',{key:r.id,value:r.id},r.createdAt+' · 数据版本 '+r.storeVersion+' · '+r.profiles.filter(p=>r.changes.profiles.includes(p.id)).map(p=>p.name).join('、')))),
        loading?h('p',{className:'pl-empty'},'读取版本记录…'):!revisions.length?h('p',{className:'pl-empty'},'尚无版本记录。此功能从安装本版后的首次资产保存开始记录。'):null,
        pending?h('p',{className:'pl-notice'},pending+' 条保存记录尚无法确认提交，已保留原文件，未列入可恢复版本。'):null,
        record?h(React.Fragment,null,h('label',{className:'pl-field'},'查看快照'),h('select',{className:'pl-select','aria-label':'快照方向',value:side,disabled:busy,onChange:e=>setSide(e.target.value)},h('option',{value:'before'},'本次保存之前'),h('option',{value:'after'},'本次保存之后')),
          h('label',{className:'pl-field'},'恢复配置'),h('select',{className:'pl-select','aria-label':'快照中的配置',value:profile?.id||'',disabled:busy,onChange:e=>setChosen(e.target.value)},h('option',{value:''},'选择配置'),...graph.profiles.map(p=>h('option',{key:p.id,value:p.id},p.name))),
          profile?h(React.Fragment,null,h('p',{className:'pl-studio-note'},'正文 '+(profile.promptEnabled?'启用':'停用')+' · 规则段 '+(profile.rulesEnabled?'启用':'停用')),h('pre',{className:'pl-pre'},profile.prompt),h('pre',{className:'pl-pre'},profile.rules||'（无附加规则）'),
            ...profile.ruleIds.map((id,i)=>{const r=graph.ruleSets.find(r=>r.id===id);return h('details',{className:'pl-details',key:id},h('summary',null,(i+1)+'. '+r.name+' · '+(r.enabled?'启用':'停用')),h('pre',{className:'pl-pre'},r.text));}),
            h('div',{className:'pl-studio-buttons'},btn('另存恢复方案',()=>restore('copy'),'accent',busy),btn('替换当前已保存配置',()=>restore('replace'),'',busy))):null,
          h('details',{className:'pl-details'},h('summary',null,'只恢复一条历史规则'),h('div',{className:'pl-details-content'},h('select',{className:'pl-select','aria-label':'快照中的规则',value:ruleId,disabled:busy,onChange:e=>setRuleId(e.target.value)},h('option',{value:''},'选择规则'),...graph.ruleSets.map(r=>h('option',{key:r.id,value:r.id},r.name))),rule?h(React.Fragment,null,h('pre',{className:'pl-pre'},rule.text),btn('另存恢复规则',()=>restore('copy',true),'',busy)):null))):null,
        restored?h('p',{className:'pl-notice'},'已保存恢复结果，未自动启用。',restored.editedId?btn('打开恢复方案',()=>{if(onOpenProfile(restored,restored.editedId))onClose();},'quiet',busy):null):null);
    }
    function ModelRoute({label,value,onChange,providers,disabled}) {
      const [models,setModels]=useState([]),[error,setError]=useState("");
      useEffect(()=>{let live=true;if(value?.provider)studioAPI("GET",undefined,"?provider="+encodeURIComponent(value.provider)).then(r=>{if(live)setModels(r.models||[]);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[value?.provider]);
      return h("div",null,h("label",{className:"pl-field"},label),
        h("select",{className:"pl-select","aria-label":label+"供应商",disabled,value:value?.provider||"",onChange:e=>onChange({provider:e.target.value,model:""})},...(providers||[]).map(p=>h("option",{key:p.id,value:p.id},p.name||p.id))),
        h("select",{className:"pl-select","aria-label":label,disabled,value:value?.model||"",onChange:e=>onChange({...value,model:e.target.value}),style:{marginTop:7}},
          !models.some(m=>m.id===value?.model)?h("option",{value:value?.model||""},value?.model||"请选择模型"):null,...models.map(m=>h("option",{key:m.id,value:m.id},m.name||m.id))),
        h("select",{className:"pl-select","aria-label":label+"推理强度",disabled,value:value?.reasoningEffort||"",onChange:e=>{const next={...value};if(e.target.value)next.reasoningEffort=e.target.value;else delete next.reasoningEffort;onChange(next);},style:{marginTop:7}},
          ...[["","宿主默认推理强度"],["low","低"],["medium","中"],["high","高"],["max","最高"]].map(([id,name])=>h("option",{key:id,value:id},name))),
        h('label',{className:'pl-field'},'温度（留空使用宿主默认）',h('input',{className:'pl-select',type:'number',min:0,max:2,step:0.05,value:value?.temperature??'',disabled,onChange:e=>{const next={...value};if(e.target.value==='')delete next.temperature;else next.temperature=Number(e.target.value);onChange(next);}})),error?h("p",{className:"pl-studio-note"},error):null);
    }
    function SessionBindings({data,profileId,onCommitted,onClose}) {
      const [sessions,setSessions]=useState([]),[sessionId,setSessionId]=useState(''),[profile,setProfile]=useState(profileId),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
      const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
      async function list(){setError('');try{const r=await studioAPI('GET',undefined,'?kind=sessions');setSessions(r.sessions);}catch(e){setError(e.message);}}
      useEffect(()=>{list();},[]);
      async function inspect(){const ticket=++epoch.current;setBusy(true);setError('');setPreview(null);try{const r=await studioAPI('POST',{action:'binding.preview',sessionId,profileId:profile});if(ticket===epoch.current)setPreview(r);}catch(e){if(ticket===epoch.current)setError(e.message);}finally{if(ticket===epoch.current)setBusy(false);}}
      async function apply(removeId){setBusy(true);setError('');try{const r=await studioAPI('POST',removeId?{action:'binding.remove',sessionId:removeId,expectedRevision:data.sessionBindings.revision}:{action:'binding.save',sessionId,profileId:profile,hash:preview.draft.hash,expectedRevision:preview.revision,confirm:true});onCommitted(r);setPreview(null);}catch(e){setError(e.message);}finally{setBusy(false);}}
      return h(ToolDialog,{title:'会话适用范围',onClose},h('p',{className:'pl-notice'},'为明确选择的会话固定一份已保存配置和规则快照。其他会话继续使用全局启用项。编辑原配置、修改共享规则或切换全局启用项不会改变已绑定快照；更新需重新预览绑定。子会话不会自动继承。'),
        data.sessionBindings?.error?h('p',{className:'pl-error'},data.sessionBindings.error):null,error?h('p',{className:'pl-error',role:'alert'},error):null,
        h('label',{className:'pl-field'},'目标会话与项目',h('select',{className:'pl-select','aria-label':'绑定目标会话',value:sessionId,disabled:busy,onChange:e=>{epoch.current++;setPreview(null);setSessionId(e.target.value);}},h('option',{value:''},'明确选择一个会话'),...sessions.map(v=>h('option',{key:v.id,value:v.id},(v.title||v.id)+' · '+(v.workspace||'项目未知'))))),
        h('label',{className:'pl-field'},'使用已保存配置',h('select',{className:'pl-select','aria-label':'会话绑定配置',value:profile,disabled:busy,onChange:e=>{epoch.current++;setPreview(null);setProfile(e.target.value);}},...data.profiles.map(v=>h('option',{key:v.id,value:v.id},v.name+' · v'+v.version)))),
        h('div',{className:'pl-studio-buttons'},btn('刷新目标会话',list,'quiet',busy),btn('预览绑定快照',inspect,'',busy||!sessionId||!!data.sessionBindings?.error)),
        preview?h('section',{className:'pl-candidate-rule'},h('h3',null,preview.draft.profile.name+' · v'+preview.draft.profile.version),h('p',{className:'pl-studio-note'},'会话 '+preview.draft.sessionId+' · '+(preview.draft.workspace||'项目未知')+' · SHA-256 '+preview.draft.hash),h('details',{className:'pl-details'},h('summary',null,'核对固定的正文、规则与开关'),h('pre',{className:'pl-pre'},JSON.stringify(preview.draft,null,2))),btn('确认仅绑定此会话',()=>apply(),'accent',busy)):null,
        h('h3',null,'已绑定 '+(data.sessionBindings?.bindings.length||0)+' / '+(data.sessionBindings?.limit||20)),...(data.sessionBindings?.bindings||[]).map(v=>h('div',{className:'pl-candidate-rule',key:v.sessionId},h('p',null,v.profileName+' · v'+v.profileVersion+' → '+v.sessionId),h('p',{className:'pl-studio-note'},v.workspace||'项目未知'),h('p',{className:'pl-studio-note'},'规则 '+v.ruleVersions.map(r=>r.name+' v'+r.version).join('、')+' · '+timeText(v.updatedAt)),btn('解除绑定 '+v.sessionId,()=>{if(window.confirm('解除该会话绑定，后续组装恢复全局启用配置？'))apply(v.sessionId);},'quiet',busy||!!data.sessionBindings?.error))));
    }
    function WorkspacePicker({onChange,disabled}) {
      const [cwd,setCwd]=useState(''),[root,setRoot]=useState(''),[scan,setScan]=useState(null),[chosen,setChosen]=useState([]),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[sessions,setSessions]=useState([]);
      const epoch=useRef(0);
      useEffect(()=>()=>{epoch.current++;},[]);
      function clear(){epoch.current++;setBusy(false);setScan(null);setChosen([]);setPreview(null);onChange(null);}
      async function discover(){const ticket=++epoch.current;setBusy(true);setError('');setScan(null);setChosen([]);setPreview(null);onChange(null);
        try{const result=await studioAPI('POST',{action:'workspace.scan',cwd,root});if(ticket===epoch.current)setScan(result);}catch(e){if(ticket===epoch.current)setError(e.message);}finally{if(ticket===epoch.current)setBusy(false);}}
      function select(file,checked){const next=checked?[...chosen,file]:chosen.filter(f=>f.path!==file.path);setChosen(next);setPreview(null);onChange(next.length?{cwd:scan.cwd,root:scan.root,files:next.map(f=>({path:f.path,hash:f.hash}))}:null);}
      async function inspect(){const ticket=++epoch.current;setBusy(true);setError('');try{const r=await studioAPI('POST',{action:'workspace.preview',selection:{cwd:scan.cwd,root:scan.root,files:chosen.map(f=>({path:f.path,hash:f.hash}))}});if(ticket===epoch.current)setPreview(r.source);}catch(e){if(ticket===epoch.current){setError(e.message);onChange(null);setChosen([]);}}finally{if(ticket===epoch.current)setBusy(false);}}
      async function projects(){try{const r=await studioAPI('GET',undefined,'?kind=sessions');setSessions(r.sessions.filter(v=>v.workspace));}catch(e){setError(e.message);}}
      return h('details',{className:'pl-details'},h('summary',null,'从项目规范选择'+(chosen.length?' · '+chosen.length+' 个文件':'')),h('div',{className:'pl-details-content'},
        h('p',{className:'pl-studio-note'},'读取项目根到工作目录的 AGENTS / CLAUDE 规范，不递归扫描。勾选内容会随生成发给所选模型，原文件不会被修改。宿主是否已加载默认为未知。'),
        h('label',{className:'pl-field'},'工作目录（绝对路径）',h('input',{className:'pl-select','aria-label':'项目规范工作目录',value:cwd,disabled:disabled||busy,maxLength:2000,onChange:e=>{clear();setCwd(e.target.value);}})),
        h('label',{className:'pl-field'},'项目根目录（可选，留空查找最近版本库根）',h('input',{className:'pl-select','aria-label':'项目规范根目录',value:root,disabled:disabled||busy,maxLength:2000,onChange:e=>{clear();setRoot(e.target.value);}})),
        btn('从会话选择项目目录',projects,'quiet',disabled||busy),sessions.length?h('select',{className:'pl-select','aria-label':'规范来源项目',value:'',disabled:disabled||busy,onChange:e=>{clear();setRoot('');setCwd(e.target.value);}},h('option',{value:''},'选择会话工作目录'),...sessions.map(v=>h('option',{key:v.id,value:v.workspace},(v.title||v.id)+' · '+v.workspace))):null,
        btn(busy?'读取中…':'扫描规范文件',discover,'',disabled||busy||!cwd.trim()),error?h('p',{className:'pl-error'},error):null,
        scan?h('p',{className:'pl-studio-note'},'项目根：'+scan.root+' · '+scan.files.length+' 个候选；所选 '+chosen.reduce((n,f)=>n+(f.bytes||0),0)+' / 90,000 字节'):null,
        scan&&!scan.files.length?h('p',{className:'pl-notice'},'此范围内没有候选规范文件。'):null,
        ...(scan?.files||[]).map(f=>h('details',{className:'pl-details',key:'scan:'+f.path},h('summary',null,f.name+' · '+f.scope),h('div',{className:'pl-details-content'},
          h('label',{className:'pl-inline pl-studio-note'},h('input',{type:'checkbox','aria-label':'选择项目规范 '+f.path,checked:chosen.some(v=>v.path===f.path),disabled:disabled||busy||!f.available||(!chosen.some(v=>v.path===f.path)&&chosen.length>=16),onChange:e=>select(f,e.target.checked)}),f.path),
          h('p',{className:'pl-studio-note'},f.available?f.bytes+' 字节 · '+timeText(f.mtime)+' · SHA-256 '+f.hash:f.error),h('pre',{className:'pl-pre'},f.preview||'（没有可预览内容）')))),
        chosen.length?btn('预览所选完整正文',inspect,'quiet',disabled||busy):null,
        ...(preview?.files||[]).map(f=>h('details',{className:'pl-details',key:'preview:'+f.path},h('summary',null,'已选正文 · '+f.path),h('pre',{className:'pl-pre'},f.text))),
        chosen.length?btn('清除项目材料选择',clear,'quiet',disabled||busy):null));
    }
    function InjectionDiagnostics({data}) {
      const d=data?.diagnostics;if(!d)return null;
      return h('div',{'aria-label':'分层注入诊断'},
        ...[['已保存','配置 '+d.saved.profileId+' · v'+(d.saved.profileVersion??'?')+' · 存储 r'+d.saved.storeVersion],['段注册',d.registered?d.sections.map(v=>v.name+' / '+v.order).join('；'):'未注册'],['最近求值',d.evaluated?timeText(d.evaluated.evaluatedAt)+(d.evaluated.stale?' · 已过期':'')+(d.evaluated.sessionId?' · 会话 '+d.evaluated.sessionId:' · 无会话关联'):'尚未求值'],['最近组装',d.observed?timeText(d.observed.at)+(d.observed.stale?' · 已过期':'')+(d.observed.sessionId?' · 会话 '+d.observed.sessionId:' · 进程观察'):'尚未观察'],['最终请求',d.requestEvidence.reason]].map(([label,value])=>h('div',{className:'pl-diagnostic-row',key:label},h('span',null,label),h('span',null,value))),
        h('details',{className:'pl-details'},h('summary',null,'当前全局配置来源与排除原因'),...d.sources.map((v,i)=>h('div',{className:'pl-candidate-rule',key:i},h('p',null,v.name+' · v'+v.version+' · '+(v.included?'预览包含':'预览排除')),h('p',{className:'pl-studio-note'},v.reason+' · '+v.chars+' 字 · SHA-256 '+v.hash)))),
        d.evaluated?.binding?h('p',{className:'pl-notice'},'最近求值使用会话固定快照：'+d.evaluated.binding.profileId+' v'+d.evaluated.binding.profileVersion+' · '+d.evaluated.binding.sessionId):null,
        data.sessionBindings?.error?h('p',{className:'pl-error'},data.sessionBindings.error):null,h('p',{className:'pl-studio-note'},d.duplicateCoverage),...d.duplicates.map((v,i)=>h('p',{className:'pl-notice',key:i},'原文重复：'+v.sourceName+' ↔ '+v.other+'（忽略空白差异；需核对是否重复注入）')));
    }
    function SessionPicker({onChange,disabled,available}) {
      const [sessions,setSessions]=useState([]),[id,setId]=useState(""),[preview,setPreview]=useState(null),[selected,setSelected]=useState([]),[error,setError]=useState("");
      const lifecycle=useRef({mounted:true,preview:0,list:0});
      useEffect(()=>{lifecycle.current.mounted=true;return()=>{lifecycle.current.mounted=false;lifecycle.current.preview++;lifecycle.current.list++;};},[]);
      async function list(){const ticket=++lifecycle.current.list;try{setError("");const r=await studioAPI("GET",undefined,"?kind=sessions");if(lifecycle.current.mounted&&ticket===lifecycle.current.list)setSessions(r.sessions);}catch(e){if(lifecycle.current.mounted&&ticket===lifecycle.current.list)setError(e.message);}}
      function reset(){lifecycle.current.preview++;setPreview(null);setSelected([]);onChange(null);}
      async function inspect(value){reset();setError("");if(!value)return;const ticket=lifecycle.current.preview;try{const r=await studioAPI("GET",undefined,"?kind=session&id="+encodeURIComponent(value));if(lifecycle.current.mounted&&ticket===lifecycle.current.preview)setPreview(r);}catch(e){if(lifecycle.current.mounted&&ticket===lifecycle.current.preview)setError(e.message);}}
      function select(seq,checked){const ids=checked?[...selected,seq]:selected.filter(s=>s!==seq);setSelected(ids);onChange(ids.length?{sessionId:preview.sessionId,events:preview.messages.filter(m=>ids.includes(m.seq)).map(m=>({seq:m.seq,hash:m.hash}))}:null);}
      return h("details",{className:"pl-details"},h("summary",null,"从会话中选择反馈"),h("div",{className:"pl-details-content"},
        h("p",{className:"pl-studio-note"},"先预览，再勾选 1–12 条消息。只发送所选可见文字；工具结果与推理不带入。长消息只取预览的前 6000 字。助手自述不视为已验证结果。"),
        !available?h("p",{className:"pl-notice"},"当前宿主未提供会话服务，可以在材料区粘贴反馈。"):null,
        btn("读取会话列表",list,"",disabled||!available),
        h("select",{className:"pl-select","aria-label":"反馈来源会话",value:id,disabled:disabled||!available,onChange:e=>{setId(e.target.value);inspect(e.target.value);}},h("option",{value:""},"选择最近 60 个会话之一"),...sessions.map(s=>h("option",{key:s.id,value:s.id},s.title||[s.workspace,s.createdAt,s.id].filter(Boolean).join(" · ")))),
        h("label",{className:"pl-field"},"或填写较早会话 ID"),h("input",{className:"pl-select","aria-label":"反馈会话 ID",value:id,disabled,maxLength:200,onChange:e=>{reset();setId(e.target.value);}}),btn("预览此会话",()=>inspect(id),"quiet",disabled||!available||!id),
        error?h("p",{className:"pl-error"},error):null,preview?h("p",{className:"pl-studio-note"},"已选 "+selected.length+" 条 · 会话 "+preview.sessionId+" · 读取至事件 "+preview.capturedThroughSeq):null,
        ...(preview?.messages||[]).map(m=>h("div",{className:"pl-candidate-rule",key:m.seq},h("label",null,h("input",{type:"checkbox","aria-label":"选择反馈消息 "+m.seq,checked:selected.includes(m.seq),disabled:disabled||(!selected.includes(m.seq)&&selected.length>=12),onChange:e=>select(m.seq,e.target.checked)}),m.role+" · #"+m.seq+(m.truncated?" · 已截断":"")),h("pre",{className:"pl-pre"},m.text)))));
    }
    function ExperimentResults({job}) {
      const result=job?.result;if(!result||['examples','regression'].includes(result.kind))return null;
      const comparisons=[result.comparison&&["两版对比",result.comparison],...result.rounds.map(r=>["训练轮次 "+r.round+(r.selected?" · 留作候选":" · 未选中"),r.comparison]),result.validation&&["独立保留样例",result.validation],result.current&&["进行中的对比",result.current]].filter(Boolean);
      const rowView=row=>h("div",null,h("p",{className:"pl-studio-note"},row.error?"失败："+row.error:(row.pass?"通过":"未通过")+" · 得分 "+row.score.toFixed(2)+" · "+row.latencyMs+" ms"),h("pre",{className:"pl-pre"},row.output||"（无输出）"),
        ...row.checks.map((c,i)=>h("p",{className:"pl-studio-note",key:i},(c.pass?"✓ ":"× ")+c.type+" · "+c.reason)),row.semantic?h("p",{className:"pl-studio-note"},"语义评分 "+row.semantic.score+" · "+row.semantic.reason):null,
        row.route?h("p",{className:"pl-studio-note"},row.route.provider+" / "+row.route.model+" · 输入 "+(row.usage?.inputTokens??"未知")+" / 输出 "+(row.usage?.outputTokens??"未知")+" Token"):null);
      return h("section",{className:"pl-surface pl-experiment","aria-label":"试跑结果"},h("h3",null,result.complete?(result.accepted?"文本试跑有提升 · 待人工审阅":"未证明提升 · 保留原版"):"试跑尚未完整完成 · 不可据此认定提升"),
        h("p",{className:"pl-studio-note"},result.scope),h("p",{className:"pl-studio-note"},"测试集 "+result.suite.name+" · 修订 "+result.suite.revision+" · "+result.suite.hash),
        result.exploratory?h("p",{className:"pl-notice"},"探索性结果：保留样例少于 3 条或已重复使用。请补充独立真实失败样例，避免针对测试集过拟合。"):null,
        ...comparisons.map(([label,comparison],i)=>h("details",{className:"pl-details",key:i,open:i===comparisons.length-1},h("summary",null,label+(comparison.summary?" · 当前 "+comparison.summary.baseline.passed+" / 候选 "+comparison.summary.candidate.passed+" 通过":"")),h("div",{className:"pl-details-content"},
          ...comparison.baseline.map((left,index)=>h("div",{key:left.caseId},h("h4",null,left.caseId+" · "+left.split),h("div",{className:"pl-diff"},h("div",null,h("p",{className:"pl-diff-label"},"当前草稿"),rowView(left)),h("div",null,h("p",{className:"pl-diff-label"},"候选"),comparison.candidate[index]?rowView(comparison.candidate[index]):"等待输出"))))))),
        h("details",{className:"pl-details"},h("summary",null,"冻结输入、预算与调用记录"),h("pre",{className:"pl-pre"},JSON.stringify({input:job.input,calls:job.calls,usage:job.usage},null,2))));
    }
    function ExperimentPanel({seed,indices,activeJob,route,cap,disabled,onStart,getContext,onOpenProfile,onRouteLoaded}) {
      const [suites,setSuites]=useState([]),[suite,setSuite]=useState(null),[savedSuite,setSavedSuite]=useState(''),[error,setError]=useState(""),[saving,setSaving]=useState(false);
      const [scenarios,setScenarios]=useState([]),[scenarioName,setScenarioName]=useState(''),[scenarioPreview,setScenarioPreview]=useState(null),[scenarioBusy,setScenarioBusy]=useState(false);
      const scenarioEpoch=useRef(0);useEffect(()=>()=>{scenarioEpoch.current++;},[]);
      const [failureSelection,setFailureSelection]=useState(null),[correction,setCorrection]=useState('');
      const [target,setTarget]=useState(null),[judge,setJudge]=useState(null),[common,setCommon]=useState("");
      const [budgetBase,setBudgetBase]=useState({});
      const [maxCalls,setMaxCalls]=useState(24),[maxRounds,setMaxRounds]=useState(2),[maxOutputTotal,setMaxOutputTotal]=useState(24000);
      useEffect(()=>{if(route){setTarget(r=>r||route);setJudge(r=>r||route);}},[route?.provider,route?.model]);
      async function reload(){const r=await studioAPI("GET",undefined,"?kind=suites");setSuites(r.suites);if(r.warning)setError(r.warning);}
      useEffect(()=>{reload().catch(e=>setError(e.message));},[]);
      useEffect(()=>{if(['examples','regression'].includes(activeJob?.result?.kind)){setSuite(activeJob.result.suite);setSavedSuite(JSON.stringify(activeJob.result.suite));reload().catch(e=>setError(e.message));}},[activeJob?.result?.suite?.id,activeJob?.id,activeJob?.status]);
      const newCase=split=>({id:'case-'+Math.random().toString(36).slice(2,8),split,input:'',reference:'',checks:[{type:'contains',value:''}],rubric:'',threshold:0.7});
      function update(index,key,value){setSuite(s=>({...s,cases:s.cases.map((c,i)=>i===index?{...c,[key]:value,...(c.source?{source:{...c.source,confirmed:false}}:{})}:c)}));}
      async function save(){setSaving(true);setError("");try{const r=await studioAPI("POST",{action:'suite.save',suite:{...suite,expectedRevision:suite.revision}});setSuite(r.suite);setSavedSuite(JSON.stringify(r.suite));await reload();}catch(e){setError(e.message);}finally{setSaving(false);}}
      async function choose(id){if(suite&&JSON.stringify(suite)!==savedSuite&&!window.confirm('放弃未保存的测试集编辑并切换？'))return;setError("");try{const next=id?(await studioAPI("GET",undefined,"?kind=suite&id="+encodeURIComponent(id))).suite:null;setSuite(next);setSavedSuite(JSON.stringify(next));}catch(e){setError(e.message);}}
      async function remove(){if(!window.confirm("删除这个测试集？已有任务的冻结样例仍保留。"))return;try{await studioAPI("POST",{action:'suite.remove',id:suite.id,expectedRevision:suite.revision});setSuite(null);await reload();}catch(e){setError(e.message);}}
      function start(operation){onStart({operation,candidateJobId:seed?.id,indices,suiteId:suite?.id,suiteRevision:suite?.revision,targetRoute:target,judgeRoute:judge,commonContext:common,budget:{...budgetBase,maxCalls,maxRounds,maxOutputTotal},goal:'检验与改进当前候选'});}
      async function listScenarios(){const r=await studioAPI('GET',undefined,'?kind=scenarios');setScenarios(r.scenarios);if(r.warning)setError(r.warning);}
      async function saveScenario(){setScenarioBusy(true);setError('');try{const ctx=getContext(),r=await studioAPI('POST',{action:'scenario.save',name:scenarioName,profileId:ctx.draft.id,profileVersion:ctx.draft.version,draft:ctx.draft,route,targetRoute:target,judgeRoute:judge,suiteId:suite?.id,suiteRevision:suite?.revision,commonContext:common,budget:{...budgetBase,maxCalls,maxRounds,maxOutputTotal}});setScenarioPreview({scenario:r.scenario,canApply:true,reason:null});await listScenarios();}catch(e){setError(e.message);}finally{setScenarioBusy(false);}}
      async function inspectScenario(id){const ticket=++scenarioEpoch.current;setScenarioPreview(null);setError('');if(!id)return;setScenarioBusy(true);try{const r=await studioAPI('GET',undefined,'?kind=scenario&id='+encodeURIComponent(id));if(ticket===scenarioEpoch.current)setScenarioPreview(r);}catch(e){if(ticket===scenarioEpoch.current)setError(e.message);}finally{if(ticket===scenarioEpoch.current)setScenarioBusy(false);}}
      async function loadScenario(){const ticket=++scenarioEpoch.current;if(suite&&JSON.stringify(suite)!==savedSuite&&!window.confirm('放弃未保存测试集编辑并载入场景？'))return;setScenarioBusy(true);setError('');try{const r=await studioAPI('POST',{action:'scenario.load',id:scenarioPreview.scenario.id,hash:scenarioPreview.scenario.hash}),data=r.scenario.data;
        if(ticket!==scenarioEpoch.current)return;
        if(!onOpenProfile({profiles:[data.profile]},data.profile.id))return;
        onRouteLoaded(data.route);setTarget(data.targetRoute);setJudge(data.judgeRoute);setCommon(data.commonContext);setBudgetBase(data.budget);setMaxCalls(data.budget.maxCalls);setMaxRounds(data.budget.maxRounds);setMaxOutputTotal(data.budget.maxOutputTotal);setSuite(data.suite);setSavedSuite(JSON.stringify(data.suite));setScenarioPreview({...r,loaded:true});
      }catch(e){setError(e.message);}finally{setScenarioBusy(false);}}
      async function removeScenario(){setScenarioBusy(true);setError('');try{await studioAPI('POST',{action:'scenario.remove',id:scenarioPreview.scenario.id,hash:scenarioPreview.scenario.hash});setScenarioPreview(null);await listScenarios();}catch(e){setError(e.message);}finally{setScenarioBusy(false);}}
      const train=suite?.cases.filter(c=>c.split==='train').length||0,validation=suite?.cases.filter(c=>c.split==='validation').length||0;
      return h("section",{className:"pl-surface pl-experiment","aria-label":"试跑与迭代"},h("h3",null,"试跑与迭代"),h("p",{className:"pl-studio-note"},"候选："+(seed?.candidate?.content.name||"先生成一份带正文的候选")+"。固定同一测试模型、参数和背景，对比当前草稿与所勾选候选。仅测试补充段文本，不执行工具，也不代表 Coding Agent 实测。"),
        error?h("p",{className:"pl-error"},error):null,
        h('details',{className:'pl-details'},h('summary',null,'将失败对话加入回归集'),h('div',{className:'pl-details-content'},
          h(SessionPicker,{onChange:setFailureSelection,disabled,available:cap?.sessionAvailable}),
          h('label',{className:'pl-field'},'纠正意见与验收要求',h('textarea',{className:'pl-textarea','aria-label':'失败回归纠正意见',value:correction,maxLength:2000,disabled,onChange:e=>setCorrection(e.target.value)})),
          h('p',{className:'pl-studio-note'},'至少选择一条用户输入和一条失败回答。生成一条待确认训练样例，不自动保存。'),
          btn('AI 起草失败回归样例',()=>{if(suite&&JSON.stringify(suite)!==savedSuite&&!window.confirm('放弃未保存的测试集编辑并生成回归草稿？'))return;onStart({operation:'regression',sessionSelection:failureSelection,goal:correction});},'',disabled||!cap?.available||!failureSelection||!correction.trim()))),
        h("div",{className:"pl-studio-buttons"},btn("AI 生成测试样例",()=>start('examples'),"",disabled||!cap?.available),btn("手动新建测试集",()=>setSuite({name:'新测试集',cases:[newCase('train'),newCase('validation')]}),"quiet",disabled)),
        h("select",{className:"pl-select","aria-label":"选择测试集",value:suite?.id||"",disabled,onChange:e=>choose(e.target.value)},h("option",{value:""},"选择已保存测试集"),...suites.map(s=>h("option",{key:s.id,value:s.id},s.name+" · r"+s.revision+" · "+s.train+" 训练 / "+s.validation+" 保留"))),
        suite?h("details",{className:"pl-details",open:!suite.id?true:undefined},h("summary",null,"审核与编辑样例 · "+train+" 训练 / "+validation+" 保留"),h("div",{className:"pl-details-content"},
          h("p",{className:"pl-notice"},suite.origin==='ai'?"AI 样例草稿：请审核标准、事实参考和覆盖面。生成成功不证明提示词更好。":"训练样例用于改写；保留样例只作最后核验。多次使用同一保留集会降低结论可信度。"),
          h("input",{className:"pl-select","aria-label":"测试集名称",value:suite.name,disabled:disabled||saving,maxLength:80,onChange:e=>setSuite({...suite,name:e.target.value})}),
          ...suite.cases.map((c,i)=>h("details",{className:"pl-details",key:c.id,open:!suite.id?true:undefined},h("summary",null,(i+1)+". "+(c.input.slice(0,40)||"待填写样例")+" · "+c.split),h("div",{className:"pl-details-content"},
            h("select",{className:"pl-select","aria-label":"样例分组 "+i,value:c.split,disabled:disabled||!!c.source,onChange:e=>update(i,'split',e.target.value)},h("option",{value:'train'},"训练样例"),h("option",{value:'validation'},"独立保留样例")),
            ...[['input','用户输入',8000],['reference','参考答案或事实资料',4000],['rubric','语义评分标准（可选）',2000]].map(([key,label,max])=>h("label",{className:"pl-field",key},label,h("textarea",{className:"pl-textarea","aria-label":label+" "+i,value:c[key]||'',maxLength:max,disabled,onChange:e=>update(i,key,e.target.value)}))),
            c.source?h('div',{className:'pl-candidate-rule'},h('p',{className:'pl-studio-note'},'失败来源：'+c.source.sessionId+' · 消息 '+c.source.events.map(e=>e.seq).join(', ')+' · 助手声称，未经工具验证'),h('details',{className:'pl-details'},h('summary',null,'失败原文、纠正与来源哈希'),h('pre',{className:'pl-pre'},JSON.stringify(c.source,null,2))),h('label',{className:'pl-inline pl-studio-note'},h('input',{type:'checkbox','aria-label':'确认失败来源与评分标准 '+i,checked:c.source.confirmed===true,disabled,onChange:e=>setSuite(s=>({...s,cases:s.cases.map((v,n)=>n===i?{...v,source:{...v.source,confirmed:e.target.checked}}:v)}))}),'已核对来源、参考资料与检查标准'),btn('移除来源，作为手工样例',()=>{if(window.confirm('移除失败来源后，此样例将作为手工编辑材料；仍需独立核对验证集是否泄漏。'))setSuite(s=>({...s,cases:s.cases.map((v,n)=>{if(n!==i)return v;const {source,...plain}=v;return plain;})}));},'quiet',disabled)):null,
            h("label",{className:"pl-field"},"语义通过阈值（0–1）",h("input",{className:"pl-select",type:'number',min:0,max:1,step:0.05,value:c.threshold??0.7,disabled,onChange:e=>update(i,'threshold',Number(e.target.value))})),
            h("p",{className:"pl-studio-note"},"确定性检查（全数通过才算通过）"),...c.checks.map((check,j)=>h("div",{className:"pl-inline",key:j},h("select",{className:"pl-select","aria-label":"检查类型 "+i+" "+j,value:check.type,disabled,onChange:e=>update(i,'checks',c.checks.map((v,k)=>k===j?{type:e.target.value,...(e.target.value==='isJson'?{}:{value:e.target.value==='maxChars'?1000:e.target.value==='hasKeys'?['ok']:''})}:v))},
              ...[['contains','包含'],['notContains','不包含'],['equals','完全一致'],['startsWith','开头为'],['isJson','合法 JSON'],['hasKeys','JSON 必需字段'],['maxChars','最长字符数']].map(([id,name])=>h("option",{key:id,value:id},name))),
              check.type!=='isJson'?h("input",{className:"pl-select","aria-label":"检查内容 "+i+" "+j,value:Array.isArray(check.value)?check.value.join(','):check.value??'',disabled,onChange:e=>update(i,'checks',c.checks.map((v,k)=>k===j?{...v,value:check.type==='maxChars'?Number(e.target.value):check.type==='hasKeys'?e.target.value.split(',').map(s=>s.trim()).filter(Boolean):e.target.value}:v))}):null,
              btn("移除检查",()=>update(i,'checks',c.checks.filter((_,k)=>k!==j)),"quiet",disabled))),
            btn("添加检查",()=>update(i,'checks',[...c.checks,{type:'contains',value:''}]),"quiet",disabled||c.checks.length>=12),btn("删除样例",()=>setSuite({...suite,cases:suite.cases.filter((_,n)=>n!==i)}),"quiet",disabled||suite.cases.length<=1)))),
          h("div",{className:"pl-studio-buttons"},btn("添加样例",()=>setSuite({...suite,cases:[...suite.cases,newCase('train')]}),"",disabled||suite.cases.length>=12),btn("保存测试集",save,"accent",disabled||saving),suite.id?btn("删除测试集",remove,"danger",disabled):null),h("p",{className:"pl-studio-note"},"试跑使用已保存版本；编辑后请先保存。"))):null,
        h("details",{className:"pl-details"},h("summary",null,"测试模型、背景与预算"),h("div",{className:"pl-details-content"},h("div",{className:"pl-diff"},h(ModelRoute,{label:'测试模型',value:target,onChange:setTarget,providers:cap?.providers,disabled}),h(ModelRoute,{label:'评分模型',value:judge,onChange:setJudge,providers:cap?.providers,disabled})),
          h("label",{className:"pl-field"},"两版共同背景",h("textarea",{className:"pl-textarea",value:common,maxLength:8000,disabled,onChange:e=>setCommon(e.target.value)})),
          ...[['最多调用次数',maxCalls,setMaxCalls,1,40],['最多改写轮次',maxRounds,setMaxRounds,1,3],['输出 Token 预留总额',maxOutputTotal,setMaxOutputTotal,1000,24000]].map(([name,value,set,min,max])=>h("label",{className:"pl-field",key:name},name,h("input",{className:"pl-select",type:'number',value,min,max,disabled,onChange:e=>set(Number(e.target.value))}))),
          h("p",{className:"pl-studio-note"},"任务最长 10 分钟，输入总计 400,000 字节；每个回答最多 1024 Token，改写每次预留 4000 Token。评分和重试均计入总调用。优化只把训练样例发给改写模型，保留样例最后评估一次。生成样例使用左侧生成模型。"))),
        h('details',{className:'pl-details'},h('summary',null,'场景方案：配置、模型、测试集与预算'),h('div',{className:'pl-details-content'},
          h('p',{className:'pl-studio-note'},'保存已保存配置、引用规则、测试集和当前试跑参数。载入只更换编辑器与试跑参数，不启用配置，不自动调用模型。来源版本改变时需恢复匹配版本或另存场景。'),
          h('input',{className:'pl-select','aria-label':'场景方案名称',value:scenarioName,maxLength:80,disabled:disabled||scenarioBusy,onChange:e=>setScenarioName(e.target.value)}),
          h('div',{className:'pl-studio-buttons'},btn('保存当前场景',saveScenario,'',disabled||scenarioBusy||!scenarioName.trim()||!suite?.id||JSON.stringify(suite)!==savedSuite||!route?.model||!target?.model||!judge?.model),btn('读取场景列表',()=>listScenarios().catch(e=>setError(e.message)),'quiet',disabled||scenarioBusy)),
          h('select',{className:'pl-select','aria-label':'选择场景方案',value:scenarioPreview?.scenario.id||'',disabled:disabled||scenarioBusy,onChange:e=>inspectScenario(e.target.value)},h('option',{value:''},'选择已保存场景'),...scenarios.map(v=>h('option',{key:v.id,value:v.id},v.name+' · '+v.profileName+' / '+v.suiteName))),
          scenarioPreview?h('div',{className:'pl-candidate-rule'},h('h4',null,scenarioPreview.scenario.data.name),h('p',{className:'pl-studio-note'},scenarioPreview.canApply?'来源版本匹配，可载入':scenarioPreview.reason),h('details',{className:'pl-details'},h('summary',null,'核对场景内容与来源版本'),h('pre',{className:'pl-pre'},JSON.stringify(scenarioPreview.scenario.data,null,2))),scenarioPreview.loaded?h('p',{className:'pl-notice'},'已载入场景参数；尚未启用或发起试跑。'):null,h('div',{className:'pl-studio-buttons'},btn('载入场景参数（不启用）',loadScenario,'accent',disabled||scenarioBusy||!scenarioPreview.canApply),btn('删除场景方案',removeScenario,'quiet',disabled||scenarioBusy))):null)),
        suite&&JSON.stringify(suite)!==savedSuite?h('p',{className:'pl-notice'},'样例有未保存修改，请保存后试跑。'):null,
        h("div",{className:"pl-studio-buttons"},btn("两版试跑",()=>start('evaluate'),"",disabled||!seed||!suite?.id||JSON.stringify(suite)!==savedSuite||!target?.model||!judge?.model),btn("预算内优化",()=>start('optimize'),"accent",disabled||!seed||!suite?.id||JSON.stringify(suite)!==savedSuite||!train||!validation||!target?.model||!judge?.model)));
    }
    let retainedStudio = null;
    function StudioPanel({ initialOperation, sourceRuleIds=[], getContext, onCommitted, onOpenProfile, onReplace, onClose }) {
      const [operation,setOperation]=useState(initialOperation||retainedStudio?.operation||"generate");
      const [goal,setGoal]=useState(initialOperation==='curate'?'合并重复约束，修剪冗余，说明冲突并保留实质要求。':retainedStudio?.goal||"");
      const [materials,setMaterials]=useState(retainedStudio?.materials||"");
      const [includeDraft,setIncludeDraft]=useState(['revise','curate'].includes(initialOperation)||((!initialOperation||initialOperation===retainedStudio?.operation)&&retainedStudio?.includeDraft)||false);
      const [chosenSources,setChosenSources]=useState(sourceRuleIds.length?sourceRuleIds:(!initialOperation||initialOperation===retainedStudio?.operation)?retainedStudio?.chosenSources||[]:[]);
      const [cap,setCap]=useState(null),[route,setRoute]=useState(null),[job,setJob]=useState(null),[seed,setSeed]=useState(null),[seedIndices,setSeedIndices]=useState([]),[sessionSelection,setSessionSelection]=useState(null);
      const [error,setError]=useState(""),[busy,setBusy]=useState(false),[indices,setIndices]=useState([]);
      const [workspaceSelection,setWorkspaceSelection]=useState(null);
      const [feedback,setFeedback]=useState(""),[adopted,setAdopted]=useState(null),[showDiff,setShowDiff]=useState(false);
      const lifecycle=useRef({mounted:true,id:retainedStudio?.jobId||null,providerEpoch:0}),inputRef=useRef(null),dialogRef=useRef(null);
      const request=(method="GET",body,query="")=>api(method,body,0,"/prompt-lab/api/studio"+query);
      const context=getContext(), candidate=job?.candidate;
      const running=job&&["queued","running"].includes(job.status);
      const stale=candidate&&(candidate.base.profileId!==context.draft.id||candidate.base.profileVersion!==context.draft.version
        || (candidate.base.draftKey&&candidate.base.draftKey!==studioDraftKey(context.draft)));
      const statusLabels={queued:"等待模型",running:"运行中",succeeded:"任务已完成 · 请审阅结果",failed:"执行失败",cancelled:"已取消",timed_out:"已超时",interrupted:"已中断",budget_exhausted:"预算已耗尽 · 保留部分结果"};
      async function loadJob(id) {
        const result=await request("GET",undefined,"?kind=job&id="+encodeURIComponent(id));
        if(!lifecycle.current.mounted||lifecycle.current.id!==id)return;
        setCap(current=>current?{...current,history:(current.history||[]).map(item=>item.id===id?{...item,status:result.job.status,name:result.job.candidate?.content.name||item.name}:item)}:current);
        setJob(previous=>{
          if(previous?.id!==id||!previous.candidate&&result.job.candidate)setIndices(result.job.candidate?.content.ruleSuggestions.map((_,i)=>i)||[]);
          return result.job;
        });
        if(result.job.candidate?.content.prompt){setSeed(result.job);setSeedIndices(result.job.candidate.content.ruleSuggestions.map((_,i)=>i));}
        else if(result.job.input.seedCandidate?.id&&!seed){
          request("GET",undefined,"?kind=job&id="+encodeURIComponent(result.job.input.seedCandidate.id)).then(r=>{if(lifecycle.current.mounted){setSeed(r.job);setSeedIndices(r.job.candidate?.content.ruleSuggestions.map((_,i)=>i)||[]);}}).catch(()=>{});
        }
      }
      useEffect(()=>{
        const previousFocus=document.activeElement;
        inputRef.current?.focus();
        request().then(result=>{
          if(!lifecycle.current.mounted)return;
          setCap(result);setRoute(result.route||null);
          const active=result.history?.find(j=>["queued","running"].includes(j.status));
          const last=active?.id||(lifecycle.current.id&&result.history?.some(j=>j.id===lifecycle.current.id)?lifecycle.current.id:result.history?.[0]?.id);
          if(last){lifecycle.current.id=last;loadJob(last).catch(e=>{if(lifecycle.current.mounted)setError(e.message);});}
        }).catch(e=>{if(lifecycle.current.mounted)setError(e.message);});
        return ()=>{lifecycle.current.mounted=false;previousFocus?.focus?.();};
      },[]);
      useEffect(()=>{
        retainedStudio={operation,goal,materials,includeDraft,chosenSources,jobId:job?.id||lifecycle.current.id};
      },[operation,goal,materials,includeDraft,chosenSources,job?.id]);
      useEffect(()=>{
        if(!running)return;
        let inFlight=false;
        const tick=async()=>{if(inFlight)return;inFlight=true;try{await loadJob(job.id);}catch(e){if(lifecycle.current.mounted)setError(e.message);}finally{inFlight=false;}};
        const timer=window.setInterval(tick,800);tick();return()=>window.clearInterval(timer);
      },[job?.id,running]);
      async function chooseProvider(provider) {
        const epoch=++lifecycle.current.providerEpoch;
        setRoute({provider,model:""});setError("");
        try{const result=await request("GET",undefined,"?provider="+encodeURIComponent(provider));
          if(!lifecycle.current.mounted||epoch!==lifecycle.current.providerEpoch)return;
          setCap(result);setRoute({provider,model:result.models?.[0]?.id||(result.route?.provider===provider?result.route.model:"")});
        }catch(e){if(lifecycle.current.mounted)setError(e.message);}
      }
      async function start(refine=false) {
        if(busy||running)return;
        if(refine&&candidate?.base.profileId!==context.draft.id){setError("此候选属于另一配置，请切回原配置后继续优化；候选仍保留在历史中。");return;}
        setBusy(true);setError("");setAdopted(null);
        lifecycle.current.id=null;if(retainedStudio)retainedStudio.jobId=null;
        try {
          const result=await request("POST",{action:"start",requestId:"ui-"+Date.now()+"-"+Math.random().toString(36).slice(2),
            operation:refine?(candidate?.content.prompt?"revise":candidate.operation):operation,goal:refine?feedback:goal,materials,sourceLabel:"用户选定的需求、规范或反馈",sourceRuleIds:chosenSources,
            profileId:context.draft.id,profileVersion:context.draft.version,includeDraft:operation==="revise"||includeDraft,draft:context.draft,
            workspaceSelection:refine?null:workspaceSelection,route,previousCandidate:refine?candidate.content:null,sessionSelection:operation==='learn'&&!refine?sessionSelection:null,sourceJobId:refine?job.id:null});
          if(!lifecycle.current.mounted)return;
          lifecycle.current.id=result.job.id;setJob(result.job);setIndices([]);setShowDiff(false);
          setCap(current=>({...current,history:[{id:result.job.id,name:refine?feedback:goal,status:result.job.status,operation:result.job.input.operation},...(current?.history||[])].slice(0,20)}));
        }catch(e){if(lifecycle.current.mounted)setError(e.message);}
        finally{if(lifecycle.current.mounted)setBusy(false);}
      }
      async function startExperiment(options){
        if(busy||running)return;setBusy(true);setError("");setAdopted(null);
        try{const current=getContext(),result=await request("POST",{action:'start',requestId:'ui-experiment-'+Date.now()+'-'+Math.random().toString(36).slice(2),...options,
          profileId:current.draft.id,profileVersion:current.draft.version,draft:current.draft,route});
          if(!lifecycle.current.mounted)return;lifecycle.current.id=result.job.id;setJob(result.job);setIndices([]);
          setCap(c=>({...c,history:[{id:result.job.id,name:options.operation,status:result.job.status,operation:options.operation},...(c?.history||[])].slice(0,20)}));
        }catch(e){if(lifecycle.current.mounted)setError(e.message);}finally{if(lifecycle.current.mounted)setBusy(false);}
      }
      async function cancel() {
        setBusy(true);try{const r=await request("POST",{action:"cancel",id:job.id});if(lifecycle.current.mounted)setJob(r.job);}
        catch(e){if(lifecycle.current.mounted)setError(e.message);}finally{if(lifecycle.current.mounted)setBusy(false);}
      }
      async function adopt(mode) {
        setBusy(true);setError("");
        try{
          const result=await request("POST",{action:"adopt",id:job.id,mode,indices,expectedStoreVersion:getContext().data.storage.storeVersion});
          if(!lifecycle.current.mounted)return;
          onCommitted(result);setAdopted(result);await loadJob(job.id);
        }catch(e){if(lifecycle.current.mounted)setError(e.message);}
        finally{if(lifecycle.current.mounted)setBusy(false);}
      }
      async function clearHistory() {
        if(!window.confirm("清除本地 AI 创作历史和所选材料记录？已保存配置与规则保持不变。"))return;
        setBusy(true);try{await request("POST",{action:"clear"});if(lifecycle.current.mounted){lifecycle.current.id=null;setJob(null);setSeed(null);setAdopted(null);setCap(c=>({...c,history:[]}));}}
        catch(e){if(lifecycle.current.mounted)setError(e.message);}finally{if(lifecycle.current.mounted)setBusy(false);}
      }
      const list=(title,items)=>items?.length?h(React.Fragment,null,h("h4",null,title),h("ul",null,...items.map((item,i)=>h("li",{key:i},item)))):null;
      const original=candidate?.base.draft;
      const diff=candidate?lineDiff([original?.prompt,original?.rules].filter(Boolean).join("\n\n"),[candidate.content.prompt,candidate.content.rules].filter(Boolean).join("\n\n")):null;
      const applied=adopted||job?.application?.status==="committed";
      return h("div",{className:"pl-studio-overlay"},h("section",{className:"pl-studio",role:"dialog","aria-modal":true,"aria-label":"AI 提示词工作台",ref:dialogRef,
        onKeyDown:e=>{
          if(e.key==="Escape"){e.stopPropagation();onClose();}
          if(e.key==="Tab"){
            const nodes=dialogControls(dialogRef.current);
            if(!nodes.length)return;const first=nodes[0],last=nodes[nodes.length-1];
            if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
            else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
          }
        }},
        h("header",{className:"pl-studio-head"},h("div",null,h("h2",null,"AI 提示词工作台"),h("p",null,"描述目标，让 AI 起草；候选独立保存，采用后再决定是否启用。")),iconButton("关闭 AI 创作","close",onClose)),
        h("div",{className:"pl-studio-body"},error?h("p",{className:"pl-error",role:"alert"},error):null,
          cap?.storageError?h("p",{className:"pl-error"},cap.storageError):null,
          h("div",{className:"pl-studio-grid"},h("section",{className:"pl-surface pl-studio-form","aria-label":"创作需求"},
            h("p",{className:"pl-studio-note"},"目标配置："+(context.data.profiles.find(p=>p.id===context.draft.id)?.name||context.draft.id)),
            h("label",{className:"pl-field",htmlFor:"pl-ai-operation"},"这次想做什么"),
            h("select",{id:"pl-ai-operation",className:"pl-select",value:operation,disabled:busy||running,onChange:e=>{setOperation(e.target.value);if(e.target.value==="revise")setIncludeDraft(true);}},
              h("option",{value:"generate"},"描述需求生成"),h("option",{value:"revise"},"按反馈优化当前稿"),h("option",{value:"extract"},"从材料提取规则"),h("option",{value:"learn"},"从会话或反馈学习"),h("option",{value:"curate"},"合并与修剪已有规则")),
            h("label",{className:"pl-field",htmlFor:"pl-ai-goal"},operation==="revise"?"想改善什么":"目标或提取要求"),
            h("textarea",{id:"pl-ai-goal",ref:inputRef,className:"pl-textarea","aria-label":"AI 创作需求",maxLength:6000,value:goal,onChange:e=>setGoal(e.target.value),placeholder:"例如：维护 Java 项目，中文，先定位代码，改完验证，少写长计划。"}),
            h("label",{className:"pl-inline pl-studio-note"},h("input",{type:"checkbox",checked:includeDraft||operation==="revise",disabled:operation==="revise"||running,onChange:e=>setIncludeDraft(e.target.checked)}),"带入当前草稿与引用规则"),
            h(WorkspacePicker,{onChange:setWorkspaceSelection,disabled:busy||running}),
            operation==='learn'?h(SessionPicker,{onChange:setSessionSelection,disabled:busy||running,available:cap?.sessionAvailable}):null,
            h("details",{className:"pl-details",open:['extract','curate','learn'].includes(operation)?true:undefined},h("summary",null,"选定材料与来源"),h("div",{className:"pl-details-content"},
              h("textarea",{className:"pl-textarea","aria-label":"AI 所选材料",maxLength:60000,value:materials,onChange:e=>setMaterials(e.target.value),placeholder:"粘贴项目规范、现有提示词或希望避免的失败反馈。"}),
              h("p",{className:"pl-studio-note"},"粘贴材料 "+materials.length.toLocaleString()+" 字；只发送本次选择，不扫描磁盘或聊天。"),
              context.data.ruleSets?.length?h("div",null,h("p",{className:"pl-studio-note"},"可选带入已有规则（已保存版本）"),btn(chosenSources.length===context.data.ruleSets.length?"不带入已有规则":"带入全部已有规则",()=>setChosenSources(chosenSources.length===context.data.ruleSets.length?[]:context.data.ruleSets.map(r=>r.id)),"quiet",running),...context.data.ruleSets.map(r=>h("label",{className:"pl-inline pl-studio-note",key:r.id},
                h("input",{type:"checkbox",checked:chosenSources.includes(r.id),disabled:running,onChange:e=>setChosenSources(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}),r.name))):null)),
            h("label",{className:"pl-field",htmlFor:"pl-ai-provider"},"生成模型"),
            h("select",{id:"pl-ai-provider",className:"pl-select",value:route?.provider||"",disabled:running||!cap?.available,onChange:e=>chooseProvider(e.target.value)},
              !route?h("option",{value:""},"加载宿主模型…"):null,...(cap?.providers||[]).map(p=>h("option",{key:p.id,value:p.id},p.name))),
            h("select",{className:"pl-select","aria-label":"生成模型",style:{marginTop:7},value:route?.model||"",disabled:running||!cap?.available,onChange:e=>setRoute(r=>({...r,model:e.target.value}))},
              !(cap?.models||[]).some(m=>m.id===route?.model)?h("option",{value:route?.model||""},route?.model||"请选择模型"):null,
              ...(cap?.models||[]).map(m=>h("option",{key:m.id,value:m.id},m.name))),
            cap?.catalogError?h("p",{className:"pl-studio-note"},cap.catalogError):null,
            h("p",{className:"pl-studio-note"},"复用宿主凭据。每次最多两次调用（含一次格式修复），90 秒 / 输出 4000 Token 上限。创作材料不自动经过设置页的环境脱敏。"),
            cap&&!cap.available?h("p",{className:"pl-notice"},cap.reason):null,
            h("div",{className:"pl-studio-buttons"},btn(running?"正在运行…":"生成候选",()=>start(),"accent",busy||running||!cap?.available||!route?.model||(!goal.trim()&&!materials.trim()&&!sessionSelection&&!workspaceSelection)),running?btn("取消生成",cancel,"",busy):null),
            h("details",{className:"pl-studio-history"},h("summary",null,"本地创作历史 · 最近 20 份"),
              ...(cap?.history||[]).map(item=>h("button",{type:"button",className:"pl-history-item",key:item.id,disabled:busy,onClick:()=>{lifecycle.current.id=item.id;setAdopted(null);setError("");loadJob(item.id).catch(e=>setError(e.message));}},item.name||"创作任务",h("small",null,statusLabels[item.status]||item.status))),
              h("p",{className:"pl-studio-note"},"候选、所选材料和必要来源只保存在本地，可随时清除。关闭抽屉后任务继续，可从历史恢复。"),btn("清除创作历史",clearHistory,"quiet",busy||running))),
          h("section",{className:"pl-surface pl-candidate","aria-label":"AI 候选结果"},
            !job?h("div",{className:"pl-empty"},h("h3",null,"从一句需求开始"),h("p",null,"AI 会整理正文、专属要求和可复用规则；未知内容会标为待补充。")):null,
            job?h("div",{className:"pl-studio-status",role:"status"},statusLabels[job.status],
              h("div",null,job.route.provider+" / "+job.route.model),
              h("div",null,"调用尝试 "+job.usage.calls+" 次 · 输入 "+(job.usage.inputTokens??"未知")+" / 输出 "+(job.usage.outputTokens??"未知")+" Token · 金额未知"),
              running?h("p",null,"已接收 "+job.progressChars+" 字；取消会阻止后续派发，已发出调用仍可能计费。"):null):null,
            job?.error?h("p",{className:"pl-error",style:{marginTop:12}},job.error):null,
            ['examples','regression'].includes(job?.result?.kind)?h("p",{className:"pl-notice"},job.result.warning+(job.result.suite.id?'。已保存：':'。待审核草稿：')+job.result.suite.name+"，可在下方审核。"):null,
            candidate?h(React.Fragment,null,
              h("h3",{style:{marginTop:18}},candidate.content.name),h("p",{className:"pl-studio-note"},"来源："+candidate.sources.label+" · 配置版本 "+candidate.base.profileVersion+" · AI 建议，尚未验证效果"),
              h("details",{className:"pl-details pl-studio-inputs"},h("summary",null,"本次实际使用的输入与来源"),h("div",{className:"pl-details-content"},
                h("h4",null,"需求 / 反馈"),h("pre",{className:"pl-pre"},job.input.goal||"（空）"),
                job.input.materials?h(React.Fragment,null,h("h4",null,job.input.sourceLabel),h("pre",{className:"pl-pre"},job.input.materials)):null,
                candidate.sources.selectedSession?h(React.Fragment,null,h("h4",null,"明确选定的会话消息"),h("pre",{className:"pl-pre"},JSON.stringify(candidate.sources.selectedSession,null,2))):null,
                original?h(React.Fragment,null,h("h4",null,"带入的原稿 · 版本 "+original.version),h("pre",{className:"pl-pre"},[original.prompt,original.rules].filter(Boolean).join("\n\n"))):h("p",{className:"pl-studio-note"},"本次未带入当前草稿。"),
                job.input.previousCandidate?h("p",{className:"pl-studio-note"},"带入前一候选："+job.input.previousCandidate.name):null,
                ...(job.input.sourceRules||[]).map(r=>h("details",{className:"pl-details",key:r.id},h("summary",null,r.name+" · 版本 "+r.version),h("pre",{className:"pl-pre"},r.text))))),
              stale?h("p",{className:"pl-notice"},"当前配置或草稿已变化。候选仍基于旧输入；原稿不会被覆盖，请比较后另存或重新生成。"):null,
              candidate.content.prompt?h(React.Fragment,null,h("h4",null,"补充正文"),h("pre",{className:"pl-pre"},candidate.content.prompt)):null,
              candidate.content.rules?h(React.Fragment,null,h("h4",null,"本方案附加规则"),h("pre",{className:"pl-pre"},candidate.content.rules)):null,
              candidate.content.retainedRuleIds.length?h("p",{className:"pl-studio-note"},"新方案沿用 "+candidate.content.retainedRuleIds.length+" 条原引用；复制优化规则会只替换新方案中的对应引用。"):null,
              btn(showDiff?"收起原稿对比":"查看原稿与候选差异",()=>setShowDiff(!showDiff),"quiet"),
              showDiff?h("div",null,!original?h("p",{className:"pl-studio-note"},"本次未带入原稿；左侧为空。"):null,diff.approximate?h("p",{className:"pl-studio-note"},"文本较长，展示完整原稿与候选，不标记逐行差异。"):null,
                h("div",{className:"pl-diff"},...[['原稿',diff.left],['候选',diff.right]].map(([label,items])=>h("div",{key:label},h("p",{className:"pl-diff-label"},label),h("pre",null,...items.map((item,i)=>h("span",{key:i,className:item.kind||""},item.text||" "))))))):null,
              list("实质修改",candidate.content.changes),list("待核实假设",candidate.content.assumptions),list("待补充项",candidate.content.questions),
              candidate.content.ruleSuggestions.length?h("h4",null,"规则建议 · 勾选后采用"):null,
              ...candidate.content.ruleSuggestions.map((r,i)=>h("div",{className:"pl-candidate-rule",key:i},
                h("label",null,h("input",{type:"checkbox","aria-label":"采用规则 "+r.name,checked:indices.includes(i),disabled:busy||!!applied||candidate.operation==='optimize',onChange:e=>{const next=e.target.checked?[...indices,i]:indices.filter(v=>v!==i);setIndices(next);if(seed?.id===job.id)setSeedIndices(next);}}),r.name),
                h("p",null,({create:"新建",reuse:"引用已有",copy:"复制后修改"}[r.action])+" · "+r.scope+(r.existingEnabled===false?" · 原规则已停用":"")),h("pre",{className:"pl-pre"},r.text),
                r.reason?h("p",null,"建议理由："+r.reason):null,r.source?h("p",null,"模型提取依据（未验证）："+r.source):null,r.conflict?h("p",null,"重复/冲突："+r.conflict):null,r.replacesRuleIds?.length?h("p",null,"仅在新方案中替换引用："+r.replacesRuleIds.map(id=>job.input.sourceRules.find(r=>r.id===id)?.name||id).join('、')):null)),
              applied?h("p",{className:"pl-notice",style:{marginTop:15}},"已保存。配置未自动启用，原配置及共享规则保持原样。",adopted?.studioWarning||""):null,
              h("div",{className:"pl-studio-buttons"},
                candidate.content.prompt?btn("另存为新方案",()=>adopt("profile"),"accent",busy||!!applied):btn("保存所选规则",()=>adopt("rules"),"accent",busy||!!applied||!indices.length),
                candidate.content.prompt?btn("仅替换正文与附加规则",()=>{if(onReplace(candidate))onClose();},"",busy||!!stale||!!applied):null,
                adopted?.editedId?btn("打开新方案",()=>{if(onOpenProfile(adopted,adopted.editedId))onClose();},"",busy):null),
              h("p",{className:"pl-studio-note"},"保存新方案会一次提交勾选规则；替换草稿不会写入新共享规则。启用配置影响未单独绑定的会话；已绑定会话继续使用固定版本。"),
              h("label",{className:"pl-field",htmlFor:"pl-ai-feedback"},"继续说说哪里需要改"),h("textarea",{id:"pl-ai-feedback",className:"pl-textarea","aria-label":"候选修改反馈",maxLength:6000,value:feedback,onChange:e=>setFeedback(e.target.value),placeholder:"例如：更短一些，保留验证要求。"}),
              h("div",{className:"pl-studio-buttons"},btn("按反馈再改一版",()=>start(true),"",busy||running||!feedback.trim()))):null)),
          h(ExperimentResults,{job}),h(ExperimentPanel,{seed,indices:seed?.id===job?.id?indices:seedIndices,activeJob:job,route,cap,disabled:busy||running,onStart:startExperiment,getContext,onOpenProfile,onRouteLoaded:setRoute}))));
    }
    let retainedDraft = null;
    function Panel() {
      // —— 界面状态：只影响本组件的渲染 ——
      // 日常管理页签；组装观察仅作为设置页内的折叠诊断。
      const [tab, setTab] = useState("profile");

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
      const [studioOptions,setStudioOptions] = useState(null);
      const [versionsOpen,setVersionsOpen]=useState(false);
      const [bindingsOpen,setBindingsOpen]=useState(false);
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
      function openStudio(operation, sourceRuleIds=[]) { setManageOpen(false); setStudioOptions({operation,sourceRuleIds}); }
      function studioContext() {
        const current=editor.current;
        return {data,draft:{id:current.id,version:current.version,prompt:current.prompt,rules:current.rules,
          ruleIds:[...current.ruleIds],promptEnabled:current.promptEnabled,rulesEnabled:current.rulesEnabled}};
      }
      function replaceFromCandidate(candidate) {
        if(candidate.base.profileId!==editor.current.id||candidate.base.profileVersion!==editor.current.version
          ||candidate.base.draftKey&&candidate.base.draftKey!==studioDraftKey(studioContext().draft)) {
          setError("候选依据与当前草稿不同，已保留原稿。请重新生成或另存新方案。");return false;
        }
        if(isDirty()&&!window.confirm("用候选替换当前正文与附加规则草稿？新共享规则不会写入，之后仍需保存配置。"))return false;
        edit("prompt",candidate.content.prompt);edit("rules",candidate.content.rules);return true;
      }
      function openStudioProfile(result,id) {
        const profile=result.profiles.find(p=>p.id===id);if(!profile)return false;
        if(isDirty()&&!window.confirm("放弃当前未保存草稿，载入所选方案？"))return false;
        loadEditor(profile);return true;
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
      // 当前设置与最近观察结果分开展示，避免把配置值当作已生效证据。
      const filterMode = data?.settings?.contextFilter || "off";
      // 渠道指纹脱敏开关（与上下文过滤独立、可叠加）。
      const identityOn = data?.settings?.identityBreak === true;
      const environmentEffect = {
        off: "保留宿主附加的环境原文，包括其中的路径、地址及策略说明。",
        redact: "按内置规则替换环境信息中的路径、URL 和时间戳，保留句子结构与策略说明；不是全量隐私清理。",
        strip: "移除宿主附加的整组环境信息，其中的工作目录及沙箱、审批等策略说明也不会提供给模型。宿主实际权限不变。",
      }[filterMode];
      // 编辑器预览文本：与宿主端 lib/state.js 的 profileText() 拼装规则保持一致
      // （正文 + 可选的「## 当前规则集」段），因此预览看到的就是下一次注入会用的文本。
      const sharedRules = (editor.current.ruleIds || []).map(id => data?.ruleSets?.find(r => r.id === id))
        .filter(r => r?.enabled).map(r => `## ${r.name}\n${r.text.trim()}`);
      const profileText = [editor.current.promptEnabled && draft.trim(),
        editor.current.rulesEnabled && [ruleDraft.trim() && `## 当前规则集\n${ruleDraft.trim()}`, ...sharedRules].filter(Boolean).join("\n\n")].filter(Boolean).join("\n\n");

      const editProfile = data?.profiles?.find(p => p.id === editId);
      const tabs = [["profile", "提示词与规则", "document"], ["rules", "规则库", "layers"], ["transfer", "导入导出", "transfer"], ["settings", "设置", "settings"]];
      const content = h(React.Fragment, null,
        h("header", { className: "pl-head" },
          h("div", { className: "pl-brand" }, h("div", { className: "pl-brand-mark", "aria-hidden": true }, "P/L"),
            h("div", null, h("div", { className: "pl-title" }, "Prompt Lab"), h("div", { className: "pl-sub" }, "提示词工作台"))),
          h("div", { className: "pl-header-actions" },
            h("span", { className: "pl-connection" }, h("i", { className: "pl-dot" + (!data || error ? " pending" : "") }), data ? (error ? "连接异常" : "本地已连接") : "连接中"),
            iconButton("↻", "refresh", () => refresh(true), saving))),
        h("nav", { className: "pl-tabs", "aria-label": "提示词工作台导航" },
          ...tabs.map(([key, title, glyph]) => h("button", { key, type: "button", className: "pl-tab" + (tab === key ? " current" : ""), "aria-pressed": tab === key,
            onClick: () => { setTab(key); setManageOpen(false); } }, icon(glyph), h("span", null, title)))),
        h("div", { className: "pl-body" }, h("div", { className: "pl-page" },
          error ? h("div", { className: "pl-error", role: "alert" }, "请求失败：" + error) : null,
          !data ? h("div", { className: "pl-empty", role: "status" }, "正在加载本地配置…") : null,
          data?.storage?.error ? h("p", { className: "pl-error", role: "alert" }, data.storage.error) : null,
          data?.historyWarning?h("p",{className:"pl-notice",role:"status"},data.historyWarning):null,
          data && !st.observerRegistered ? h("p", { className: "pl-notice" }, "组装观察尚未就绪，请确认插件已启用。配置仍可编辑。") : null,
          tab === "profile" && data ? h(React.Fragment, null,
            h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "提示词配置"), h("p", null, "为不同任务保存配置，自由组合正文与规则。")),
              h("div",{className:"pl-ai-entry"},h("span", { className: "pl-kicker" }, (data.profiles || []).length + " 套配置"),btn("会话适用范围",()=>setBindingsOpen(true),"",saving),btn("AI 创作",()=>openStudio("generate"),"accent",saving))),
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
                  h("div", { className: "pl-editor-head" }, h("div", null, h("h2", null, editProfile?.name || "配置编辑器"), h("p", null, "编辑后保存；全局启用项用于未单独绑定的会话。")),
                    h("div", { className: "pl-editor-head-actions" }, btn("按反馈优化",()=>openStudio("revise"),"quiet",saving),h("span", { className: "pl-badge" + (selected === editId ? " active" : "") }, selected === editId ? "当前启用" : "未启用"),
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
                            btn("版本记录与恢复",()=>{setManageOpen(false);setVersionsOpen(true);},"",saving),
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
          tab === "rules" && data ? h(RuleManager, { data, onCommitted: acceptData, onAI:(ids,operation='extract')=>openStudio(operation,ids) }) : null,
          tab === "transfer" && data ? h(TransferPanel, { data, onCommitted: acceptData }) : null,
          tab === "settings" && data ? h(React.Fragment, null,
            h("div", { className: "pl-page-heading" }, h("div", null, h("h1", null, "设置"), h("p", null, "控制环境信息的提供方式，并按需启用渠道兼容。"))),
            h("section", { className: "pl-setting-group" },
              h("div", { className: "pl-processing-head" }, h("h2", null, "提示词处理"), h("p", null, "环境信息控制提供给模型的内容；渠道兼容只处理特定身份句，两项可以独立使用。")),
              h("div", { className: "pl-setting-row" }, h("div", { className: "pl-setting-copy" }, h("h2", null, "环境信息"), h("p", null, "宿主自动附加的工作目录、路径、界面地址及策略说明；不包括你编写的提示词和聊天消息。")),
                h("select", { className: "pl-select", "aria-label": "环境信息处理方式", "aria-describedby": "pl-environment-effect", value: filterMode, disabled: saving, onChange: e => mutate("settings.update", { contextFilter: e.target.value }) }, h("option", { value: "off" }, "原样保留"), h("option", { value: "redact" }, "隐藏具体值"), h("option", { value: "strip" }, "整组移除"))),
              h("p", { className: "pl-current-setting", id: "pl-environment-effect", role: "status" }, environmentEffect),
              h("details", { className: "pl-inline-help", "aria-label": "环境信息处理详情" }, h("summary", null, "三种方式怎么选？查看处理示例与范围"),
                h("div", { className: "pl-help-grid" },
                  h("div", { className: "pl-help-item" }, h("h3", null, "原样保留 · 默认"), h("p", null, "提供完整环境信息，让模型了解真实工作目录和宿主说明。不做替换或移除。"), h("pre", { className: "pl-example" }, "工作目录：D:\\work\\demo\n→ 保留原文")),
                  h("div", { className: "pl-help-item" }, h("h3", null, "隐藏具体值"), h("p", null, "按匹配规则将路径、URL、ISO 时间戳替换为占位符，保留结构和功能句。无法保证识别所有路径或敏感信息。"), h("pre", { className: "pl-example" }, "D:\\work\\demo → <路径>\nhttps://example.com → <URL>\nISO 时间戳 → <时间>")),
                  h("div", { className: "pl-help-item" }, h("h3", null, "整组移除"), h("p", null, "不提供这整组环境信息。工作目录和其中的沙箱、审批说明一起移除，可能影响模型判断；宿主实际权限与审批机制不变。"), h("pre", { className: "pl-example" }, "整组环境信息\n→ 移除"))),
                h("p", { className: "pl-setting-note", style: { marginTop: 12 } }, "只处理宿主附加的环境信息。正文、规则、聊天消息和工具结果不由此选项清理；官方单独注入的时间消息也不在此范围。")),
              h("details", { className: "pl-details pl-advanced", "aria-label": "高级兼容性" },
                h("summary", null, "高级兼容性", h("span", { className: "pl-badge" + (identityOn ? " active" : "") }, "渠道身份句兼容 · " + (identityOn ? "已开启" : "已关闭"))),
                h("div", { className: "pl-setting-row" }, h("div", { className: "pl-setting-copy" }, h("h2", null, "渠道身份句兼容"), h("p", null, "针对特定渠道按身份句进行文本匹配的兼容选项。默认关闭；正常调用无需开启。")), toggle("渠道身份句兼容", identityOn, value => mutate("settings.update", { identityBreak: value }), saving)),
                h("div", { className: "pl-help-copy" },
                  h("h3", null, "什么时候用"), h("p", null, "用于排查已知的 WorkBuddy 400 / 11128 身份句匹配问题。该报错也可能有其他原因，开启不保证解决所有渠道拒绝。"),
                  h("h3", null, "具体处理什么"), h("p", null, "仅对内置清单命中的 DSH / coding agent 身份介绍和来源说明，在词间插入不可见的零宽空格（U+200B），改变连续文本的匹配形式，不删除整句。处理范围为组装中的提示词段及环境信息。"),
                  h("h3", null, "与隐藏具体值有什么区别"), h("p", null, "环境信息选项替换或移除内容；此开关只改变已知身份句的文本形式，不负责隐藏路径、地址、API Key 或聊天内容，也不会改变模型能力和宿主权限。"),
                  h("h3", null, "生效与限制"), h("p", null, "只影响后续新组装，不修改历史消息；内置匹配清单之外的句子不会处理。零命中不表示开关关闭；零宽字符仍属于实际发送的文本。")))),
            h("p", { className: "pl-setting-note" }, "当前 DSH 共用设置 · 自动保存 · 后续新请求生效"),
            h("details", { className: "pl-details", style: { marginTop: 24 } }, h("summary", null, "生效范围与保存方式"), h("div", { className: "pl-details-content pl-help-copy" },
              h("h3", null, "设置由当前 DSH 共用"), h("p", null, "不随提示词配置切换，重新打开后仍保留。修改会自动保存；失败时页面会提示，不会把未保存的值当作成功。"),
              h("h3", null, "只影响之后的新组装"), h("p", null, "不会回写已有消息和历史轨迹，也不修改你保存的提示词原文。两项同时开启时，先处理环境信息，再处理仍存在的已知身份句。"),
              h("h3", null, "如何核对结果"), h("p", null, "发送一次新请求后，在下方诊断查看最近观察。设置值和服务已注册不等于模型已收到；进程观察可能来自其他会话，后续仍可能经过宿主处理。"))),
            h("details", { className: "pl-details pl-diagnostics", "aria-label": "Prompt Lab 诊断" },
              h("summary", null, "诊断", h("span", { className: "pl-kicker" }, "注入与过滤")),
              h("div", { className: "pl-details-content" },
                h(InjectionDiagnostics,{data}),
                h("p", { className: "pl-setting-note" }, "仅核对 Prompt Lab 的正文、规则和过滤。完整会话上下文、Token 与请求历史可在 Context 面板查看。"),
                h("div", { className: "pl-diagnostic-row" }, h("span", null, "当前启用配置"), h("span", null, activeProfile?.name || "未选择")),
                h("div", { className: "pl-diagnostic-row" }, h("span", null, "注入 / 观察服务"), h("span", null,
                  (st.registered ? "注入已注册" : "注入未就绪或已停用") + " · " + (st.observerRegistered ? "观察已注册" : "观察未就绪"))),
                !assembly ? h("p", { className: "pl-notice" }, "尚未观察到组装。发送一次新请求后，再检查正文、规则与过滤结果。") : h(React.Fragment, null,
                  h("div", { className: "pl-diagnostic-row" }, h("span", null, "最近观察"), h("span", null, timeText(assembly.capturedAt) + " · 配置版本 " + assembly.configRevision)),
                  h("p", { className: "pl-setting-note" }, assembly.sessionId?"本次组装关联会话："+assembly.sessionId+"；不等于当前选中会话或模型 API 最终请求正文。":"观察范围为整个进程，可能来自其他会话；不等于模型 API 最终请求正文。"),
                  assembly.stale ? h("p", { className: "pl-notice" }, "配置或设置已变化；以下是旧观察结果，待新请求验证。") : null,
                  assembly.processingFailed ? h("p", { className: "pl-error" }, "本次处理失败，以下为未处理的观察内容，不能确认过滤已生效。") : null,
                  ...[["prompt-lab:custom", "正文段"], ["prompt-lab:rules", "规则段"]].map(([name, label]) => {
                    const section = assembly.sections?.find(s => s.name === name);
                    return section ? h("details", { className: "pl-details", key: name, "data-diagnostic-section": name },
                      h("summary", null, `${label} · ${section.retainedChars}/${section.chars} 字${section.truncated ? "（已截断）" : ""}`),
                      h("div", { className: "pl-details-content" }, h("p", { className: "pl-kicker" }, name), h("pre", { className: "pl-pre" }, section.text || "（空）"))) :
                      h("div", { className: "pl-diagnostic-row", key: name }, h("span", null, label), h("span", null, "本次未观察到该段，可能已关闭、为空或未注册"));
                  }),
                  !assembly.processingFailed ? h(React.Fragment, null,
                    h("div", { className: "pl-diagnostic-row" }, h("span", null, "本次上下文过滤"), h("span", null,
                      ({ off: "原样保留", strip: "整组移除", redact: "隐藏具体值" }[assembly.contextFilter] || "未知") + ` · 去除 ${assembly.contextsRemoved || 0} 条 · 剩余 ${assembly.contextCount || 0} 条`)),
                    h("div", { className: "pl-diagnostic-row" }, h("span", null, "本次身份句处理"), h("span", null, `命中 ${assembly.identityBroken || 0} 个段/条目（零命中不代表开关关闭）`))) : null)))) : null)),
        h("footer", { className: "pl-foot" }, h("span", null, "本地配置 · " + (activeProfile?.name || "正在连接")), h("span", null, "v" + (data?.version || "0.6.3") + (data ? " · 更新于 " + timeText(data.generatedAt) : ""))),
        studioOptions&&data?h(StudioPanel,{initialOperation:studioOptions.operation,sourceRuleIds:studioOptions.sourceRuleIds,getContext:studioContext,onCommitted:acceptData,
          onOpenProfile:openStudioProfile,onReplace:replaceFromCandidate,onClose:()=>setStudioOptions(null)}):null,
        bindingsOpen&&data?h(SessionBindings,{data,profileId:editId,onCommitted:acceptData,onClose:()=>setBindingsOpen(false)}):null,
        versionsOpen&&data?h(VersionPanel,{data,profileId:editId,onCommitted:acceptData,onOpenProfile:openStudioProfile,onClose:()=>setVersionsOpen(false)}):null);

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
