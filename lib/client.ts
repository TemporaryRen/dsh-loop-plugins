/// <reference path="./client-types.d.ts" />
/**
 * dsh-loop-manager — client (browser) half.
 *
 * Hand-written bundle in the shape the DSH client module loader expects:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * TypeScript emits a browser script without modules or JSX. React is used only as the host's slot
 * mount point; the page itself is the design prototype's vanilla-DOM
 * workbench (EMBER list / DAG editor / run log), mounted into one `.lm-root`
 * element and driven by the plugin's JSON API. v9 adds the `Loop` tab: pipeline
 * + gate pairs looped until the gate returns TRUE (CONTRACT.md §13.7).
 *
 * Design source: /Users/temporary/source/workflow-skill/loop-pipeline-ui
 * (design-spec.md, tokens.json, ui/style.css, ui/app.js). The stylesheet below
 * is the prototype's CSS, scoped under `.lm-root`, plus the shell adaptations
 * listed in CONTRACT.md §9.5.
 *
 * Registration contract:
 *   - `sidebar.panellist` row id `loop-manager` -> left sidebar button;
 *   - `main` panel key `loop-manager`          -> the page itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-loop-manager',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef } = React

    /** Shared id: the sidebar row's `id` and the main panel's `key`. */
    const PANEL_ID = 'loop-manager'
    /** Same-origin JSON API prefix registered by the host half. */
    const API_BASE = '/loop-manager/api'
    /** Panel label (also the sidebar row's aria-label, set by the host). */
    const PANEL_LABEL = 'Loop Manager'
    /** Idle / running poll intervals, in milliseconds. */
    const POLL_IDLE_MS = 1500
    const POLL_RUNNING_MS = 700
    /** Toast lifetime. */
    const TOAST_MS = 2600

    /** The design prototype's stylesheet, scoped under `.lm-root`. */
    const LM_CSS =
      ".lm-root {\n  --green:#B95C3A;\n  --ink:#2E261C;\n  --muted:#857F73;\n  --line:#E7DED0;\n  --bg:#F8F5EE}\n.lm-root * {\n  box-sizing:border-box}\n.lm-root {\n  margin:0;\n  color:var(--ink);\n  font:14px 'DM Sans','Noto Sans SC',sans-serif;\n  background:var(--bg)}\n.lm-root button,.lm-root input,.lm-root textarea,.lm-root select {\n  font:inherit}\n.lm-root button {\n  cursor:pointer}\n.lm-root button,.lm-root a {\n  -webkit-tap-highlight-color:transparent}\n.lm-root button {\n  border:1px solid var(--line);\n  background:white;\n  border-radius:7px;\n  padding:9px 14px;\n  color:var(--ink);\n  transition:.18s}\n.lm-root button:hover {\n  background:#F3E9DD;\n  border-color:#DDC9B4}\n.lm-root button:disabled {\n  opacity:.45;\n  cursor:not-allowed}\n.lm-root button.primary {\n  background:var(--green);\n  border-color:var(--green);\n  color:white}\n.lm-root .primary:hover {\n  background:#9E4A2C}\n.lm-root small {\n  display:block;\n  color:var(--muted);\n  font-size:10px;\n  margin-top:4px}\n.lm-root .nav {\n  display:flex;\n  align-items:center;\n  gap:12px;\n  border:0;\n  background:none;\n  width:100%;\n  text-align:left;\n  padding:12px 14px;\n  margin:3px 0;\n  color:#7D7064}\n.lm-root .nav.active {\n  color:#8A4A2C;\n  background:#EBD8C9;\n  font-weight:600}\n.lm-root .nav i {\n  margin-left:auto;\n  font-size:10px;\n  font-style:normal;\n  background:#E7D3C0;\n  padding:1px 6px;\n  border-radius:4px}\n.lm-root main {\n  margin-left:236px}\n.lm-root header {\n  height:74px;\n  display:flex;\n  justify-content:space-between;\n  align-items:center;\n  padding:0 42px;\n  border-bottom:1px solid var(--line);\n  background:#FAF7F0;\n  font-size:11px;\n  color:#958B7D}\n.lm-root header b {\n  font-weight:500;\n  color:#5A4A3C}\n.lm-root .slash {\n  margin:0 15px;\n  color:#C9BFB0}\n.lm-root .header-right {\n  display:flex;\n  align-items:center;\n  gap:8px}\n.lm-root .lm-app {\n  padding:40px 42px;\n  max-width:1600px;\n  margin:auto}\n.lm-root .heading {\n  display:flex;\n  justify-content:space-between;\n  align-items:center;\n  margin-bottom:30px}\n.lm-root .eyebrow {\n  font-size:10px;\n  letter-spacing:2px;\n  color:#A0764F;\n  font-weight:600;\n  margin-bottom:12px}\n.lm-root h1 {\n  margin:0;\n  font-size:28px;\n  letter-spacing:-.8px;\n  font-weight:600}\n.lm-root .subtitle {\n  font-size:12px;\n  color:#8C8274;\n  margin:11px 0 0}\n.lm-root .heading .primary {\n  padding:12px 18px;\n  font-size:12px}\n.lm-root .metrics {\n  display:grid;\n  grid-template-columns:repeat(4,1fr);\n  border:1px solid var(--line);\n  border-radius:10px;\n  background:#fff;\n  margin-bottom:32px;\n  padding:21px 0}\n.lm-root .metric {\n  padding:0 25px;\n  border-right:1px solid var(--line)}\n.lm-root .metric:last-child {\n  border:0}\n.lm-root .metric-label {\n  color:#95897B;\n  font-size:11px;\n  display:flex;\n  justify-content:space-between}\n.lm-root .metric-value {\n  font-size:27px;\n  margin-top:8px;\n  letter-spacing:-1px}\n.lm-root .metric-value small {\n  display:inline;\n  font-size:10px;\n  letter-spacing:0;\n  margin-left:10px}\n.lm-root .toolbar {\n  display:flex;\n  justify-content:space-between;\n  align-items:center;\n  margin-bottom:19px;\n  gap:15px}\n.lm-root .tabs {\n  display:flex;\n  gap:21px;\n  align-items:center}\n.lm-root .tab {\n  padding:9px 0;\n  border:0;\n  background:transparent;\n  border-radius:0;\n  color:#8F8578;\n  font-size:12px}\n.lm-root .tab.active {\n  color:#A34A2C;\n  border-bottom:2px solid #A34A2C}\n.lm-root .tab span {\n  font-size:10px;\n  padding:2px 5px;\n  background:#F1E7DA;\n  margin-left:4px;\n  border-radius:4px}\n.lm-root .filters {\n  display:flex;\n  gap:9px}\n.lm-root .search {\n  background:white;\n  border:1px solid var(--line);\n  border-radius:6px;\n  padding:9px 12px;\n  display:flex;\n  align-items:center;\n  color:#A79E90;\n  gap:8px}\n.lm-root .search input {\n  border:0;\n  outline:none;\n  width:145px;\n  font-size:11px}\n.lm-root .filters select {\n  border:1px solid var(--line);\n  color:#807568;\n  border-radius:6px;\n  padding:0 10px;\n  font-size:11px;\n  background:#fff}\n.lm-root .table {\n  border:1px solid var(--line);\n  border-radius:10px;\n  background:white;\n  overflow:hidden}\n.lm-root .table-head,.lm-root .pipeline-row {\n  display:grid;\n  grid-template-columns:minmax(250px,2.5fr) 1fr .9fr 1fr 82px;\n  align-items:center;\n  gap:16px;\n  padding:0 23px}\n.lm-root .table-head {\n  height:42px;\n  background:#F6F1E6;\n  color:#9A9082;\n  font-size:10px}\n.lm-root .pipeline-row {\n  min-height:102px;\n  border-top:1px solid var(--line);\n  cursor:pointer}\n.lm-root .pipeline-row:hover {\n  background:#FDF8F0}\n.lm-root .pipeline-name {\n  display:flex;\n  align-items:center;\n  gap:14px}\n.lm-root .pipeline-icon {\n  flex-shrink:0;\n  width:42px;\n  height:42px;\n  border:1px solid #EDE1D1;\n  background:#F7EADC;\n  border-radius:11px;\n  display:grid;\n  place-items:center;\n  color:#A9704A;\n  font-size:20px}\n.lm-root .pipeline-icon.blue {\n  background:#F3EAE1;\n  color:#8A7C6B;\n  border-color:#EAE2D6}\n.lm-root .pipeline-icon.peach {\n  background:#FBF1E6;\n  color:#B98559;\n  border-color:#F0E6D9}\n.lm-root .pipeline-icon.purple {\n  background:#F5F0EA;\n  color:#8E7B68;\n  border-color:#e8e2ef}\n.lm-root .name {\n  font-size:13px;\n  font-weight:600}\n.lm-root .description {\n  font-size:10px;\n  color:#9C9184;\n  margin-top:7px}\n.lm-root .nodecount {\n  font-size:11px;\n  color:#93887A;\n  display:flex;\n  gap:8px;\n  align-items:center}\n.lm-root .mini-dag {\n  font-size:19px;\n  color:#C4B49C;\n  letter-spacing:-3px}\n.lm-root .badge {\n  font-size:10px;\n  border-radius:5px;\n  padding:5px 8px;\n  display:inline-block;\n  background:#EAECDF;\n  color:#60634E}\n.lm-root .badge.draft {\n  background:#F0EBE3;\n  color:#82786C}\n.lm-root .badge.running {\n  background:#E9EEF2;\n  color:#6F8CA3}\n.lm-root .badge.error {\n  background:#F5E3DA;\n  color:#A8522F}\n.lm-root .date {\n  font-size:11px;\n  color:#8D8375}\n.lm-root .date small {\n  font-size:9px}\n.lm-root .actions {\n  display:flex;\n  gap:6px}\n.lm-root .icon-btn {\n  padding:6px 8px;\n  background:transparent;\n  border:1px solid transparent;\n  color:#8F8472;\n  font-size:15px}\n.lm-root .footer {\n  display:flex;\n  justify-content:space-between;\n  color:#A79D8E;\n  font-size:10px;\n  padding:17px 2px}\n.lm-root .bottom-note {\n  text-align:center;\n  margin-top:36px;\n  color:#A79C8D;\n  font-size:10px;\n  letter-spacing:.3px}\n.lm-root .editor-bar {\n  display:flex;\n  align-items:center;\n  gap:10px;\n  margin-bottom:22px}\n.lm-root .editor-bar h1 {\n  font-size:21px;\n  margin-right:auto}\n.lm-root .canvas {\n  position:relative;\n  border:1px solid var(--line);\n  border-radius:12px;\n  min-height:420px;\n  overflow:auto;\n  background-color:#FBF6EF;\n  background-image:radial-gradient(#E0D3C2 1px,transparent 1px);\n  background-size:18px 18px}\n.lm-root .graph {\n  position:relative;\n  min-width:740px;\n  min-height:420px}\n.lm-root .graph svg {\n  position:absolute;\n  inset:0;\n  width:100%;\n  height:100%;\n  pointer-events:none}\n.lm-root .graph-node {\n  position:absolute;\n  width:180px;\n  background:white;\n  border:1px solid #dce5d6;\n  border-radius:9px;\n  padding:14px;\n  box-shadow:0 4px 12px #2E261C08;\n  cursor:pointer}\n.lm-root .graph-node:hover {\n  border-color:var(--green);\n  transform:translateY(-2px)}\n.lm-root .graph-node strong {\n  font-size:12px}\n.lm-root .graph-node p {\n  font-size:10px;\n  color:#978C7D;\n  margin:9px 0 0}\n.lm-root .graph-node .badge {\n  margin-top:10px}\n.lm-root .detail-grid {\n  display:grid;\n  grid-template-columns:1fr 310px;\n  gap:20px}\n.lm-root .panel {\n  padding:22px;\n  background:white;\n  border:1px solid var(--line);\n  border-radius:10px}\n.lm-root .panel h3 {\n  font-size:13px;\n  margin:0 0 15px}\n.lm-root .panel p {\n  font-size:11px;\n  color:#8E8475;\n  line-height:1.9}\n.lm-root .edge {\n  display:flex;\n  align-items:center;\n  justify-content:space-between;\n  font-size:11px;\n  padding:9px 0;\n  border-bottom:1px solid var(--line)}\n.lm-root .panel select {\n  width:100%;\n  margin-bottom:10px;\n  border:1px solid var(--line);\n  padding:9px;\n  border-radius:6px}\n.lm-root .panel button.wide {\n  width:100%;\n  font-size:11px}\n.lm-root .logs {\n  margin-top:20px;\n  background:#2B1D15;\n  color:#DCC8B4;\n  border-radius:10px;\n  padding:19px;\n  font:11px monospace;\n  line-height:1.9;\n  min-height:95px}\n.lm-root .logs b {\n  color:#F3E6D6;\n  font-weight:400}\n.lm-root .modal-wrap {\n  position:fixed;\n  inset:0;\n  background:#2B1D1555;\n  z-index:10;\n  display:grid;\n  place-items:center;\n  backdrop-filter:blur(3px)}\n.lm-root .modal {\n  background:#FAF7F0;\n  border-radius:14px;\n  padding:28px;\n  width:520px;\n  max-width:94vw;\n  max-height:90vh;\n  overflow:auto;\n  box-shadow:0 25px 80px #20382e30}\n.lm-root .modal h2 {\n  margin:0 0 8px;\n  font-size:20px}\n.lm-root .modal p {\n  color:#8F8576;\n  font-size:12px;\n  line-height:1.8}\n.lm-root .modal label {\n  display:block;\n  font-size:12px;\n  margin:18px 0 8px}\n.lm-root .modal input,.lm-root .modal textarea {\n  width:100%;\n  border:1px solid #E6D8C6;\n  border-radius:7px;\n  padding:10px;\n  background:white;\n  outline-color:#B9764F}\n.lm-root .modal textarea {\n  min-height:125px;\n  resize:vertical;\n  line-height:1.7}\n.lm-root .modal-actions {\n  display:flex;\n  justify-content:flex-end;\n  gap:9px;\n  margin-top:23px}\n.lm-root .danger {\n  color:#B2552F;\n  margin-right:auto}\n.lm-root .empty {\n  padding:70px;\n  text-align:center;\n  color:#8C8375;\n  font-size:13px}\n.lm-root .lm-toast {\n  position:fixed;\n  bottom:25px;\n  left:50%;\n  transform:translateX(-50%);\n  background:#2B1D15;\n  color:white;\n  padding:12px 20px;\n  border-radius:8px;\n  font-size:12px;\n  opacity:0;\n  pointer-events:none;\n  z-index:20;\n  transition:.2s}\n.lm-root .lm-toast.show {\n  opacity:1}\n.lm-root .starred {\n  color:#B98A4A}\n.lm-root .history-row {\n  display:flex;\n  justify-content:space-between;\n  border-top:1px solid var(--line);\n  padding:20px;\n  font-size:12px}\n@media(min-width:1500px) {\n  .lm-root .lm-app {\n  padding-top:50px}\n}\n@media(max-width:1100px) {\n  .lm-root main {\n  margin-left:200px}\n.lm-root .lm-app {\n  padding:30px 24px}\n.lm-root .table-head,.lm-root .pipeline-row {\n  grid-template-columns:minmax(210px,2fr) .8fr .8fr 80px;\n  gap:10px;\n  padding:0 16px}\n.lm-root .date {\n  display:none}\n.lm-root .detail-grid {\n  grid-template-columns:1fr}\n.lm-root .metrics .metric {\n  padding:0 15px}\n}\n@media(max-width:760px) {\n  .lm-root main {\n  margin:0}\n.lm-root header {\n  padding:0 20px}\n.lm-root .header-right {\n  display:none}\n.lm-root .lm-app {\n  padding:25px 16px}\n.lm-root .heading {\n  gap:12px}\n.lm-root h1 {\n  font-size:23px}\n.lm-root .metrics {\n  grid-template-columns:1fr 1fr;\n  row-gap:20px}\n.lm-root .metric:nth-child(2) {\n  border:0}\n.lm-root .toolbar {\n  align-items:flex-start;\n  flex-direction:column}\n.lm-root .table-head,.lm-root .pipeline-row {\n  grid-template-columns:minmax(180px,1fr) 70px 62px;\n  padding:0 12px;\n  gap:6px}\n.lm-root .nodecount {\n  display:none}\n.lm-root .pipeline-name {\n  gap:9px}\n.lm-root .pipeline-icon {\n  width:32px;\n  height:32px}\n.lm-root .description {\n  max-width:180px;\n  line-height:1.7}\n.lm-root .name {\n  font-size:12px}\n.lm-root .editor-bar {\n  flex-wrap:wrap}\n.lm-root .editor-bar h1 {\n  width:70%}\n.lm-root .filters {\n  width:100%}\n.lm-root .search {\n  flex:1}\n.lm-root .search input {\n  width:100%}\n}\n.lm-root .nodecount {\n  white-space:nowrap}\n.lm-root .nav span {\n  white-space:nowrap}\n@media(min-width:761px) and (max-width:1100px) {\n  .lm-root .mini-dag {\n  display:none}\n.lm-root .table-head,.lm-root .pipeline-row {\n  grid-template-columns:minmax(200px,2fr) 65px 80px 70px}\n.lm-root .nav {\n  padding-left:10px;\n  padding-right:8px;\n  gap:8px}\n}\n\n/* --- DSH panel shell adaptation (this plugin lives in the host's main slot) --- */\n.lm-root{height:100%;overflow:hidden}\n.lm-shell{height:100%;display:flex;flex-direction:column;background:var(--bg)}\n.lm-scroll{flex:1;min-height:0;overflow:auto}\n.lm-root main{margin-left:0}\n.lm-root .lm-app{padding:40px 42px;max-width:1600px;margin:0 auto;width:100%}\n.lm-nav{display:flex;gap:6px;padding:10px 42px;border-bottom:1px solid var(--line);background:#FAF7F0;flex:none;align-items:center}\n.lm-nav .nav{width:auto;border:1px solid transparent;background:none;border-radius:8px;padding:9px 14px;margin:0;display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#7D7064;text-align:left}\n.lm-nav .nav.active{color:#8A4A2C;background:#EBD8C9;font-weight:600}\n.lm-nav .nav i{margin-left:2px;font-size:10px;font-style:normal;background:#E7D3C0;padding:1px 6px;border-radius:4px;color:#5d7a58}\n.lm-root .demo{margin-left:13px;border:1px solid var(--line);padding:4px 7px;border-radius:4px;font-size:10px;color:#a9b1a9}\n.lm-root .online{display:inline-block;width:6px;height:6px;background:#8A6A4E;border-radius:50%;margin-right:7px}\n.lm-root .lm-stop{background:#2B1D15;border-color:#2B1D15;color:#F3E6D6}\n.lm-root .lm-stop:hover{background:#182b23;border-color:#182b23}\n.lm-root .graph-node{position:absolute;width:180px;min-height:84px;text-align:left;background:white;border:1px solid #EADFD1;border-radius:9px;padding:14px 16px;box-shadow:0 1px 2px #2E261C10}\n.lm-root .graph-node:hover{border-color:#D8C3A8;box-shadow:0 4px 12px #2E261C18}\n.lm-root .graph-node strong{display:block;font-size:13px;font-weight:600;margin-bottom:6px}\n.lm-root .graph-node p{margin:0;color:#8C8375;font-size:11px}\n.lm-root .graph-node .badge{margin-top:8px}\n.lm-root .graph-node.is-running{border-color:#C9A98F;box-shadow:0 0 0 3px #E9EEF2}\n.lm-root .graph-node.is-done{border-color:#CBB79B}\n.lm-root .graph-node.is-failed{border-color:#C98B6A;box-shadow:0 0 0 3px #F5E3DA}\n.lm-root .logs b{display:block;color:#F3E6D6;font-weight:400;margin-bottom:6px}\n.lm-root .logs .lm-mode{float:right;color:#A98C6D}\n.lm-root .logs .lm-log-line{white-space:pre-wrap;word-break:break-word}\n.lm-root .lm-empty-actions{display:flex;justify-content:center;gap:10px;padding:0 0 70px}\n.lm-root .lm-history-actions{display:flex;gap:10px;align-items:center}\n.lm-root .history-row{min-height:72px;align-items:center;gap:12px}\n.lm-root .history-row strong{flex:1;font-size:13px}\n.lm-root .history-row>span{color:#8C8375;font-size:12px;min-width:120px}\n.lm-root .pipeline-row .lm-run-badge{margin-left:8px}\n.lm-root .lm-crumb{font-weight:500;color:#5A4A3C}\n.lm-root .lm-title-actions{display:flex;gap:10px;align-items:center}\n@media(max-width:1100px){.lm-nav{padding:10px 24px}.lm-root .lm-app{padding:30px 24px}}\n@media(max-width:760px){.lm-nav{padding:8px 16px}.lm-nav .nav{font-size:12px;padding:8px 10px}.lm-root .lm-app{padding:25px 16px}}\n\n\n/* --- EMBER theme: hero band + theme chip --- */\n.lm-root{--ember:#B95C3A;--ember-deep:#9E4A2C;--ember-cream:#F2E8DC;--ember-line:#E8D9C6;--lm-mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace}\n.lm-root .lm-hero{position:relative;display:flex;align-items:center;justify-content:space-between;gap:26px;background:var(--ember-cream);border:1px solid var(--ember-line);border-radius:12px;padding:26px 30px 30px;margin:0 0 26px;overflow:hidden}\n.lm-root .lm-hero-main{max-width:640px}\n.lm-root .lm-hero-eyebrow{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:2px;color:#9A7B5E;font-weight:600;text-transform:uppercase}\n.lm-root .lm-hero-mark{width:7px;height:7px;background:var(--ember);display:inline-block}\n.lm-root .lm-hero-sep{color:#C9B49C}\n.lm-root .lm-hero-title{margin:13px 0 9px;font-size:33px;line-height:1.14;font-weight:600;color:#2E261C;letter-spacing:-.6px}\n.lm-root .lm-hero-title em{font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Songti SC',serif;font-style:italic;font-weight:500;color:#A34A2C}\n.lm-root .lm-hero-sub{margin:0 0 15px;color:#7D6F5F;font-size:13px}\n.lm-root .lm-hero-cmd{display:inline-flex;align-items:center;gap:9px;font:12px var(--lm-mono);color:#6B4A35;background:#FBF4EA;border:1px solid #E8D8C3;border-radius:6px;padding:8px 12px}\n.lm-root .lm-hero-prompt{color:var(--ember)}\n.lm-root .lm-hero-caret{color:var(--ember);animation:lm-blink 1.15s steps(2,start) infinite}\n@keyframes lm-blink{to{visibility:hidden}}\n.lm-root .lm-hero-art{flex:none;width:196px;align-self:flex-end;margin:0 4px -6px 0}\n.lm-root .lm-hero-art svg{display:block;width:100%;height:auto}\n.lm-root .lm-hero-foot{position:absolute;right:24px;bottom:15px;font-size:9px;letter-spacing:2px;color:#B39A80}\n.lm-root .lm-theme-chip{margin-left:12px;border:1px solid var(--line);border-radius:4px;padding:4px 7px;font-size:10px;letter-spacing:1px;color:#8A7A66;background:#FBF6EE}\n@media(max-width:1180px){.lm-root .lm-hero-art{display:none}.lm-root .lm-hero-main{max-width:none}}\n@media(max-width:760px){.lm-root .lm-hero{padding:20px 18px 24px}.lm-root .lm-hero-title{font-size:25px}.lm-root .lm-hero-cmd{font-size:11px}}\n\n/* --- form controls: roomy selects, segmented type switch, skill picker --- */\n.lm-root select{appearance:none;-webkit-appearance:none;min-height:40px;padding:10px 36px 10px 12px;border:1px solid #DCCEBC;border-radius:8px;background-color:#FFFDF9;font-size:12.5px;line-height:1.4;color:#2E261C;max-width:100%;text-overflow:ellipsis;background-image:url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.6 6 6.6l5-5' fill='none' stroke='%238A7A66' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px}\n.lm-root select:hover{border-color:#CBB69F}\n.lm-root select:focus{outline:2px solid #B95C3A2e;outline-offset:1px;border-color:#B98C6E}\n.lm-root .filters select.lm-sort{min-width:136px;font-size:12px}\n.lm-root .panel select{min-height:38px;font-size:12px;padding-right:32px;background-size:11px 7px}\n.lm-root .modal select{min-height:40px;font-size:12.5px}\n.lm-root .lm-seg{display:inline-flex;gap:3px;margin:8px 0 2px;padding:3px;background:#F3EADF;border:1px solid #E8DAC7;border-radius:9px}\n.lm-root .lm-seg-btn{border:1px solid transparent;background:transparent;border-radius:7px;padding:8px 18px;font-size:12px;color:#8A7A66;transition:.16s}\n.lm-root .lm-seg-btn:hover{background:#F8F0E5;border-color:transparent;color:#6B5B49}\n.lm-root .lm-seg-btn.active{background:#FFFDF9;color:#B95C3A;font-weight:600;border-color:#EBDCCB;box-shadow:0 1px 3px #2E261C14}\n.lm-root .lm-picker{position:relative}\n.lm-root .lm-picker-trigger{display:flex;align-items:center;gap:12px;width:100%;min-height:46px;text-align:left;padding:9px 12px;border:1px solid #DCCEBC;border-radius:8px;background:#FFFDF9}\n.lm-root .lm-picker-trigger:hover{background:#FFFDF9;border-color:#CBB69F}\n.lm-root .lm-picker-trigger[aria-expanded=\"true\"]{border-color:#B98C6E;box-shadow:0 0 0 3px #B95C3A1f}\n.lm-root .lm-picker-text{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}\n.lm-root .lm-picker-name{font-size:12.5px;font-weight:600;color:#2E261C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.lm-root .lm-picker-desc{font-size:10.5px;color:#9A8D7C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.lm-root .lm-picker-caret{flex:none;color:#A08F7A;font-size:10px;transform:translateY(1px)}\n.lm-root .lm-picker-menu{position:static;margin-top:6px;background:#FFFDF9;border:1px solid #E4D6C5;border-radius:10px;box-shadow:0 10px 26px #2E261C14;overflow:hidden}\n.lm-root .lm-picker-search{padding:10px;border-bottom:1px solid #F0E6D8;background:#FDF8F0}\n.lm-root .lm-picker-search input{width:100%;border:1px solid #E4D6C5;border-radius:7px;padding:8px 10px;font-size:12px;background:#FFFDF9;color:#2E261C;outline:none}\n.lm-root .lm-picker-search input:focus{border-color:#B98C6E;box-shadow:0 0 0 3px #B95C3A1a}\n.lm-root .lm-picker-list{max-height:224px;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:2px}\n.lm-root .lm-picker-option{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:7px;padding:9px 10px}\n.lm-root .lm-picker-option strong{font-size:12.5px;font-weight:600;color:#2E261C;line-height:1.3}\n.lm-root .lm-picker-option span{font-size:10.5px;color:#9A8D7C;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n.lm-root .lm-picker-option:hover{background:#F8EFE3;border-color:#EFE0CC}\n.lm-root .lm-picker-option.is-active{background:#FBF1E6;border-color:#E6CEB4}\n.lm-root .lm-picker-option.is-active strong{color:#B95C3A}\n\n.lm-root .lm-picker-empty{margin:0;padding:14px 16px;font-size:11.5px;color:#9A8D7C;border-top:1px solid #F3EADC;text-align:center}\n\n/* chevron must survive the older per-context `background` shorthands */\n.lm-root .modal select,.lm-root .filters select,.lm-root .panel select{-webkit-appearance:none;appearance:none;background-color:#FFFDF9;background-image:url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.6 6 6.6l5-5' fill='none' stroke='%238A7A66' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px}\n\n/* `hidden` must beat the picker/option display rules (see the live filter) */\n.lm-root [hidden]{display:none !important}\n.lm-root .lm-picker-option.is-cursor{background:#FBF1E6;border-color:#E6CEB4}\n.lm-root .lm-picker-option.is-cursor strong{color:#B95C3A}\n"

    const LM_EXTRA_CSS = `
.lm-root .graph-node .lm-node-model{margin-top:5px;color:#A0917F;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lm-root .logs .lm-log-node{margin:0 0 12px;padding:0 0 10px;border-bottom:1px solid #4A3527}
.lm-root .logs .lm-log-node:last-child{border-bottom:0;padding-bottom:0;margin-bottom:0}
.lm-root .logs .lm-log-head{color:#E9D8C4}
.lm-root .logs .lm-log-head.is-ok{color:#B9D6A8}
.lm-root .logs .lm-log-head.is-error{color:#E5A98B}
.lm-root .logs .lm-think{margin:5px 0 0 2px;border-left:2px solid #5C4433;padding-left:9px}
.lm-root .logs .lm-think>summary{cursor:pointer;color:#B49A80;font-size:10.5px;line-height:1.7;list-style:none;display:flex;align-items:center;gap:6px;user-select:none}
.lm-root .logs .lm-think>summary::-webkit-details-marker{display:none}
.lm-root .logs .lm-think>summary::before{content:'▸';font-size:9px;color:#8F7760;transition:transform .15s}
.lm-root .logs .lm-think[open]>summary::before{transform:rotate(90deg)}
.lm-root .logs .lm-think-body{margin-top:6px;color:#C5AE96;white-space:pre-wrap;word-break:break-word;font-size:10.5px;line-height:1.8;max-height:280px;overflow:auto;padding-right:4px}
.lm-root .logs .lm-log-output{margin-top:7px;padding:10px 12px;border:1px solid #57402E;border-radius:8px;background:#33241A}
.lm-root .logs .lm-log-output-label{display:block;color:#9C8468;font-size:9.5px;letter-spacing:.08em;margin-bottom:5px}
.lm-root .logs .lm-log-output-text{color:#F1E4D5;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.85}
.lm-root .logs .lm-log-output-text.is-empty{color:#9C8468}
.lm-root .logs .lm-log-live{color:#D8B98D}
.lm-root .modal .lm-model-hint{margin:7px 0 0;color:#9A8D7C;font-size:10.5px;line-height:1.6}
.lm-root .modal .lm-model-hint.is-error{color:#B95C3A}
.lm-root .lm-db-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.lm-root .modal .lm-db-grid label{margin-top:14px}
.lm-root .lm-db-switch{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:18px 0 4px;padding:12px 14px;border:1px solid #E4D6C5;border-radius:10px;background:#FFFDF9}
.lm-root .lm-db-switch strong{display:block;font-size:12.5px;font-weight:600;color:#2E261C}
.lm-root .lm-db-switch small{display:block;font-size:10.5px;color:#9A8D7C;margin-top:4px;line-height:1.6}
.lm-root .lm-switch{position:relative;display:inline-flex;flex:none}
.lm-root .lm-switch input{position:absolute;opacity:0;width:0;height:0;margin:0}
.lm-root .lm-switch i{display:block;width:42px;height:24px;border-radius:999px;background:#D8CCBC;transition:.18s;position:relative}
.lm-root .lm-switch i::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s;box-shadow:0 1px 3px #2E261C33}
.lm-root .lm-switch input:checked+i{background:#B95C3A}
.lm-root .lm-switch input:checked+i::after{transform:translateX(18px)}
.lm-root .lm-db-status{margin:12px 0 0;padding:9px 12px;border-radius:7px;background:#F3EADF;color:#7D6F5F;font-size:11.5px;line-height:1.6}
.lm-root .lm-db-status.is-ok{background:#EAF1E6;color:#286E53}
.lm-root .lm-db-status.is-error{background:#F5E3DA;color:#A8522F}
.lm-root .lm-db-hint{margin:8px 0 0;color:#9A8D7C;font-size:10.5px;line-height:1.7}
.lm-root .lm-db-ssl{display:flex;align-items:center;gap:8px;margin:16px 0 0;font-size:11.5px;color:#7D6F5F}
.lm-root .lm-db-ssl input{width:auto;margin:0}
/* --- v9 Loop orchestration (CONTRACT §13.7) --- */
.lm-root .badge.awaiting{background:#F6E7D2;color:#9A6B32}
.lm-root .lm-loop-flowcell{font-size:11px;color:#8C8375;line-height:1.6;min-width:0}
.lm-root .lm-loop-flowcell b{display:block;font-weight:600;color:#5A4A3C;font-size:11.5px}
.lm-root .lm-loop-flowcell span{display:block;margin-top:3px;color:#A0917F;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lm-root .lm-loop-flow{display:flex;flex-direction:column}
.lm-root .lm-loop-stage{display:grid;grid-template-columns:minmax(0,1fr) 86px minmax(0,1fr);gap:12px;align-items:stretch}
.lm-root .lm-loop-pipeline,.lm-root .lm-loop-gate{position:relative;min-width:0;border:1px solid #EADFD1;border-radius:10px;background:#FFFDF9;padding:15px 16px;box-shadow:0 1px 2px #2E261C0d}
.lm-root .lm-loop-pipeline.is-missing{border-style:dashed}
.lm-root .lm-loop-pipeline.is-running{border-color:#C9A98F;box-shadow:0 0 0 3px #E9EEF2}
.lm-root .lm-loop-gate.is-awaiting{border-color:#E2C093;box-shadow:0 0 0 3px #F6E7D2}
.lm-root .lm-loop-gate.is-failed{border-color:#D8A58A;box-shadow:0 0 0 3px #F5E3DA}
.lm-root .lm-loop-gate.is-passed{border-color:#C9D3B3}
.lm-root .lm-loop-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.lm-root .lm-loop-kind{font-size:9px;letter-spacing:1.6px;color:#A0764F;font-weight:600}
.lm-root .lm-loop-card-title{display:block;font-size:13px;font-weight:600;color:#2E261C;line-height:1.4;word-break:break-word}
.lm-root .lm-loop-card-meta{margin:7px 0 0;font-size:10.5px;color:#978C7D;line-height:1.7}
.lm-root .lm-loop-card-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-items:center}
.lm-root .lm-loop-arrow{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:3px;color:#A0764F;font-size:16px}
.lm-root .lm-loop-arrow-label{font-size:9px;letter-spacing:.6px;color:#9A8D7C;white-space:nowrap}
.lm-root .lm-loop-link{display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 0;color:#A0917F;font-size:10px;letter-spacing:.6px}
.lm-root .lm-loop-link::before,.lm-root .lm-loop-link::after{content:'';height:1px;background:#E7DED0;flex:1;max-width:120px}
.lm-root .lm-loop-finish{display:flex;align-items:center;justify-content:center;gap:7px;margin:2px 0 0;padding:9px;border:1px dashed #E4D6C5;border-radius:9px;color:#9A8D7C;font-size:10px;letter-spacing:.4px;background:#FDF8F0}
.lm-root .lm-loop-retry{margin-top:10px;padding:7px 12px;font-size:11px;border:1px solid #D8A96F;background:#FBF0DF;color:#8A5A1F;border-radius:7px}
.lm-root .lm-loop-retry:hover{background:#F6E7D2;border-color:#C99A5C}
.lm-root .lm-loop-error{margin:8px 0 0;font-size:10.5px;color:#A8522F;line-height:1.65;word-break:break-word}
.lm-root .lm-loop-rules{margin:0;padding:0;list-style:none}
.lm-root .lm-loop-rules li{position:relative;padding:0 0 0 16px;margin:0 0 10px;font-size:11px;color:#8E8475;line-height:1.85}
.lm-root .lm-loop-rules li::before{content:'·';position:absolute;left:2px;color:#B95C3A;font-weight:700}
.lm-root .lm-loop-rules b{color:#5A4A3C;font-weight:600}
.lm-root .modal.lm-loop-form{width:760px}
.lm-root .lm-loop-steps{display:flex;flex-direction:column;gap:14px;margin:14px 0 0}
.lm-root .lm-loop-step{border:1px solid #E8DAC7;border-radius:10px;padding:15px 16px 13px;background:#FFFDF9}
.lm-root .lm-loop-step-head{display:flex;align-items:center;gap:8px}
.lm-root .lm-loop-step-index{font-size:9.5px;letter-spacing:1.5px;color:#A0764F;font-weight:600}
.lm-root .lm-loop-step-actions{margin-left:auto;display:flex;gap:5px}
.lm-root .lm-loop-step-actions button{padding:4px 9px;font-size:11px;line-height:1.5;border-radius:6px;height:27px}
.lm-root .lm-loop-step label{display:block;font-size:11.5px;margin:12px 0 6px;color:#6B5B49}
.lm-root .lm-loop-step label:first-of-type{margin-top:2px}
.lm-root .lm-loop-step select{width:100%}
.lm-root .lm-loop-step input[type="number"],.lm-root .lm-loop-step input:not([type]),.lm-root .lm-loop-step input[type="text"],.lm-root .lm-loop-step textarea{width:100%;border:1px solid #E6D8C6;border-radius:7px;padding:9px 10px;background:white;outline-color:#B9764F;font-size:12.5px}
.lm-root .lm-loop-step textarea{min-height:84px;resize:vertical;line-height:1.7}
.lm-root .lm-loop-step .lm-model-hint{margin-top:6px}
.lm-root .lm-loop-step label.lm-loop-auto{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0 0;padding:10px 12px;border:1px solid #EFE3D2;border-radius:9px;background:#FBF5EB}
.lm-root .lm-loop-step label.lm-loop-auto strong{display:block;font-size:11.5px;font-weight:600;color:#2E261C}
.lm-root .lm-loop-step label.lm-loop-auto small{display:block;font-size:10px;color:#9A8D7C;margin-top:3px;line-height:1.6}
.lm-root .lm-loop-step label.lm-loop-max{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:11.5px;color:#6B5B49}
.lm-root .lm-loop-step label.lm-loop-max input{width:82px;margin:0}
.lm-root .lm-loop-add{width:100%;margin-top:12px;border:1px dashed #DCC9B2;background:#FDF8F1;color:#8A5A3C;padding:10px;font-size:12px}
.lm-root .lm-loop-add:hover{background:#FBF1E6;border-color:#CBB69F}
.lm-root .lm-loop-hint{margin:8px 0 0;font-size:10.5px;color:#9A8D7C;line-height:1.7}
.lm-root .lm-loop-hint.is-error{color:#A8522F}
.lm-root .lm-loop-empty{padding:24px;text-align:center;border:1px dashed #E0D1BE;border-radius:10px;color:#9A8D7C;font-size:11.5px;background:#FDF8F1}
.lm-root .logs .lm-loop-log-step{margin:0 0 12px;padding:0 0 10px;border-bottom:1px solid #4A3527}
.lm-root .logs .lm-loop-log-step:last-of-type{border-bottom:0}
.lm-root .logs .lm-loop-log-title{color:#E9D8C4;margin-bottom:7px}
.lm-root .logs .lm-loop-log-title .badge{margin-left:8px;vertical-align:middle}
.lm-root .logs .lm-loop-log-sub{color:#B49A80;font-size:10px;letter-spacing:.4px;margin:0 0 5px}
.lm-root .logs .lm-loop-log-sub.is-error{color:#E5A98B}
@media(max-width:1100px){
.lm-root .lm-loop-stage{grid-template-columns:1fr}
.lm-root .lm-loop-arrow{flex-direction:row;gap:7px;padding:2px 0}
.lm-root .modal.lm-loop-form{width:94vw}
}
@media(max-width:760px){
.lm-root .lm-loop-step-actions{flex-wrap:wrap}
.lm-root .lm-loop-auto{flex-direction:column;align-items:flex-start}
.lm-root .lm-loop-stage{gap:9px}
.lm-root .lm-loop-link{padding:7px 0}
}
`

    const STATUS_META: Record<string, { label: string; className: string }> = {
      draft: { label: '草稿', className: 'draft' },
      running: { label: '运行中', className: 'running' },
      success: { label: '已完成', className: 'success' },
      error: { label: '运行失败', className: 'error' },
    }

    const NODE_STATUS_META: Record<string, { label: string; className: string }> = {
      pending: { label: '待执行', className: 'draft' },
      running: { label: '执行中', className: 'running' },
      completed: { label: '已完成', className: 'success' },
      failed: { label: '失败', className: 'error' },
      skipped: { label: '已跳过', className: 'draft' },
    }

    /** Loop / LoopRun / LoopStep status pills (CONTRACT §13.3). */
    const LOOP_STATUS_META: Record<string, { label: string; className: string }> = {
      draft: { label: '草稿', className: 'draft' },
      pending: { label: '待执行', className: 'draft' },
      running: { label: '运行中', className: 'running' },
      awaiting: { label: '等待人工', className: 'awaiting' },
      completed: { label: '已完成', className: 'success' },
      passed: { label: '已通过', className: 'success' },
      failed: { label: '运行失败', className: 'error' },
      stopped: { label: '已停止', className: 'draft' },
      skipped: { label: '已跳过', className: 'draft' },
    }

    /** Default Loop icon / gate defaults (CONTRACT §13.1). */
    const LOOP_ICON = '⟳'
    const LOOP_MAX_STEPS = 20
    const GATE_MAX_ITERATIONS = 20
    const GATE_DEFAULT_MAX_ITERATIONS = 3

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

    /** Escape a value for an HTML template string. */
    function esc(value: unknown) {
      return String(value === undefined || value === null ? '' : value).replace(
        /[&<>"']/g,
        (character) => HTML_ESCAPES[character],
      )
    }

    /** Local id for a node added in the editor (the server keeps ids it is given). */
    function newId() {
      const cryptoObject = typeof crypto !== 'undefined' ? crypto : undefined
      if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID()
      return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    /**
     * Stable Kahn topological sort. `edges` are `[from, to]` pairs.
     * @returns {string[] | null} the order, or null when the graph has a cycle.
     */
    function topo(nodes: ClientNode[], edges: [string, string][]) {
      const degree: Record<string, number> = {}
      for (const node of nodes) degree[node.id] = 0
      for (const edge of edges) degree[edge[1]] += 1
      const queue = nodes.filter((node) => degree[node.id] === 0).map((node) => node.id)
      const order = []
      while (queue.length > 0) {
        const id = queue.shift()!
        order.push(id)
        for (const edge of edges) {
          if (edge[0] !== id) continue
          degree[edge[1]] -= 1
          if (degree[edge[1]] === 0) queue.push(edge[1])
        }
      }
      return order.length === nodes.length ? order : null
    }

    /**
     * The prototype's layout: one column per dependency level, rows for
     * siblings, node cards 180x84 at 230/160 px steps.
     */
    function layout(nodes: ClientNode[], edges: [string, string][]) {
      const order = topo(nodes, edges) || []
      const level: Record<string, number> = {}
      for (const id of order) {
        let value = 0
        for (const edge of edges) {
          if (edge[1] !== id) continue
          value = Math.max(value, (level[edge[0]] || 0) + 1)
        }
        level[id] = value
      }
      const rows: Record<string, number> = {}
      const position: ClientCanvas['position'] = {}
      for (const node of nodes) {
        const column = level[node.id] || 0
        const row = rows[column] || 0
        rows[column] = row + 1
        position[node.id] = { x: 35 + column * 230, y: 90 + row * 160 }
      }
      let maxX = 0
      let maxY = 0
      for (const point of Object.values(position)) {
        maxX = Math.max(maxX, point.x)
        maxY = Math.max(maxY, point.y)
      }
      return { position, width: Math.max(740, maxX + 220), height: Math.max(420, maxY + 170) }
    }

    /** `HH:mm` in the browser's locale. */
    function clockOf(timestamp: unknown) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '—'
      return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    /** "今天 09:30" / "昨天 16:20" / "10-27 10:20". */
    function relativeDay(timestamp: unknown) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '尚未运行'
      const date = new Date(timestamp)
      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
      const clock = clockOf(timestamp)
      if (day === midnight) return `今天 ${clock}`
      if (day === midnight - 86400000) return `昨天 ${clock}`
      return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${clock}`
    }

    /** "0.9 秒" / "2 分 18 秒". */
    function durationText(milliseconds: unknown) {
      if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return ''
      if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`
      const seconds = milliseconds / 1000
      if (seconds < 60) return `${seconds.toFixed(1)} 秒`
      const minutes = Math.floor(seconds / 60)
      const rest = Math.round(seconds % 60)
      return `${minutes} 分 ${rest} 秒`
    }

    /** One status pill, same markup as the prototype. */
    function badge(status: string | undefined) {
      const meta = STATUS_META[status || ''] || STATUS_META.draft
      return `<span class="badge ${meta.className}">● &nbsp;${meta.label}</span>`
    }

    /** One node-status pill used inside the canvas cards. */
    function nodeBadge(status: string | undefined) {
      const meta = NODE_STATUS_META[status || ''] || NODE_STATUS_META.pending
      return `<span class="badge ${meta.className}">● &nbsp;${meta.label}</span>`
    }

    /** One Loop status pill (draft / running / awaiting / completed / failed / stopped). */
    function loopBadge(status: string | undefined) {
      const meta = LOOP_STATUS_META[status || ''] || LOOP_STATUS_META.draft
      return `<span class="badge ${meta.className}">● &nbsp;${meta.label}</span>`
    }

    /**
     * One JSON API call.
     * Returns the typed `{ ok: true, ... }` API envelope.
     */
    function errorMessage(error: unknown): string {
      return error !== null &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string' &&
        error.message
        ? error.message
        : String(error)
    }

    async function api(path: string, options?: RequestInit) {
      const init: RequestInit = Object.assign(
        { cache: 'no-store', headers: { accept: 'application/json' } },
        options || {},
      )
      if (init.body !== undefined) {
        init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' })
      }
      let response
      try {
        response = await fetch(API_BASE + path, init)
      } catch (error) {
        const failure: ClientApiError = new Error('无法连接到 Loop Manager 服务，请确认插件已加载。')
        failure.code = 'network'
        failure.cause = error
        throw failure
      }
      let body: ClientApiEnvelope | null = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || body === null || body.ok !== true) {
        const failure: ClientApiError = new Error(
          body && typeof body.error === 'string' && body.error
            ? body.error
            : response.status === 401
              ? '请求未通过连接校验，请刷新页面后重试。'
              : `HTTP ${response.status}`,
        )
        failure.code = body && typeof body.code === 'string' ? body.code : undefined
        failure.status = response.status
        throw failure
      }
      return body
    }

    // ------------------------------------------------------------------
    // The workbench app (vanilla DOM, mounted into .lm-root)
    // ------------------------------------------------------------------

    /** The warm "agent workbench" hero band above the pipeline table. */
    function heroMarkup() {
      return (
        '<section class="lm-hero">' +
        '<div class="lm-hero-main">' +
        '<div class="lm-hero-eyebrow"><span class="lm-hero-mark"></span> Agent workbench <span class="lm-hero-sep">|</span> v0.1 / preview · 真实执行</div>' +
        '<h2 class="lm-hero-title">Make room for <em>deep work.</em></h2>' +
        '<p class="lm-hero-sub">你定义目标，Agent 负责下一步。</p>' +
        '<div class="lm-hero-cmd"><span class="lm-hero-prompt">›</span> harness run --pipeline your-next-idea <span class="lm-hero-caret">▍</span></div>' +
        '</div>' +
        '<div class="lm-hero-foot">READY WHEN YOU ARE.</div>' +
        '</section>'
      )
    }

    /** Build the page markup once; every later render replaces `.lm-app`. */
    function shellMarkup() {
      return (
        '<div class="lm-shell">' +
        '<header><span>工作空间 <span class="slash">/</span> <b class="lm-crumb">Agent Pipeline</b></span>' +
        '<span class="header-right"><span class="online"></span> 所有更改已保存 <span class="demo">真实运行</span></span></header>' +
        '<div class="lm-nav">' +
        '<button class="nav active" data-nav="all">▦ <span>Agent Pipeline</span><i class="lm-count">0</i></button>' +
        '<button class="nav" data-nav="loops">⟳ <span>Loop</span><i class="lm-loop-count">0</i></button>' +
        '<button class="nav" data-nav="recent">◷ <span>运行记录</span></button>' +
        '<button class="nav" data-nav="star">☆ <span>已收藏</span></button>' +
        '<button class="nav" data-db="1">▤ <span>数据库配置</span></button>' +
        '</div>' +
        '<div class="lm-scroll"><div class="lm-app"></div></div>' +
        '</div>' +
        '<div class="lm-overlay"></div>' +
        '<div class="lm-toast"></div>'
      )
    }

    /**
     * Mount the workbench into one host element.
     * @param {HTMLElement} root - element owned by this plugin instance.
     * @returns {() => void} disposer.
     */
    function createApp(root: HTMLElement) {
      const state: ClientState = {
        pipelines: [],
        runs: [],
        /** v9 Loop orchestration (CONTRACT §13.1 / §13.3). */
        loops: [],
        loopRuns: [],
        /** Selected loop id for the detail view (nav === 'loops'). */
        selectedLoop: null,
        /** Draft being edited by the Loop modal (null when closed). */
        loopDraft: null,
        loading: true,
        error: null,
        nav: 'all',
        filter: 'all',
        query: '',
        sort: 'recent',
        selected: null,
        editingNodeId: null,
        skills: [],
        skillsLoading: false,
        skillsError: null,
        skillsAt: 0,
        models: [],
        modelsLoading: false,
        modelsError: null,
        modelsAt: 0,
        modelsDefault: null,
        busy: null,
        /** `<details>` keys (runId:nodeId / loopRunId:stepId:gate) the user expanded. */
        openThinking: new Set(),
        scrollTop: 0,
        toastTimer: null,
      }

      root.innerHTML = shellMarkup()
      const crumb = root.querySelector<HTMLElement>('.lm-crumb')!
      const navBar = root.querySelector<HTMLElement>('.lm-nav')!
      const count = root.querySelector<HTMLElement>('.lm-count')!
      const loopCount = root.querySelector<HTMLElement>('.lm-loop-count')!
      const app = root.querySelector<HTMLElement>('.lm-app')!
      const scroll = root.querySelector<HTMLElement>('.lm-scroll')!
      const overlay = root.querySelector<HTMLElement>('.lm-overlay')!
      const toastNode = root.querySelector<HTMLElement>('.lm-toast')!

      let disposed = false
      let timer: number | null = null
      let pending = false

      // ---------------- data ----------------

      function normalizePipeline(pipeline: ClientWireRecord): ClientPipeline {
        return Object.assign(
          {
            id: pipeline.id as string,
            name: pipeline.name as string,
            createdAt: pipeline.createdAt as number,
            updatedAt: pipeline.updatedAt as number,
          },
          pipeline,
          {
            desc: typeof pipeline.desc === 'string' ? pipeline.desc : '',
            icon: typeof pipeline.icon === 'string' && pipeline.icon !== '' ? pipeline.icon : '◈',
            color: typeof pipeline.color === 'string' ? pipeline.color : '',
            star: pipeline.star === true,
            nodes: (Array.isArray(pipeline.nodes) ? pipeline.nodes : []).map((node) => ({
              id: node.id,
              name: typeof node.name === 'string' ? node.name : '',
              type: node.type === 'skill' ? 'skill' : 'agent',
              command: typeof node.command === 'string' ? node.command : '',
              skill: typeof node.skill === 'string' ? node.skill : '',
              // A node may pin one deployment model. Missing/blank means "use the
              // Harness default selection" (the same default the chat composer shows).
              model:
                node !== null &&
                typeof node === 'object' &&
                node.model !== null &&
                typeof node.model === 'object' &&
                typeof node.model.provider === 'string' &&
                node.model.provider !== '' &&
                typeof node.model.model === 'string' &&
                node.model.model !== ''
                  ? { provider: node.model.provider, model: node.model.model }
                  : null,
            })),
            edges: (Array.isArray(pipeline.edges) ? pipeline.edges : []).map(
              (edge) => (Array.isArray(edge) ? [edge[0], edge[1]] : [edge.from, edge.to]) as [string, string],
            ),
          },
        )
      }

      /** Wire shape (the API takes `{ from, to }` objects). */
      function pipelineWire(pipeline: ClientPipeline) {
        return {
          name: pipeline.name,
          desc: pipeline.desc,
          icon: pipeline.icon,
          color: pipeline.color,
          star: pipeline.star === true,
          nodes: pipeline.nodes.map((node) => {
            const base = { id: node.id, name: node.name, type: node.type === 'skill' ? 'skill' : 'agent' }
            const model =
              node.model && typeof node.model.provider === 'string' && typeof node.model.model === 'string'
                ? { provider: node.model.provider, model: node.model.model }
                : undefined
            const withModel = model === undefined ? base : Object.assign(base, { model })
            if (node.type === 'skill')
              return Object.assign(withModel, { skill: node.skill, command: node.command || '' })
            return Object.assign(withModel, { command: node.command })
          }),
          edges: pipeline.edges.map(([from, to]) => ({ from, to })),
        }
      }

      function pipelineById(id: string | null) {
        return state.pipelines.find((pipeline) => pipeline.id === id)
      }

      // ---------------- v9 Loop data (CONTRACT §13.1) ----------------

      /** Build a `{provider, model}` pair, or null when it is incomplete. */
      function normalizeModel(model: ClientWireRecord | null | undefined) {
        if (model === null || typeof model !== 'object') return null
        if (typeof model.provider !== 'string' || model.provider === '') return null
        if (typeof model.model !== 'string' || model.model === '') return null
        return { provider: model.provider, model: model.model }
      }

      /** Normalize one gate (`steps[i].gate`) with its contract defaults. */
      function normalizeGate(gate: ClientWireRecord | null | undefined, stepId: string): ClientGate {
        const source = gate !== null && typeof gate === 'object' ? gate : {}
        const maxIterations = Number.isInteger(source.maxIterations)
          ? source.maxIterations
          : GATE_DEFAULT_MAX_ITERATIONS
        return {
          id: typeof source.id === 'string' && source.id !== '' ? source.id : `${stepId}-gate`,
          name: typeof source.name === 'string' && source.name !== '' ? source.name : '门禁',
          type: source.type === 'skill' ? 'skill' : 'agent',
          command: typeof source.command === 'string' ? source.command : '',
          skill: typeof source.skill === 'string' ? source.skill : '',
          model: normalizeModel(source.model),
          autoLoop: source.autoLoop === true,
          maxIterations:
            maxIterations >= 1 && maxIterations <= GATE_MAX_ITERATIONS ? maxIterations : GATE_DEFAULT_MAX_ITERATIONS,
        }
      }

      /** Normalize one Loop; `steps` is always an array (≥1 after a save). */
      function normalizeLoop(loop: ClientWireRecord): ClientLoop {
        const steps = (Array.isArray(loop.steps) ? loop.steps : []).map((step, index) => {
          const source = step !== null && typeof step === 'object' ? step : {}
          const stepId = typeof source.id === 'string' && source.id !== '' ? source.id : `step-${index + 1}`
          return {
            id: stepId,
            pipelineId: typeof source.pipelineId === 'string' ? source.pipelineId : '',
            gate: normalizeGate(source.gate, stepId),
          }
        })
        return Object.assign({ id: loop.id as string, name: loop.name as string }, loop, {
          desc: typeof loop.desc === 'string' ? loop.desc : '',
          icon: typeof loop.icon === 'string' && loop.icon !== '' ? loop.icon : LOOP_ICON,
          color: typeof loop.color === 'string' ? loop.color : '',
          star: loop.star === true,
          steps,
          createdAt: typeof loop.createdAt === 'number' ? loop.createdAt : 0,
          updatedAt: typeof loop.updatedAt === 'number' ? loop.updatedAt : 0,
        })
      }

      /** Wire shape of one Loop for POST/PUT `/loops` (CONTRACT §13.1). */
      function loopWire(loop: ClientLoop | ClientLoopDraft) {
        return {
          name: loop.name,
          desc: loop.desc,
          icon: loop.icon === '' ? LOOP_ICON : loop.icon,
          color: loop.color,
          star: loop.star === true,
          steps: loop.steps.map((step) => {
            const gate = step.gate
            const gateWire: Omit<ClientGate, 'skill' | 'model'> & { skill?: string; model?: ClientModel } = {
              id: gate.id,
              name: gate.name,
              type: gate.type === 'skill' ? 'skill' : 'agent',
              command: gate.command || '',
              autoLoop: gate.autoLoop === true,
              maxIterations: gate.maxIterations,
            }
            if (gate.type === 'skill') gateWire.skill = gate.skill
            if (gate.model !== null && typeof gate.model === 'object') gateWire.model = gate.model
            return {
              id: step.id,
              pipelineId: step.pipelineId,
              gate: gateWire,
            }
          }),
        }
      }

      function loopById(id: string | null) {
        return state.loops.find((loop) => loop.id === id)
      }

      /** LoopRun history of one Loop, newest first (startedAt desc). */
      function loopRunsOf(loopId: string) {
        return state.loopRuns
          .filter((run) => run.loopId === loopId)
          .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0))
      }

      function lastLoopRunOf(loopId: string) {
        const runs = loopRunsOf(loopId)
        return runs.length > 0 ? runs[0] : null
      }

      function runningLoopRunOf(loopId: string) {
        return loopRunsOf(loopId).find((run) => run.status === 'running') || null
      }

      function loopRunById(runId: string) {
        return state.loopRuns.find((run) => run.id === runId) || null
      }

      /** Newest LoopRun status of one Loop ('draft' when it never ran). */
      function lastLoopRunStatus(loopId: string) {
        const run = lastLoopRunOf(loopId)
        return run === null ? 'draft' : run.status
      }

      /** Step state of one step inside a LoopRun. */
      function stepStateOf(run: ClientLoopRun | null, stepId: string) {
        const states =
          run !== null && run.stepStates !== null && typeof run.stepStates === 'object' ? run.stepStates : {}
        const value = states[stepId]
        return value !== null && typeof value === 'object' ? value : {}
      }

      /** Id of the step the run is currently on (first non-completed), or null. */
      function currentStepIdOf(loop: ClientLoop, run: ClientLoopRun | null) {
        if (run === null) return null
        const order = Array.isArray(run.order) && run.order.length > 0 ? run.order : loop.steps.map((step) => step.id)
        for (const id of order) {
          const stepState = stepStateOf(run, id)
          if (stepState.status !== 'completed') return id
        }
        return null
      }

      /**
       * A step needs a human "重新循环" when the latest LoopRun is waiting
       * (awaiting / failed) and this group is the one that stopped
       * (CONTRACT §13.7). Step/gate awaiting always qualifies.
       */
      function needsManualRetry(loop: ClientLoop, run: ClientLoopRun | null, step: ClientStep) {
        if (run === null) return false
        if (run.status !== 'awaiting' && run.status !== 'failed') return false
        const stepState = stepStateOf(run, step.id)
        if (stepState.status === 'awaiting' || stepState.gateStatus === 'awaiting') return true
        return currentStepIdOf(loop, run) === step.id
      }

      /** Run state of one group's pipeline (`stepState.pipelineRunId` in `/state.runs`). */
      function pipelineRunOfStep(loopRun: ClientLoopRun, stepState: ClientStepState) {
        const runId = stepState.pipelineRunId
        if (typeof runId !== 'string' || runId === '') return null
        return state.runs.find((run) => run.id === runId) || null
      }

      function runsOf(pipelineId: string) {
        return state.runs.filter((run) => run.pipelineId === pipelineId)
      }

      function lastRunOf(pipelineId: string) {
        const runs = runsOf(pipelineId)
        return runs.length > 0 ? runs[0] : null
      }

      function runningRunOf(pipelineId: string) {
        return runsOf(pipelineId).find((run) => run.status === 'running') || null
      }

      function statusOf(pipeline: ClientPipeline) {
        const run = lastRunOf(pipeline.id)
        if (run === null) return 'draft'
        if (run.status === 'running') return 'running'
        if (run.status === 'completed') return 'success'
        return 'error'
      }

      function anyRunning() {
        return (
          state.runs.some((run) => run.status === 'running') || state.loopRuns.some((run) => run.status === 'running')
        )
      }

      function schedulePoll() {
        if (timer !== null) clearTimeout(timer)
        if (disposed) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        if (hidden) {
          timer = setTimeout(schedulePoll, POLL_RUNNING_MS)
          return
        }
        const delay = anyRunning() ? POLL_RUNNING_MS : POLL_IDLE_MS
        timer = setTimeout(() => {
          void refresh()
        }, delay)
      }

      async function refresh() {
        if (disposed || pending) return
        pending = true
        try {
          const body = await api('/state')
          if (disposed) return
          state.pipelines = (Array.isArray(body.pipelines) ? body.pipelines : []).map(normalizePipeline)
          state.runs = Array.isArray(body.runs) ? body.runs : []
          state.loops = (Array.isArray(body.loops) ? body.loops : []).map(normalizeLoop)
          state.loopRuns = Array.isArray(body.loopRuns) ? body.loopRuns : []
          state.loading = false
          state.error = null
          if (state.selected !== null && pipelineById(state.selected) === undefined) state.selected = null
          if (state.selectedLoop !== null && loopById(state.selectedLoop) === undefined) state.selectedLoop = null
          render()
        } catch (error) {
          if (disposed) return
          state.loading = false
          state.error = errorMessage(error)
          render()
        } finally {
          pending = false
          schedulePoll()
        }
      }

      /** Run one mutation, then refresh; failures become a toast. */
      async function mutate(action: () => Promise<unknown>, successMessage?: string) {
        try {
          await action()
          await refresh()
          if (successMessage) toast(successMessage)
          return true
        } catch (error) {
          toast(errorMessage(error))
          return false
        }
      }

      function savePipeline(pipeline: ClientPipeline) {
        return mutate(() =>
          api(`/pipelines/${pipeline.id}`, {
            method: 'PUT',
            body: JSON.stringify(pipelineWire(pipeline)),
          }),
        )
      }

      function patchPipeline(id: string, patch: Partial<ClientPipeline>) {
        return mutate(() => api(`/pipelines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }))
      }

      /** Read the deployment's installed-skill catalog (cached for 15 s). */
      async function loadSkills() {
        if (state.skillsLoading) return
        if (state.skillsAt !== 0 && Date.now() - state.skillsAt < 15000) return
        state.skillsLoading = true
        try {
          const body = await api('/skills')
          state.skills = Array.isArray(body.skills) ? body.skills : []
          state.skillsError = body.unavailable ? body.error || '该部署没有挂载 skill 服务' : body.error || null
          state.skillsAt = Date.now()
        } catch (error) {
          state.skillsError = errorMessage(error)
        } finally {
          state.skillsLoading = false
        }
      }

      /** One in-flight model-catalog read, shared by mount and the node modal. */
      let modelsLoadPromise: Promise<void> | null = null

      /** Read the deployment's model catalog (the chat composer's own list). */
      function loadModels() {
        if (modelsLoadPromise !== null) return modelsLoadPromise
        if (state.modelsAt !== 0 && Date.now() - state.modelsAt < 30000) return Promise.resolve()
        state.modelsLoading = true
        modelsLoadPromise = (async () => {
          try {
            const body = await api('/models')
            state.models = (Array.isArray(body.providers) ? body.providers : [])
              .filter(
                (provider) => provider !== null && typeof provider === 'object' && typeof provider.id === 'string',
              )
              .map((provider) => ({
                id: provider.id,
                name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
                models: (Array.isArray(provider.models) ? provider.models : [])
                  .filter(
                    (model) =>
                      model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '',
                  )
                  .map((model) => ({
                    id: model.id,
                    name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
                  })),
              }))
              .filter((provider) => provider.models.length > 0)
            state.modelsDefault =
              body.default !== null &&
              typeof body.default === 'object' &&
              typeof body.default.provider === 'string' &&
              typeof body.default.model === 'string'
                ? { provider: body.default.provider, model: body.default.model }
                : null
            if (body.unavailable === true) state.modelsError = body.error || '该部署没有挂载模型服务'
            else if (Array.isArray(body.failures) && body.failures.length > 0) {
              state.modelsError =
                body.failures
                  .map((failure) => (failure && typeof failure.name === 'string' ? failure.name : failure?.id))
                  .filter(Boolean)
                  .join('、') + ' 的模型列表读取失败'
            } else state.modelsError = body.error || null
            state.modelsAt = Date.now()
          } catch (error) {
            state.modelsError = errorMessage(error)
          } finally {
            state.modelsLoading = false
            modelsLoadPromise = null
          }
        })()
        return modelsLoadPromise
      }

      /** Provider groups in the chat picker's order (account, official, then the rest). */
      function orderedModelProviders() {
        const rank = (id: string) => (id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2)
        return state.models.slice().sort((left, right) => rank(left.id) - rank(right.id))
      }

      /** Display label of one node's pinned model, resolved against the catalog. */
      function modelLabelOf(model: ClientModel | null | undefined) {
        if (model === null || typeof model !== 'object') return ''
        if (typeof model.provider !== 'string' || typeof model.model !== 'string') return ''
        for (const provider of state.models) {
          if (provider.id !== model.provider) continue
          const found = provider.models.find((candidate) => candidate.id === model.model)
          return found !== undefined ? found.name : model.model
        }
        return model.model
      }

      /** Display label of the Harness default selection. */
      function defaultModelLabel() {
        const label = modelLabelOf(state.modelsDefault)
        return label === '' ? '' : label
      }

      /** Wire value of `{provider, model}` inside the model <select>. */
      function modelValueOf(model: ClientModel | null | undefined) {
        if (model === null || typeof model !== 'object') return ''
        if (typeof model.provider !== 'string' || typeof model.model !== 'string') return ''
        return JSON.stringify([model.provider, model.model])
      }

      /** Parse one model <select> value back into `{provider, model}` or null. */
      function modelFromValue(value: unknown) {
        if (typeof value !== 'string' || value === '') return null
        try {
          const parsed = JSON.parse(value)
          if (
            Array.isArray(parsed) &&
            typeof parsed[0] === 'string' &&
            typeof parsed[1] === 'string' &&
            parsed[0] !== '' &&
            parsed[1] !== ''
          ) {
            return { provider: parsed[0], model: parsed[1] }
          }
        } catch {
          // An unknown value means "inherit the default".
        }
        return null
      }

      /** The node form's model dropdown, mirroring the chat composer's catalog. */
      function modelControlMarkup(currentModel: ClientModel | null | undefined) {
        const currentValue = modelValueOf(currentModel)
        const defaultLabel = defaultModelLabel()
        const inheritLabel = defaultLabel === '' ? '跟随 Harness 默认模型' : `跟随 Harness 默认模型（${defaultLabel}）`
        const pinnedKnown =
          currentValue !== '' &&
          state.models.some((provider) =>
            provider.models.some((model) => modelValueOf({ provider: provider.id, model: model.id }) === currentValue),
          )
        const pinnedFallback = pinnedKnown
          ? ''
          : currentValue === ''
            ? ''
            : `<option value="${esc(currentValue)}" selected>${esc(currentModel!.provider + ' / ' + currentModel!.model)}（当前不可用）</option>`
        const groups = orderedModelProviders()
          .map((provider) => {
            const options = provider.models
              .map((model) => {
                const value = modelValueOf({ provider: provider.id, model: model.id })
                return `<option value="${esc(value)}" ${value === currentValue ? 'selected' : ''}>${esc(model.name)}</option>`
              })
              .join('')
            return `<optgroup label="${esc(provider.name)}">${options}</optgroup>`
          })
          .join('')
        const hint = state.modelsLoading
          ? '正在读取 Harness 模型列表…'
          : state.models.length === 0
            ? state.modelsError || '未读取到可用模型，将使用 Harness 默认模型'
            : '与 DeepSeek Harness 的模型列表一致；选择「跟随默认」时使用当前部署的默认模型。'
        return (
          '<label>模型</label>' +
          `<select class="lm-field-model" aria-label="节点模型" ${state.modelsLoading ? 'disabled' : ''}>` +
          `<option value="" ${currentValue === '' ? 'selected' : ''}>${esc(inheritLabel)}</option>` +
          pinnedFallback +
          groups +
          '</select>' +
          `<p class="lm-model-hint ${state.models.length === 0 && state.modelsError ? 'is-error' : ''}">${esc(hint)}</p>`
        )
      }

      // ---------------- toast / modal ----------------

      function toast(message: string) {
        if (disposed) return
        toastNode.textContent = message
        toastNode.classList.add('show')
        if (state.toastTimer !== null) clearTimeout(state.toastTimer)
        state.toastTimer = setTimeout(() => {
          toastNode.classList.remove('show')
          state.toastTimer = null
        }, TOAST_MS)
      }

      function openModal(markup: string, onSubmit?: (form: HTMLFormElement) => void | Promise<void>) {
        overlay.innerHTML = `<div class="modal-wrap">${markup}</div>`
        const form = overlay.querySelector<HTMLFormElement>('form')
        if (form && typeof onSubmit === 'function') {
          form.addEventListener('submit', (event) => {
            event.preventDefault()
            onSubmit(form)
          })
        }
        const first = overlay.querySelector<HTMLInputElement>('input:not([type="checkbox"]),textarea')
        if (first) first.focus()
      }

      function closeModal() {
        overlay.innerHTML = ''
        state.editingNodeId = null
        state.loopDraft = null
      }

      // ---------------- views ----------------

      function statusHint() {
        if (state.loading) return '正在加载…'
        if (state.error) return '加载失败'
        return '所有更改已保存'
      }

      function pipelineRow(pipeline: ClientPipeline) {
        const run = lastRunOf(pipeline.id)
        const status = statusOf(pipeline)
        const busy = state.busy === `run:${pipeline.id}`
        const last = run ? relativeDay(run.startedAt) : '尚未运行'
        const duration = run ? durationText((run.finishedAt || Date.now()) - run.startedAt) : ''
        return (
          `<div class="pipeline-row" data-open="${esc(pipeline.id)}" tabindex="0" role="button" aria-label="打开 ${esc(pipeline.name)}">` +
          `<div class="pipeline-name"><div class="pipeline-icon ${esc(pipeline.color)}">${esc(pipeline.icon)}</div><div>` +
          `<div class="name">${esc(pipeline.name)} ${pipeline.star ? '<span class="starred">✧</span>' : ''}</div>` +
          `<div class="description">${esc(pipeline.desc)}</div></div></div>` +
          `<div class="nodecount"><span class="mini-dag">▫─▫─▫</span>${pipeline.nodes.length} 个节点</div>` +
          `<div>${badge(status)}</div>` +
          `<div class="date">${esc(last)}<small>${esc(duration)}</small></div>` +
          '<div class="actions">' +
          `<button class="icon-btn" data-run="${esc(pipeline.id)}" aria-label="运行 ${esc(pipeline.name)}" title="开始任务" ${busy ? 'disabled' : ''}>${busy ? '…' : '▷'}</button>` +
          `<button class="icon-btn" data-menu="${esc(pipeline.id)}" aria-label="更多操作">⋯</button>` +
          '</div></div>'
        )
      }

      function listMarkup() {
        const filtered = state.pipelines
          .filter((pipeline) => state.nav !== 'star' || pipeline.star)
          .filter((pipeline) => state.filter === 'all' || statusOf(pipeline) === state.filter)
          .filter((pipeline) => `${pipeline.name}${pipeline.desc}`.toLowerCase().includes(state.query.toLowerCase()))
        if (state.sort === 'name') filtered.sort((left, right) => left.name.localeCompare(right.name, 'zh'))
        const runningCount = state.pipelines.filter((pipeline) => statusOf(pipeline) === 'running').length
        const successCount = state.pipelines.filter((pipeline) => statusOf(pipeline) === 'success').length
        const draftCount = state.pipelines.filter((pipeline) => statusOf(pipeline) === 'draft').length
        const _errorCount = state.pipelines.filter((pipeline) => statusOf(pipeline) === 'error').length
        const nodeCount = state.pipelines.reduce((sum, pipeline) => sum + pipeline.nodes.length, 0)
        const total = state.pipelines.length.toString().padStart(2, '0')
        return (
          '<div class="heading"><div><div class="eyebrow">YOUR AGENTS, IN FLOW</div>' +
          `<h1>${state.nav === 'star' ? '已收藏' : 'Agent Pipeline'}</h1>` +
          '<p class="subtitle">将想法连接成工作流，让 Agent 为你推进每一步。</p></div>' +
          '<button class="primary" data-action="create">＋ &nbsp;新建 Loop</button></div>' +
          (state.nav === 'star' ? '' : heroMarkup()) +
          '<div class="metrics">' +
          `<div class="metric"><div class="metric-label">全部 Pipelines <span>▦</span></div><div class="metric-value">${total}<small>条工作流</small></div></div>` +
          `<div class="metric"><div class="metric-label">正在运行 <span>◉</span></div><div class="metric-value">${String(runningCount).padStart(2, '0')}<small>任务进行中</small></div></div>` +
          `<div class="metric"><div class="metric-label">最近运行成功 <span>✓</span></div><div class="metric-value">${String(successCount).padStart(2, '0')}<small>条 Pipeline</small></div></div>` +
          `<div class="metric"><div class="metric-label">已编排节点 <span>⌘</span></div><div class="metric-value">${nodeCount}<small>个 Agent 任务</small></div></div>` +
          '</div>' +
          '<div class="toolbar"><div class="tabs">' +
          [
            ['all', '全部', state.pipelines.length],
            ['running', '运行中', runningCount],
            ['draft', '草稿', draftCount],
          ]
            .map(
              ([id, label, value]) =>
                `<button class="tab ${state.filter === id ? 'active' : ''}" data-filter="${id}">${label} <span>${value}</span></button>`,
            )
            .join('') +
          '</div><div class="filters">' +
          `<label class="search">⌕ <input class="lm-search" placeholder="搜索 Pipeline…" value="${esc(state.query)}" aria-label="搜索 Pipeline"></label>` +
          `<select class="lm-sort" aria-label="排序"><option value="recent">默认排序</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>名称排序</option></select>` +
          '</div></div>' +
          '<div class="table"><div class="table-head"><span>PIPELINE 名称</span><span class="nodecount">节点</span><span>状态</span><span class="date">最近运行</span><span>操作</span></div>' +
          (filtered.map(pipelineRow).join('') ||
            `<div class="empty">${state.loading ? '正在加载…' : state.nav === 'star' ? '还没有收藏的 Pipeline。在列表的更多操作里点「收藏」。' : state.error ? `加载失败：${esc(state.error)}` : '没有匹配的 Pipeline。创建一个，让你的工作流开始运转。'}</div>`) +
          '</div>' +
          `<div class="footer"><span>共 ${filtered.length} 条 Pipeline</span><span>每一个节点，都是向前的一步</span></div>` +
          '<div class="bottom-note">⌘ &nbsp; 节点连接为有向无环图 · 任务按照依赖顺序执行</div>'
        )
      }

      // ---------------- v9 Loop list (CONTRACT §13.7) ----------------

      /** Display label of one gate's loop mode. */
      function loopModeLabel(gate: ClientGate) {
        return gate.autoLoop === true ? `自动循环 · 上限 ${gate.maxIterations} 次` : '手动循环'
      }

      /** One decision pill for the gate card / log (`TRUE` / `FALSE` / 等待判定). */
      function decisionBadge(decision: string | undefined, gateStatus: string | undefined) {
        if (decision === 'TRUE') return '<span class="badge success">TRUE 通过</span>'
        if (decision === 'FALSE') return '<span class="badge error">FALSE 未通过</span>'
        if (decision === 'UNKNOWN') return '<span class="badge error">结论未知</span>'
        if (gateStatus === 'running') return '<span class="badge running">判定中</span>'
        return '<span class="badge draft">等待判定</span>'
      }

      /** Newest run summary of one loop: status / "最近运行" text / duration. */
      function loopRunSummary(loop: ClientLoop) {
        const run = lastLoopRunOf(loop.id)
        if (run === null) return { status: 'draft', last: '尚未运行', duration: '' }
        return {
          status: run.status,
          last: relativeDay(run.startedAt),
          duration: run.finishedAt
            ? durationText(run.finishedAt - run.startedAt)
            : durationText(Date.now() - run.startedAt),
        }
      }

      function loopRow(loop: ClientLoop) {
        const summary = loopRunSummary(loop)
        const running = runningLoopRunOf(loop.id) !== null
        const names = loop.steps
          .map((step) => {
            const pipeline = pipelineById(step.pipelineId)
            return pipeline === undefined ? '已删除的 Pipeline' : pipeline.name
          })
          .join(' → ')
        return (
          `<div class="pipeline-row lm-loop-row" data-open-loop="${esc(loop.id)}" tabindex="0" role="button" aria-label="打开 ${esc(loop.name)}">` +
          `<div class="pipeline-name"><div class="pipeline-icon ${esc(loop.color)}">${esc(loop.icon)}</div><div>` +
          `<div class="name">${esc(loop.name)} ${loop.star ? '<span class="starred">✧</span>' : ''}</div>` +
          `<div class="description">${esc(loop.desc)}</div></div></div>` +
          `<div class="lm-loop-flowcell"><b>${loop.steps.length} 组 Pipeline + 门禁</b><span>${esc(names)}</span></div>` +
          `<div>${loopBadge(summary.status)}</div>` +
          `<div class="date">${esc(summary.last)}<small>${esc(summary.duration)}</small></div>` +
          '<div class="actions">' +
          `<button class="icon-btn" data-loop-run="${esc(loop.id)}" aria-label="开始 ${esc(loop.name)}" title="开始任务" ${running ? 'disabled' : ''}>▷</button>` +
          `<button class="icon-btn" data-loop-menu="${esc(loop.id)}" aria-label="更多操作">⋯</button>` +
          '</div></div>'
        )
      }

      function loopListMarkup() {
        const runningCount = state.loops.filter((loop) => runningLoopRunOf(loop.id) !== null).length
        const awaitingCount = state.loops.filter((loop) => lastLoopRunStatus(loop.id) === 'awaiting').length
        const stepCount = state.loops.reduce((sum, loop) => sum + loop.steps.length, 0)
        const total = String(state.loops.length).padStart(2, '0')
        const rows = state.loops.map(loopRow).join('')
        return (
          '<div class="heading"><div><div class="eyebrow">PIPELINE → GATE, UNTIL IT PASSES</div>' +
          '<h1>Loop</h1>' +
          '<p class="subtitle">Pipeline 与门禁节点成对循环，直到门禁通过。</p></div>' +
          '<button class="primary" data-action="create-loop">＋ &nbsp;新建 Loop</button></div>' +
          '<div class="metrics">' +
          `<div class="metric"><div class="metric-label">Loop 总数 <span>⟳</span></div><div class="metric-value">${total}<small>个循环</small></div></div>` +
          `<div class="metric"><div class="metric-label">运行中 <span>◉</span></div><div class="metric-value">${String(runningCount).padStart(2, '0')}<small>个 Loop</small></div></div>` +
          `<div class="metric"><div class="metric-label">等待人工 <span>⏸</span></div><div class="metric-value">${String(awaitingCount).padStart(2, '0')}<small>个门禁待确认</small></div></div>` +
          `<div class="metric"><div class="metric-label">已编排 Pipeline 组数 <span>⌘</span></div><div class="metric-value">${stepCount}<small>组 Pipeline + 门禁</small></div></div>` +
          '</div>' +
          '<div class="table"><div class="table-head"><span>LOOP 名称</span><span>流程</span><span>状态</span><span class="date">最近运行</span><span>操作</span></div>' +
          (rows ||
            `<div class="empty">${state.loading ? '正在加载…' : state.error ? `加载失败：${esc(state.error)}` : '还没有 Loop。新建一个，把 Pipeline 和门禁串成循环。'}</div>`) +
          '</div>' +
          `<div class="footer"><span>共 ${state.loops.length} 个 Loop</span><span>门禁通过，才进入下一组</span></div>` +
          '<div class="bottom-note">⌘ &nbsp; 每组 = 一条 Agent Pipeline + 一个门禁节点 · 门禁 TRUE 前进，FALSE 重新循环</div>'
        )
      }

      /**
       * The run log: one block per node with its folded thinking process and the
       * final answer shown in full. This mirrors the chat transcript, where
       * reasoning is collapsed and only the final result stays open.
       * @returns {string} log body markup ('' before the first run).
       */
      function logMarkup(pipeline: ClientPipeline, run: ClientRun | null) {
        if (run === null) return ''
        const header = `[真实执行 · standard mode] ${relativeDay(run.startedAt)} 开始 · ${run.order.length} 个节点`
        const blocks = run.order
          .map((id) => {
            const nodeState = (run.nodeStates || {})[id] || {}
            const node = pipeline.nodes.find((candidate) => candidate.id === id)
            const name = node ? node.name : id
            const modelLabel = node ? modelLabelOf(node.model) : ''
            const modelSuffix = modelLabel === '' ? '' : ` · ${modelLabel}`
            const duration = durationText((nodeState.finishedAt || 0) - (nodeState.startedAt || 0))
            let head = ''
            let modifier = ''
            if (nodeState.status === 'completed') {
              head = `✓ 完成：${name}${duration === '' ? '' : `（${duration}）`}${modelSuffix}`
              modifier = 'is-ok'
            } else if (nodeState.status === 'running') {
              head = `→ 正在执行：${name}${modelSuffix}`
              modifier = 'is-live'
            } else if (nodeState.status === 'failed') {
              head = `✗ 失败：${name}${modelSuffix} — ${nodeState.error || '未知错误'}`
              modifier = 'is-error'
            } else if (nodeState.status === 'skipped') {
              head = `· 跳过：${name}${nodeState.error ? ` — ${nodeState.error}` : ''}`
            } else {
              head = `· 等待：${name}`
            }

            let body = ''
            const thinking = typeof nodeState.thinking === 'string' ? nodeState.thinking : ''
            if (thinking.trim() !== '') {
              // The panel re-renders on every /state poll. Remember which thinking
              // blocks the user expanded so a poll never collapses them again.
              const thinkKey = `${run.id}:${id}`
              const thinkOpen = state.openThinking.has(thinkKey)
              body +=
                `<details class="lm-think" data-think-key="${esc(thinkKey)}"${thinkOpen ? ' open' : ''}><summary>` +
                `<span>思考 · ${thinking.length} 字</span>` +
                `</summary><div class="lm-think-body">${esc(thinking)}</div></details>`
            }
            const output = typeof nodeState.output === 'string' ? nodeState.output : ''
            if (output !== '') {
              const outputLabel = nodeState.status === 'running' ? '实时输出' : '最终结果'
              body +=
                `<div class="lm-log-output"><span class="lm-log-output-label">${outputLabel}</span>` +
                `<div class="lm-log-output-text">${esc(output)}</div></div>`
            } else if (nodeState.status === 'completed') {
              body +=
                '<div class="lm-log-output"><span class="lm-log-output-label">最终结果</span>' +
                '<div class="lm-log-output-text is-empty">（模型没有返回文本输出）</div></div>'
            }
            return `<div class="lm-log-node"><div class="lm-log-head ${modifier}">${esc(head)}</div>${body}</div>`
          })
          .join('')

        let footer = ''
        if (run.status === 'completed') footer = '✓ 所有节点已按依赖顺序完成。'
        else if (run.status === 'failed') footer = `✗ 运行失败：${run.error || '未知错误'}`
        else if (run.status === 'stopped') footer = '■ 运行已停止。'
        return (
          `<div class="lm-log-line">${esc(header)}</div>${blocks}` +
          (footer === '' ? '' : `<div class="lm-log-line lm-log-live">${esc(footer)}</div>`)
        )
      }

      function graphMarkup(pipeline: ClientPipeline, canvas: ClientCanvas) {
        const { position, width, height } = canvas
        const run = runningRunOf(pipeline.id) || lastRunOf(pipeline.id)
        const nodeStates = (run && run.nodeStates) || {}
        const edges = pipeline.edges
          .map(([from, to]) => {
            const start = position[from]
            const end = position[to]
            if (!start || !end) return ''
            const x1 = start.x + 180
            const y1 = start.y + 42
            const x2 = end.x
            const y2 = end.y + 42
            return `<path d="M ${x1} ${y1} C ${x1 + 28} ${y1},${x2 - 28} ${y2},${x2} ${y2}" fill="none" stroke="#a3b898" stroke-width="1.5" marker-end="url(#lm-arrow)"/>`
          })
          .join('')
        const nodes = pipeline.nodes
          .map((node) => {
            const point = position[node.id] || { x: 35, y: 90 }
            const nodeState = nodeStates[node.id]
            const status = nodeState ? nodeState.status : ''
            const modifier =
              status === 'running'
                ? 'is-running'
                : status === 'failed'
                  ? 'is-failed'
                  : status === 'completed'
                    ? 'is-done'
                    : ''
            // A SKILL node pins one installed skill; an AGENT node's command is
            // the whole instruction (and may name a skill inside the text).
            const sub = node.type === 'skill' ? `Skill: ${esc(node.skill)}` : 'Agent 指令'
            const modelLabel = modelLabelOf(node.model)
            const modelLine =
              modelLabel === ''
                ? ''
                : `<p class="lm-node-model" title="${esc(node.model!.provider + ' / ' + node.model!.model)}">模型 · ${esc(modelLabel)}</p>`
            return (
              `<button class="graph-node ${modifier}" data-node="${esc(node.id)}" style="left:${point.x}px;top:${point.y}px">` +
              `<strong>✧ &nbsp;${esc(node.name)}</strong><p>${sub}</p>${modelLine}` +
              `${status === '' ? '' : nodeBadge(status)}` +
              '</button>'
            )
          })
          .join('')
        return (
          `<div class="canvas"><div class="graph" style="width:${width}px;height:${height}px">` +
          '<svg><defs><marker id="lm-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="#95ad89"/></marker></defs>' +
          `${edges}</svg>${nodes}` +
          `${pipeline.nodes.length === 0 ? '<div class="empty">添加第一个节点，开始构建工作流</div>' : ''}` +
          '</div></div>'
        )
      }

      function edgePanel(pipeline: ClientPipeline, running: boolean) {
        const options = pipeline.nodes
          .map((node) => `<option value="${esc(node.id)}">${esc(node.name)}</option>`)
          .join('')
        const edges = pipeline.edges
          .map(([from, to], index) => {
            const fromNode = pipeline.nodes.find((node) => node.id === from)
            const toNode = pipeline.nodes.find((node) => node.id === to)
            return (
              `<div class="edge"><span>${esc(fromNode ? fromNode.name : from)} → ${esc(toNode ? toNode.name : to)}</span>` +
              `<button class="icon-btn" data-delete-edge="${index}" aria-label="删除连接" ${running ? 'disabled' : ''}>×</button></div>`
            )
          })
          .join('')
        return (
          '<section class="panel"><h3>节点连接</h3><p>建立任务之间的依赖关系。支持分支与汇合，自动阻止循环依赖。</p>' +
          `<select class="lm-edge-from" aria-label="起始节点" ${running ? 'disabled' : ''}><option value="">选择起始节点</option>${options}</select>` +
          `<select class="lm-edge-to" aria-label="目标节点" ${running ? 'disabled' : ''}><option value="">选择目标节点</option>${options}</select>` +
          `<button class="wide" data-action="add-edge" ${running ? 'disabled' : ''}>＋ 添加连接</button>` +
          `<div style="margin:18px 0">${edges || '<p>还没有连接</p>'}</div>` +
          '<h3>执行方式</h3><p>从入度为 0 的节点开始，按照拓扑顺序执行。汇合节点等待所有上游完成。</p>' +
          '<p>每个节点都会启动一次真实的 Agent 会话（DeepSeek Harness · standard mode），可单独选择模型；节点命令里可以正常使用 Skill 与 MCP 工具，上游输出通过 {{input}} 传入下游。</p></section>'
        )
      }

      function editorMarkup(pipeline: ClientPipeline) {
        const running = runningRunOf(pipeline.id) !== null
        const run = runningRunOf(pipeline.id) || lastRunOf(pipeline.id)
        const canvas = layout(pipeline.nodes, pipeline.edges)
        const logs = logMarkup(pipeline, run)
        return (
          '<div class="editor-bar">' +
          '<button data-action="back" aria-label="返回">←</button>' +
          `<h1>${esc(pipeline.name)}</h1>` +
          `<button data-action="edit-pipeline" ${running ? 'disabled' : ''}>编辑信息</button>` +
          `<button data-action="add-node" ${running ? 'disabled' : ''}>＋ 添加节点</button>` +
          (running
            ? `<button class="lm-stop" data-stop="${esc(runningRunOf(pipeline.id)!.id)}">■ 停止任务</button>`
            : `<button class="primary" data-run="${esc(pipeline.id)}">▷ 开始任务</button>`) +
          '</div>' +
          `<p class="subtitle" style="margin-bottom:24px">${esc(pipeline.desc)} · ${pipeline.nodes.length} 个节点 · 点击节点编辑命令</p>` +
          '<div class="detail-grid"><div>' +
          graphMarkup(pipeline, canvas) +
          `<div class="logs"><b>◉ 执行日志<span class="lm-mode">${running ? '运行中' : '真实执行'}</span></b>` +
          (logs !== '' ? logs : '等待开始任务。运行时，所有前置节点完成后才会执行下一个节点。') +
          '</div></div>' +
          edgePanel(pipeline, running) +
          '</div>'
        )
      }

      // ---------------- v9 Loop detail (CONTRACT §13.7) ----------------

      /** Pipeline status pill value of one step state. */
      function stepPipelineStatus(stepState: ClientStepState) {
        if (typeof stepState.pipelineStatus === 'string' && stepState.pipelineStatus !== '')
          return stepState.pipelineStatus
        if (stepState.status === 'running') return 'running'
        if (stepState.status === 'completed') return 'completed'
        if (stepState.status === 'failed') return 'failed'
        if (stepState.status === 'skipped') return 'skipped'
        return ''
      }

      /** One group: pipeline card → gate card, with the manual-retry button. */
      function loopStageMarkup(loop: ClientLoop, step: ClientStep, index: number, run: ClientLoopRun | null) {
        const pipeline = pipelineById(step.pipelineId)
        const stepState = stepStateOf(run, step.id)
        const iteration = typeof stepState.iteration === 'number' ? stepState.iteration : 0
        const pipelineStatus = stepPipelineStatus(stepState)
        const gate = step.gate
        const gateStatus = typeof stepState.gateStatus === 'string' ? stepState.gateStatus : 'pending'
        const retry = needsManualRetry(loop, run, step)
        const pipelineClass =
          'lm-loop-pipeline' +
          (pipeline === undefined ? ' is-missing' : '') +
          (pipelineStatus === 'running' ? ' is-running' : '')
        const gateClass =
          'lm-loop-gate' +
          (gateStatus === 'awaiting' ? ' is-awaiting' : '') +
          (gateStatus === 'failed' ? ' is-failed' : '') +
          (gateStatus === 'passed' ? ' is-passed' : '')
        return (
          `<section class="lm-loop-stage" data-loop-step="${esc(step.id)}">` +
          `<div class="${pipelineClass}">` +
          '<div class="lm-loop-card-head"><span class="lm-loop-kind">PIPELINE</span>' +
          `${pipelineStatus === '' ? '' : loopBadge(pipelineStatus)}</div>` +
          `<strong class="lm-loop-card-title">${pipeline === undefined ? 'Pipeline 已删除' : esc(pipeline.name)}</strong>` +
          `<p class="lm-loop-card-meta">${pipeline === undefined ? '该步骤引用的 Pipeline 不存在，请编辑 Loop' : `${pipeline.nodes.length} 个节点`}</p>` +
          `<div class="lm-loop-card-foot"><span>第 ${iteration} 次执行</span></div>` +
          '</div>' +
          '<div class="lm-loop-arrow">→<span class="lm-loop-arrow-label">TRUE 通过</span></div>' +
          `<div class="${gateClass}">` +
          '<div class="lm-loop-card-head"><span class="lm-loop-kind">GATE</span>' +
          `${decisionBadge(stepState.decision, gateStatus)}</div>` +
          `<strong class="lm-loop-card-title">${esc(gate.name)}</strong>` +
          `<p class="lm-loop-card-meta">${gate.type === 'skill' ? `Skill: ${esc(gate.skill)}` : 'Agent 指令'} · ${esc(loopModeLabel(gate))}</p>` +
          (gate.model === null ? '' : `<p class="lm-loop-card-meta">模型 · ${esc(modelLabelOf(gate.model))}</p>`) +
          (typeof stepState.gateError === 'string' && stepState.gateError !== ''
            ? `<p class="lm-loop-error">${esc(stepState.gateError)}</p>`
            : '') +
          (retry ? `<button class="lm-loop-retry" data-loop-retry="${esc(step.id)}">↻ 重新循环</button>` : '') +
          '</div></section>'
        )
      }

      /** The vertical pipeline → gate flow of one Loop. */
      function loopFlowMarkup(loop: ClientLoop, run: ClientLoopRun | null) {
        if (loop.steps.length === 0) {
          return '<div class="lm-loop-empty">这个 Loop 还没有步骤。编辑它，添加至少一组 Pipeline + 门禁。</div>'
        }
        const stages = loop.steps
          .map((step, index) => {
            const stage = loopStageMarkup(loop, step, index, run)
            if (index === loop.steps.length - 1) return stage
            return stage + '<div class="lm-loop-link">↓ 下一组</div>'
          })
          .join('')
        return `<div class="lm-loop-flow">${stages}<div class="lm-loop-finish">全部通过即完成</div></div>`
      }

      /** The dark log panel: every group's pipeline log + gate decision/output. */
      function loopLogMarkup(loop: ClientLoop, run: ClientLoopRun | null) {
        if (run === null) return ''
        const header = `[Loop 真实执行] ${relativeDay(run.startedAt)} 开始 · ${loop.steps.length} 组 Pipeline + 门禁`
        const blocks = loop.steps
          .map((step, index) => {
            const stepState = stepStateOf(run, step.id)
            const pipeline = pipelineById(step.pipelineId)
            const pipelineRun = pipelineRunOfStep(run, stepState)
            let pipelineBody
            if (pipeline !== undefined && pipelineRun !== null) pipelineBody = logMarkup(pipeline, pipelineRun)
            else if ((stepState.iteration || 0) > 0)
              pipelineBody = '<div class="lm-log-line">· 等待本次 Pipeline 运行记录…</div>'
            else pipelineBody = '<div class="lm-log-line">· 尚未执行</div>'
            const pipelineTitle = pipeline === undefined ? `Pipeline（已删除）` : `Pipeline「${esc(pipeline.name)}」`
            const pipelineSegment = `<div class="lm-loop-log-step"><div class="lm-loop-log-title">第 ${index + 1} 组 · ${pipelineTitle}</div>${pipelineBody}</div>`

            const gate = step.gate
            const gateDecision = stepState.decision
            const gateTone =
              gateDecision === 'TRUE'
                ? 'is-ok'
                : gateDecision === 'FALSE' || gateDecision === 'UNKNOWN' || stepState.gateStatus === 'failed'
                  ? 'is-error'
                  : ''
            const gateHead =
              gateDecision === 'TRUE'
                ? '✓ 门禁通过 · TRUE'
                : gateDecision === 'FALSE'
                  ? '✗ 门禁未通过 · FALSE'
                  : gateDecision === 'UNKNOWN'
                    ? '? 门禁结论未知（UNKNOWN）'
                    : stepState.gateStatus === 'running'
                      ? '→ 门禁判定中'
                      : stepState.gateStatus === 'awaiting'
                        ? '· 门禁等待人工重新循环'
                        : '· 等待门禁判定'
            let gateBody = `<div class="lm-loop-log-sub">${esc(`${gate.type === 'skill' ? 'Skill: ' + gate.skill : 'Agent 指令'} · ${loopModeLabel(gate)}`)}</div>`
            gateBody += `<div class="lm-log-head ${gateTone}">${esc(gateHead)}</div>`
            const thinking = typeof stepState.gateThinking === 'string' ? stepState.gateThinking : ''
            if (thinking.trim() !== '') {
              // Same fold/scroll-keeping contract as the pipeline node log (§7).
              const thinkKey = `${run.id}:${step.id}:gate`
              const thinkOpen = state.openThinking.has(thinkKey)
              gateBody +=
                `<details class="lm-think" data-think-key="${esc(thinkKey)}"${thinkOpen ? ' open' : ''}><summary>` +
                `<span>思考 · ${thinking.length} 字</span>` +
                `</summary><div class="lm-think-body">${esc(thinking)}</div></details>`
            }
            const gateOutput = typeof stepState.gateOutput === 'string' ? stepState.gateOutput : ''
            if (gateOutput !== '') {
              gateBody +=
                '<div class="lm-log-output"><span class="lm-log-output-label">门禁输出</span>' +
                `<div class="lm-log-output-text">${esc(gateOutput)}</div></div>`
            }
            if (typeof stepState.gateError === 'string' && stepState.gateError !== '') {
              gateBody += `<div class="lm-log-head is-error">${esc(`✗ ${stepState.gateError}`)}</div>`
            }
            if (typeof stepState.error === 'string' && stepState.error !== '') {
              gateBody += `<div class="lm-log-head is-error">${esc(`✗ ${stepState.error}`)}</div>`
            }
            const gateSegment =
              `<div class="lm-loop-log-step"><div class="lm-loop-log-title">第 ${index + 1} 组 · 门禁「${esc(gate.name)}」` +
              `${gateDecision === undefined ? '' : ` ${decisionBadge(gateDecision, stepState.gateStatus)}`}</div>${gateBody}</div>`
            return pipelineSegment + gateSegment
          })
          .join('')
        let footer = ''
        if (run.status === 'completed') footer = '✓ 所有组的门禁均已通过，Loop 运行完成。'
        else if (run.status === 'failed') footer = `✗ Loop 运行失败：${run.error || '未知错误'}`
        else if (run.status === 'stopped') footer = '■ Loop 运行已停止。'
        else if (run.status === 'awaiting') {
          const currentId = currentStepIdOf(loop, run)
          const currentState = currentId === null ? {} : stepStateOf(run, currentId)
          footer = `⏸ 等待人工重新循环：${currentState.gateError || currentState.error || '门禁未通过，点击门禁卡上的「重新循环」继续'}`
        }
        return (
          `<div class="lm-log-line">${esc(header)}</div>${blocks}` +
          (footer === '' ? '' : `<div class="lm-log-line lm-log-live">${esc(footer)}</div>`)
        )
      }

      /** Right-hand panel explaining the loop semantics. */
      function loopRulesPanel() {
        return (
          '<section class="panel"><h3>循环规则</h3><ul class="lm-loop-rules">' +
          '<li><b>每组</b>先运行一条 Agent Pipeline，再由紧随其后的门禁节点判断结果。</li>' +
          '<li>门禁判定 <b>TRUE</b>：进入下一组；最后一组通过即整个 Loop 完成。</li>' +
          '<li>门禁判定 <b>FALSE</b>：自动循环的组会重跑本组 Pipeline（到上限为止），手动循环的组会停在等待人工。</li>' +
          '<li>等待人工时，门禁卡上出现「↻ 重新循环」，确认后从该组继续执行。</li>' +
          '</ul>' +
          '<p>引用关系是活链接：修改被引用的 Pipeline 会立即影响下一次 Loop 运行；删除 Loop 不会删除 Pipeline。</p></section>'
        )
      }

      function loopEditorMarkup(loop: ClientLoop) {
        const run = lastLoopRunOf(loop.id)
        const running = runningLoopRunOf(loop.id)
        const logs = loopLogMarkup(loop, run)
        return (
          '<div class="editor-bar">' +
          '<button data-action="loop-back" aria-label="返回">←</button>' +
          `<h1>${esc(loop.name)}</h1>` +
          `<button data-action="edit-loop" ${running ? 'disabled' : ''}>编辑</button>` +
          `<button data-action="edit-loop-add" aria-label="添加一组" title="添加一组 Pipeline + 门禁" ${running ? 'disabled' : ''}>＋</button>` +
          (running
            ? `<button class="lm-stop" data-loop-stop="${esc(running.id)}">■ 停止任务</button>`
            : `<button class="primary" data-loop-run="${esc(loop.id)}">▷ 开始任务</button>`) +
          '</div>' +
          `<p class="subtitle" style="margin-bottom:24px">${esc(loop.desc)} · ${loop.steps.length} 组 Pipeline + 门禁 · 门禁通过才进入下一组</p>` +
          '<div class="detail-grid"><div>' +
          loopFlowMarkup(loop, run) +
          '<div class="logs"><b>◉ Loop 执行日志' +
          `<span class="lm-mode">${running ? '运行中' : run === null ? '真实执行' : esc(LOOP_STATUS_META[run.status] ? LOOP_STATUS_META[run.status].label : run.status)}</span></b>` +
          (logs !== ''
            ? logs
            : '等待开始任务。每组先运行 Pipeline，再由门禁判断是否进入下一组；门禁未通过时按设置自动重跑或等待人工。') +
          '</div></div>' +
          loopRulesPanel() +
          '</div>'
        )
      }

      function historyMarkup() {
        const rows = state.runs
          .map((run) => {
            const status = run.status === 'completed' ? 'success' : run.status === 'running' ? 'running' : 'error'
            const duration = run.finishedAt ? durationText(run.finishedAt - run.startedAt) : '进行中'
            return (
              `<div class="history-row"><strong>${esc(run.pipelineName || run.pipelineId)}</strong>` +
              `<span>${esc(relativeDay(run.startedAt))}</span><span>${esc(duration)}</span>${badge(status)}` +
              '<span class="lm-history-actions">' +
              (run.status === 'running'
                ? `<button class="icon-btn" data-stop="${esc(run.id)}" title="停止" aria-label="停止运行">■</button>`
                : `<button class="icon-btn" data-delete-run="${esc(run.id)}" title="删除记录" aria-label="删除运行记录">×</button>`) +
              '</span></div>'
            )
          })
          .join('')
        return (
          '<div class="heading"><div><div class="eyebrow">EXECUTION HISTORY</div><h1>运行记录</h1>' +
          '<p class="subtitle">每条记录都对应一次真实的 Agent 执行。</p></div></div>' +
          '<div class="table">' +
          (rows || '<div class="empty">暂无运行记录。打开任意 Pipeline，点击「开始任务」。</div>') +
          '</div>'
        )
      }

      function render() {
        if (disposed) return
        count.textContent = String(state.pipelines.length)
        if (loopCount) loopCount.textContent = String(state.loops.length)
        for (const button of navBar.querySelectorAll<HTMLElement>('[data-nav]')) {
          button.classList.toggle('active', button.dataset.nav === state.nav)
        }
        const headerRight = root.querySelector<HTMLElement>('.header-right')
        if (headerRight) {
          headerRight.innerHTML = `<span class="online"></span> ${esc(statusHint())} <span class="demo">EMBER / 01</span>`
        }
        // The panel re-renders on every /state poll. Capture the inner scroll
        // offset of expanded thinking blocks first so reading is not reset to
        // the top each time the markup is rebuilt.
        /** @type {Map<string, number>} */
        const thinkingScroll = new Map<string, number>()
        for (const details of app.querySelectorAll<HTMLElement>('details.lm-think[data-think-key]')) {
          const body = details.querySelector<HTMLElement>('.lm-think-body')
          if (body === null || body.scrollTop <= 0) continue
          const thinkKey = details.dataset.thinkKey
          if (typeof thinkKey === 'string' && thinkKey !== '') thinkingScroll.set(thinkKey, body.scrollTop)
        }
        const selectedPipeline = state.nav === 'loops' || state.selected === null ? null : pipelineById(state.selected)
        const selectedLoop = state.nav === 'loops' && state.selectedLoop !== null ? loopById(state.selectedLoop) : null
        if (state.nav === 'loops') {
          state.selected = null
          if (selectedLoop !== null && selectedLoop !== undefined) {
            crumb.textContent = selectedLoop.name
            app.innerHTML = loopEditorMarkup(selectedLoop)
          } else {
            state.selectedLoop = null
            crumb.textContent = 'Loop'
            app.innerHTML = loopListMarkup()
          }
        } else if (state.nav === 'recent') {
          crumb.textContent = '运行记录'
          app.innerHTML = historyMarkup()
        } else if (selectedPipeline !== null && selectedPipeline !== undefined) {
          crumb.textContent = selectedPipeline.name
          app.innerHTML = editorMarkup(selectedPipeline)
        } else {
          state.selected = null
          crumb.textContent = state.nav === 'star' ? '已收藏' : 'Agent Pipeline'
          app.innerHTML = listMarkup()
        }
        for (const details of app.querySelectorAll<HTMLElement>('details.lm-think[data-think-key]')) {
          const scrollTop = thinkingScroll.get(details.dataset.thinkKey || '')
          if (scrollTop === undefined) continue
          const body = details.querySelector<HTMLElement>('.lm-think-body')
          if (body !== null) body.scrollTop = scrollTop
        }
        // Keep the scroll position across re-renders (poll every 0.7–1.5 s).
        scroll.scrollTop = state.scrollTop
      }

      // ---------------- mutations ----------------

      async function runPipeline(pipelineId: string) {
        const pipeline = pipelineById(pipelineId)
        if (pipeline === undefined) return
        if (pipeline.nodes.length === 0) {
          toast('请先添加节点')
          return
        }
        if (topo(pipeline.nodes, pipeline.edges) === null) {
          toast('图中存在循环依赖')
          return
        }
        state.busy = `run:${pipelineId}`
        render()
        try {
          await api(`/pipelines/${pipelineId}/run`, { method: 'POST' })
          state.nav = 'all'
          state.selected = pipelineId
          await refresh()
          toast('已开始执行')
        } catch (error) {
          toast(errorMessage(error))
        } finally {
          state.busy = null
          render()
        }
      }

      async function stopRun(runId: string) {
        await mutate(() => api(`/runs/${runId}/stop`, { method: 'POST' }), '已停止')
      }

      // ---------------- v9 Loop mutations (CONTRACT §13.6) ----------------

      function patchLoop(id: string, patch: Partial<ClientLoop>) {
        return mutate(() => api(`/loops/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }))
      }

      /** Start one Loop run, then show its detail view. */
      async function runLoop(loopId: string) {
        const loop = loopById(loopId)
        if (loop === undefined) return
        if (loop.steps.length === 0) {
          toast('请先添加 Pipeline 与门禁步骤')
          return
        }
        if (loop.steps.some((step) => pipelineById(step.pipelineId) === undefined)) {
          toast('有步骤引用的 Pipeline 已不存在，请先编辑 Loop')
          return
        }
        state.busy = `loop-run:${loopId}`
        render()
        try {
          await api(`/loops/${loopId}/run`, { method: 'POST' })
          state.nav = 'loops'
          state.selected = null
          state.selectedLoop = loopId
          await refresh()
          toast('已开始运行 Loop')
        } catch (error) {
          toast(errorMessage(error))
        } finally {
          state.busy = null
          render()
        }
      }

      async function stopLoopRun(runId: string) {
        await mutate(() => api(`/loop-runs/${runId}/stop`, { method: 'POST' }), '已停止')
      }

      /** Manual "重新循环": resume a waiting LoopRun from one step (§13.3). */
      async function retryLoopRun(runId: string, stepId: string) {
        await mutate(
          () => api(`/loop-runs/${runId}/retry`, { method: 'POST', body: JSON.stringify({ stepId }) }),
          '已重新开始循环',
        )
      }

      async function removeLoop(loop: ClientLoop) {
        closeModal()
        await mutate(async () => {
          await api(`/loops/${loop.id}`, { method: 'DELETE' })
          if (state.selectedLoop === loop.id) state.selectedLoop = null
        }, '已删除 Loop')
      }

      async function addEdge() {
        const pipeline = pipelineById(state.selected)
        if (pipeline === undefined) return
        const fromSelect = root.querySelector<HTMLSelectElement>('.lm-edge-from')
        const toSelect = root.querySelector<HTMLSelectElement>('.lm-edge-to')
        const from = fromSelect ? fromSelect.value : ''
        const to = toSelect ? toSelect.value : ''
        if (!from || !to) {
          toast('请选择两个节点')
          return
        }
        if (from === to) {
          toast('不能连接到节点自身')
          return
        }
        if (pipeline.edges.some((edge) => edge[0] === from && edge[1] === to)) {
          toast('这条连接已存在')
          return
        }
        const edges = pipeline.edges.concat([[from, to]])
        if (topo(pipeline.nodes, edges) === null) {
          toast('连接被阻止：这会产生循环依赖')
          return
        }
        await savePipeline(Object.assign({}, pipeline, { edges }))
      }

      async function deleteEdge(index: number) {
        const pipeline = pipelineById(state.selected)
        if (pipeline === undefined) return
        const edges = pipeline.edges.slice()
        edges.splice(index, 1)
        await savePipeline(Object.assign({}, pipeline, { edges }))
      }

      // ---------------- modals ----------------

      function openPipelineModal(edit: boolean) {
        const pipeline = edit ? pipelineById(state.selected) : null
        openModal(
          `<form class="modal"><h2>${edit ? '编辑 Pipeline' : '新建 Loop'}</h2><p>将一个目标，拆解为可执行的 Agent 任务。</p>` +
            `<label>名称</label><input class="lm-field-name" required maxlength="50" value="${esc(pipeline ? pipeline.name : '')}" placeholder="例如：每周产品洞察">` +
            `<label>描述</label><input class="lm-field-desc" maxlength="160" value="${esc(pipeline ? pipeline.desc : '')}" placeholder="这个工作流将帮你完成什么？">` +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button><button class="primary" type="submit">保存</button></div></form>',
          async (form) => {
            const name = form.querySelector<HTMLInputElement>('.lm-field-name')!.value.trim()
            const desc = form.querySelector<HTMLInputElement>('.lm-field-desc')!.value.trim()
            if (name === '') {
              toast('请输入名称')
              return
            }
            closeModal()
            if (edit && pipeline) {
              await patchPipeline(pipeline.id, { name, desc })
              toast('已保存')
              return
            }
            try {
              const body = await api('/pipelines', {
                method: 'POST',
                body: JSON.stringify({ name, desc, icon: '◈', color: '', star: false, nodes: [], edges: [] }),
              })
              state.nav = 'all'
              state.selected = body.pipeline.id
              await refresh()
              toast('已创建')
            } catch (error) {
              toast(errorMessage(error))
            }
          },
        )
      }

      // ---------------- v9 Loop editor modal (CONTRACT §13.7) ----------------

      /** A brand-new gate for one step (contract defaults: 门禁 / agent / 手动 / 3). */
      function emptyGateDraft(stepId: string): ClientGate {
        return {
          id: `${stepId}-gate`,
          name: '门禁',
          type: 'agent',
          command: '',
          skill: '',
          model: null,
          autoLoop: false,
          maxIterations: GATE_DEFAULT_MAX_ITERATIONS,
        }
      }

      function newStepDraft(pipelineId: string) {
        const id = newId()
        return { id, pipelineId: pipelineId || '', gate: emptyGateDraft(id) }
      }

      function freshLoopDraft(): ClientLoopDraft {
        const pipelineId = state.pipelines.length === 1 ? state.pipelines[0].id : ''
        return {
          loopId: null,
          name: '',
          desc: '',
          icon: LOOP_ICON,
          color: '',
          star: false,
          steps: [newStepDraft(pipelineId)],
        }
      }

      /** Draft of one existing loop (edited fields are copied, not aliased). */
      function loopDraftFromLoop(loop: ClientLoop): ClientLoopDraft {
        return {
          loopId: loop.id,
          name: loop.name,
          desc: loop.desc,
          icon: loop.icon,
          color: loop.color,
          star: loop.star,
          steps: loop.steps.map((step) => ({
            id: step.id,
            pipelineId: step.pipelineId,
            gate: Object.assign({}, step.gate),
          })),
        }
      }

      /** Read every field of the Loop modal back into a draft. */
      function readLoopForm(form: HTMLFormElement): ClientLoopDraft {
        const fieldValue = (scope: HTMLElement, selector: string) => {
          const field = scope.querySelector<HTMLInputElement>(selector)
          return field === null ? '' : field.value
        }
        const previous = state.loopDraft
        const steps = Array.from(form.querySelectorAll<HTMLElement>('.lm-loop-step')).map((block) => {
          const stepId = block.dataset.stepId || newId()
          const gateId = block.dataset.gateId || `${stepId}-gate`
          const typeField = block.querySelector<HTMLSelectElement>('.lm-field-gate-type')
          const type = typeField !== null && typeField.value === 'skill' ? 'skill' : 'agent'
          const autoField = block.querySelector<HTMLInputElement>('.lm-field-gate-auto')
          const maxField = block.querySelector<HTMLInputElement>('.lm-field-gate-max')
          const rawMax = maxField === null ? GATE_DEFAULT_MAX_ITERATIONS : Number(maxField.value)
          const modelField = block.querySelector<HTMLSelectElement>('.lm-field-model')
          return {
            id: stepId,
            pipelineId: fieldValue(block, '.lm-field-pipeline'),
            gate: {
              id: gateId,
              name: fieldValue(block, '.lm-field-gate-name'),
              type,
              command: fieldValue(block, '.lm-field-gate-command'),
              skill: fieldValue(block, '.lm-field-gate-skill'),
              model: modelField === null ? null : modelFromValue(modelField.value),
              autoLoop: autoField !== null && autoField.checked === true,
              maxIterations:
                Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= GATE_MAX_ITERATIONS
                  ? rawMax
                  : GATE_DEFAULT_MAX_ITERATIONS,
            },
          }
        })
        return {
          loopId: previous === null ? null : previous.loopId,
          name: fieldValue(form, '.lm-field-loop-name'),
          desc: fieldValue(form, '.lm-field-loop-desc'),
          icon: previous === null || !previous.icon ? LOOP_ICON : previous.icon,
          color: previous === null ? '' : previous.color,
          star: previous !== null && previous.star === true,
          steps,
        }
      }

      /** Client-side validation (the server validates again, §13.2). */
      function loopValuesError(draft: ClientLoopDraft) {
        const name = draft.name.trim()
        if (name === '') return '请输入 Loop 名称'
        if (name.length > 50) return 'Loop 名称不能超过 50 个字符'
        if (draft.desc.trim().length > 160) return '描述不能超过 160 个字符'
        if (draft.steps.length === 0) return '至少添加一组 Pipeline + 门禁'
        if (draft.steps.length > LOOP_MAX_STEPS) return `最多 ${LOOP_MAX_STEPS} 组`
        for (let index = 0; index < draft.steps.length; index += 1) {
          const step = draft.steps[index]
          const label = `第 ${index + 1} 组`
          if (step.pipelineId === '') return `${label}：请选择 Pipeline`
          if (pipelineById(step.pipelineId) === undefined) return `${label}：引用的 Pipeline 不存在，请重新选择`
          const gate = step.gate
          const gateName = gate.name.trim()
          if (gateName === '') return `${label}：请输入门禁名称`
          if (gateName.length > 40) return `${label}：门禁名称不能超过 40 个字符`
          if (gate.type === 'skill') {
            if (gate.skill.trim() === '') return `${label}：请选择或填写一个已安装的 Skill`
          } else if (gate.command.trim() === '') {
            return `${label}：请输入门禁的判断要求`
          }
        }
        return null
      }

      /** One step block of the Loop modal. */
      function loopStepMarkup(step: ClientStep, index: number, total: number) {
        const gate = step.gate
        const isSkill = gate.type === 'skill'
        const pipelineOptions =
          `<option value="">选择 Pipeline</option>` +
          state.pipelines
            .map(
              (pipeline) =>
                `<option value="${esc(pipeline.id)}" ${pipeline.id === step.pipelineId ? 'selected' : ''}>${esc(pipeline.name)}（${pipeline.nodes.length} 个节点）</option>`,
            )
            .join('')
        const commandLabel = isSkill ? '补充信息（可选）' : '判断要求'
        const commandPlaceholder = isSkill
          ? '告诉 skill 这次门禁要检查什么、输出什么结论…'
          : '写明门禁通过的标准；模型第一行只输出 TRUE 或 FALSE。'
        const commandHelp = isSkill
          ? '门禁会先加载所选 skill，再把这段补充信息作为判断任务。'
          : '门禁的第一行必须是 TRUE 或 FALSE：TRUE 进入下一组，FALSE 重新循环本组 Pipeline。'
        return (
          `<div class="lm-loop-step" data-step-id="${esc(step.id)}" data-gate-id="${esc(gate.id)}">` +
          '<div class="lm-loop-step-head">' +
          `<span class="lm-loop-step-index">第 ${index + 1} 组</span>` +
          '<div class="lm-loop-step-actions">' +
          `<button type="button" data-loop-step-action="up" data-step-index="${index}" title="上移" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>` +
          `<button type="button" data-loop-step-action="down" data-step-index="${index}" title="下移" aria-label="下移" ${index === total - 1 ? 'disabled' : ''}>↓</button>` +
          `<button type="button" class="danger" data-loop-step-action="remove" data-step-index="${index}" title="删除本组" aria-label="删除本组">×</button>` +
          '</div></div>' +
          '<label>Pipeline</label>' +
          `<select class="lm-field-pipeline" aria-label="第 ${index + 1} 组的 Pipeline" ${state.pipelines.length === 0 ? 'disabled' : ''}>${pipelineOptions}</select>` +
          '<label>门禁名称</label>' +
          `<input class="lm-field-gate-name" maxlength="40" value="${esc(gate.name)}" placeholder="例如：结果合格判定">` +
          '<label>门禁类型</label>' +
          '<div class="lm-seg" role="group" aria-label="门禁类型">' +
          `<button type="button" class="lm-seg-btn${isSkill ? '' : ' active'}" data-loop-step-action="type" data-gate-type="agent" data-step-index="${index}" aria-pressed="${isSkill ? 'false' : 'true'}">Agent 指令</button>` +
          `<button type="button" class="lm-seg-btn${isSkill ? ' active' : ''}" data-loop-step-action="type" data-gate-type="skill" data-step-index="${index}" aria-pressed="${isSkill ? 'true' : 'false'}">Skill</button>` +
          '</div>' +
          `<input type="hidden" class="lm-field-gate-type" value="${isSkill ? 'skill' : 'agent'}">` +
          (isSkill ? skillControlMarkup(gate.skill, 'lm-field-gate-skill') : '') +
          modelControlMarkup(gate.model) +
          `<label>${commandLabel}</label>` +
          `<textarea class="lm-field-gate-command" placeholder="${esc(commandPlaceholder)}">${esc(gate.command)}</textarea>` +
          `<p>${esc(commandHelp)}</p>` +
          '<label class="lm-loop-auto"><span><strong>自动循环</strong>' +
          '<small>门禁判定 FALSE 时自动重跑本组 Pipeline；关闭时停在等待人工。</small></span>' +
          `<span class="lm-switch"><input type="checkbox" class="lm-field-gate-auto" ${gate.autoLoop ? 'checked' : ''}><i></i></span></label>` +
          `<label class="lm-loop-max" ${gate.autoLoop ? '' : 'hidden'}>自动循环上限 <input class="lm-field-gate-max" type="number" min="1" max="${GATE_MAX_ITERATIONS}" step="1" value="${gate.maxIterations}"> 次（1–${GATE_MAX_ITERATIONS}）</label>` +
          '</div>'
        )
      }

      /** Build (and wire) the create/edit Loop modal from one draft. */
      function openLoopModal(draft: ClientLoopDraft) {
        state.loopDraft = draft
        const existing = draft.loopId === null ? null : loopById(draft.loopId)
        const noPipelines = state.pipelines.length === 0
        const stepsMarkup =
          draft.steps.length === 0
            ? '<div class="lm-loop-empty">还没有步骤，点击下面「＋ 添加一组」。</div>'
            : draft.steps.map((step, index) => loopStepMarkup(step, index, draft.steps.length)).join('')
        const pipelineHint = noPipelines
          ? '<p class="lm-loop-hint is-error">还没有 Agent Pipeline：请先到「Agent Pipeline」标签页创建一条 Pipeline，再回来编排 Loop。</p>'
          : ''
        openModal(
          '<form class="modal lm-loop-form">' +
            `<h2>${existing === null ? '新建 Loop' : '编辑 Loop'}</h2>` +
            '<p class="lm-loop-modal-sub">一个 Loop 按顺序执行多组「Pipeline → 门禁」；门禁通过才进入下一组。</p>' +
            `<label>名称</label><input class="lm-field-loop-name" required maxlength="50" value="${esc(draft.name)}" placeholder="例如：周报打磨循环">` +
            `<label>描述</label><input class="lm-field-loop-desc" maxlength="160" value="${esc(draft.desc)}" placeholder="这个 Loop 会反复打磨到什么程度？">` +
            pipelineHint +
            '<label>步骤（按执行顺序）</label>' +
            `<div class="lm-loop-steps">${stepsMarkup}</div>` +
            '<button type="button" class="lm-loop-add" data-action="add-step">＋ 添加一组 Pipeline + 门禁</button>' +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button class="primary" type="submit" ${noPipelines ? 'disabled' : ''}>保存</button></div></form>`,
          async (form) => {
            const values = readLoopForm(form)
            const invalid = loopValuesError(values)
            if (invalid !== null) {
              toast(invalid)
              return
            }
            const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
            if (submit !== null) submit.disabled = true
            try {
              const isNew = values.loopId === null
              const body = isNew
                ? await api('/loops', { method: 'POST', body: JSON.stringify(loopWire(values)) })
                : await api(`/loops/${values.loopId}`, { method: 'PUT', body: JSON.stringify(loopWire(values)) })
              state.nav = 'loops'
              state.selected = null
              state.selectedLoop =
                body.loop !== null && typeof body.loop === 'object' && typeof body.loop.id === 'string'
                  ? body.loop.id
                  : values.loopId
              state.loopDraft = null
              closeModal()
              await refresh()
              toast(isNew ? '已创建 Loop' : '已保存 Loop')
            } catch (error) {
              if (submit !== null) submit.disabled = false
              toast(errorMessage(error))
            }
          },
        )

        const form = overlay.querySelector<HTMLFormElement>('form')
        if (form === null) return

        // One skill picker per Skill-type gate block.
        for (const block of form.querySelectorAll<HTMLElement>('.lm-loop-step'))
          wireSkillPicker(block, 'lm-field-gate-skill')

        // Structural edits re-render the modal from the live form values, so
        // nothing the author typed is lost (same pattern as the node modal).
        for (const button of form.querySelectorAll<HTMLElement>('[data-loop-step-action]')) {
          button.addEventListener('click', () => {
            const index = Number(button.dataset.stepIndex)
            const values = readLoopForm(form)
            const step = values.steps[index]
            if (step === undefined) return
            const action = button.dataset.loopStepAction
            if (action === 'remove') {
              values.steps.splice(index, 1)
            } else if (action === 'up' && index > 0) {
              const previous = values.steps[index - 1]
              values.steps[index - 1] = values.steps[index]
              values.steps[index] = previous
            } else if (action === 'down' && index < values.steps.length - 1) {
              const next = values.steps[index + 1]
              values.steps[index + 1] = values.steps[index]
              values.steps[index] = next
            } else if (action === 'type') {
              const nextType = button.dataset.gateType === 'skill' ? 'skill' : 'agent'
              if (step.gate.type === nextType) return
              step.gate.type = nextType
              if (nextType === 'skill' && state.skills.length === 0 && !state.skillsLoading) {
                void loadSkills().then(() => openLoopModal(values))
                return
              }
            } else return
            openLoopModal(values)
          })
        }

        const addButton = form.querySelector<HTMLElement>('[data-action="add-step"]')
        if (addButton !== null) {
          addButton.addEventListener('click', () => {
            const values = readLoopForm(form)
            if (values.steps.length >= LOOP_MAX_STEPS) {
              toast(`最多 ${LOOP_MAX_STEPS} 组`)
              return
            }
            values.steps.push(newStepDraft(state.pipelines.length === 1 ? state.pipelines[0].id : ''))
            openLoopModal(values)
          })
        }

        // The skill selector falls back to a text input while the catalog is
        // still loading; re-render once it arrives (keeping the draft).
        if (state.skillsAt === 0 && draft.steps.some((step) => step.gate.type === 'skill')) {
          const skillForm = form
          void loadSkills().then(() => {
            if (disposed || state.skills.length === 0) return
            if (overlay.querySelector<HTMLFormElement>('form') !== skillForm) return
            openLoopModal(readLoopForm(skillForm))
          })
        }

        // The model catalog is shared with the chat composer: if it was not
        // loaded yet, re-render the modal once it arrives (keeping the draft).
        if (state.modelsAt === 0) {
          const modalForm = form
          void loadModels().then(() => {
            if (disposed || state.models.length === 0) return
            if (overlay.querySelector<HTMLFormElement>('form') !== modalForm) return
            openLoopModal(readLoopForm(modalForm))
          })
        }
      }

      /** Open the Loop modal: edit the selected loop, or a new one. */
      function openLoopEditor(edit: boolean, addStep: boolean) {
        if (edit) {
          const loop = loopById(state.selectedLoop)
          if (loop === undefined) return
          const draft = loopDraftFromLoop(loop)
          if (addStep === true && draft.steps.length < LOOP_MAX_STEPS) {
            draft.steps.push(newStepDraft(state.pipelines.length === 1 ? state.pipelines[0].id : ''))
          }
          openLoopModal(draft)
          return
        }
        openLoopModal(freshLoopDraft())
      }

      /** Read the current node form values (used when the type switches). */
      function readNodeForm(form: HTMLFormElement): ClientNodeDraft {
        const typeField = form.querySelector<HTMLInputElement>('.lm-field-type')
        const skillField = form.querySelector<HTMLInputElement>('.lm-field-skill')
        const modelField = form.querySelector<HTMLSelectElement>('.lm-field-model')
        const activeType = form.querySelector<HTMLElement>('.lm-seg-btn.active')
        return {
          type: typeField ? typeField.value : activeType ? activeType.dataset.nodeType || 'agent' : 'agent',
          name: form.querySelector<HTMLInputElement>('.lm-field-name')
            ? form.querySelector<HTMLInputElement>('.lm-field-name')!.value
            : '',
          command: form.querySelector<HTMLTextAreaElement>('.lm-field-command')
            ? form.querySelector<HTMLTextAreaElement>('.lm-field-command')!.value
            : '',
          skill: skillField ? skillField.value : '',
          model: modelField ? modelFromValue(modelField.value) : null,
        }
      }

      /**
       * The installed-skill control shared by the node modal and the Loop gate
       * editor: a two-line trigger plus a searchable menu when the catalog is
       * available, and a plain text input when it is not (so the editor never
       * becomes unusable).
       * @param {string} currentSkill - selected kebab-case skill name.
       * @param {string} hiddenClass - class of the hidden/text input that carries the value.
       * @returns {string} form markup.
       */
      function skillControlMarkup(currentSkill: string | undefined, hiddenClass: string) {
        if (state.skills.length === 0) {
          const hint = state.skillsLoading
            ? '正在读取已安装 skill…'
            : state.skillsError
              ? `未读取到已安装 skill（${state.skillsError}），可直接填写名称`
              : '未发现已安装 skill，可直接填写名称'
          return (
            '<label>Skill 名称</label>' +
            `<input class="${hiddenClass}" value="${esc(currentSkill)}" placeholder="例如：office-docx" aria-label="Skill 名称">` +
            `<p>${esc(hint)}</p>`
          )
        }
        const selected = state.skills.find((entry) => entry.name === currentSkill)
        const options = state.skills
          .map((entry) => {
            const active = entry.name === currentSkill
            return (
              `<button type="button" class="lm-picker-option${active ? ' is-active' : ''}" data-skill-pick="${esc(entry.name)}" role="option" aria-selected="${active ? 'true' : 'false'}">` +
              `<strong>${esc(entry.name)}</strong>` +
              `<span>${esc(entry.description || '（无描述）')}</span></button>`
            )
          })
          .join('')
        return (
          '<label>选择 Skill</label>' +
          '<div class="lm-picker" data-skill-picker>' +
          '<button type="button" class="lm-picker-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="选择已安装的 Skill">' +
          '<span class="lm-picker-text">' +
          `<strong class="lm-picker-name">${currentSkill === '' ? '选择已安装的 Skill' : esc(currentSkill)}</strong>` +
          `<span class="lm-picker-desc">${esc(selected && selected.description ? selected.description : state.skillsLoading ? '正在读取已安装 skill…' : '共 ' + state.skills.length + ' 个已安装 skill，可搜索')}</span>` +
          '</span><span class="lm-picker-caret" aria-hidden="true">▾</span></button>' +
          '<div class="lm-picker-menu" hidden>' +
          '<div class="lm-picker-search"><input class="lm-picker-filter" placeholder="搜索 skill 名称或描述…" aria-label="搜索 skill"></div>' +
          `<div class="lm-picker-list" role="listbox" aria-label="已安装的 Skill">${options}</div>` +
          '<p class="lm-picker-empty" hidden>没有匹配的 skill，换个关键词试试。</p>' +
          '</div></div>' +
          `<input type="hidden" class="${hiddenClass}" value="${esc(currentSkill)}">`
        )
      }

      /**
       * Wire one skill picker (trigger, menu, optimistic live filter, keyboard
       * cursor) inside `scope`. Values are written into `hiddenClass`.
       * @param {HTMLElement} scope - form or step block containing one picker.
       * @param {string} hiddenClass - selector of the value-carrying input.
       */
      function wireSkillPicker(scope: HTMLElement, hiddenClass: string) {
        const picker = scope.querySelector<HTMLElement>('[data-skill-picker]')
        if (picker === null) return
        const trigger = picker.querySelector<HTMLButtonElement>('.lm-picker-trigger')!
        const menu = picker.querySelector<HTMLElement>('.lm-picker-menu')!
        const filter = picker.querySelector<HTMLInputElement>('.lm-picker-filter')
        const valueField = scope.querySelector<HTMLInputElement>(`.${hiddenClass}`)
        trigger.addEventListener('click', () => {
          menu.hidden = !menu.hidden
          trigger.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true')
          if (!menu.hidden && filter !== null) filter.focus()
        })
        for (const option of picker.querySelectorAll<HTMLElement>('[data-skill-pick]')) {
          option.addEventListener('click', () => {
            const name = option.dataset.skillPick || ''
            const entry = state.skills.find((candidate) => candidate.name === name)
            if (valueField !== null) valueField.value = name
            picker.querySelector<HTMLElement>('.lm-picker-name')!.textContent = name
            picker.querySelector<HTMLElement>('.lm-picker-desc')!.textContent =
              entry && entry.description ? entry.description : '（无描述）'
            for (const other of picker.querySelectorAll<HTMLElement>('[data-skill-pick]')) {
              const active = other === option
              other.classList.toggle('is-active', active)
              other.setAttribute('aria-selected', active ? 'true' : 'false')
            }
            menu.hidden = true
            trigger.setAttribute('aria-expanded', 'false')
          })
        }
        if (filter === null) return
        const options = Array.from(picker.querySelectorAll<HTMLElement>('[data-skill-pick]'))
        let cursor = -1

        /**
         * Visible options in *display* order (the filter re-sorts the DOM, so
         * the array captured at setup no longer reflects what the user sees).
         * @returns {HTMLElement[]}
         */
        const visibleOptions = () => Array.from(picker.querySelectorAll<HTMLElement>('[data-skill-pick]:not([hidden])'))

        /** Move the keyboard cursor to one visible option. */
        const setCursor = (next: number) => {
          const visible = visibleOptions()
          if (visible.length === 0) {
            cursor = -1
            return
          }
          cursor = Math.max(0, Math.min(next, visible.length - 1))
          for (const option of options) option.classList.remove('is-cursor')
          const active = visible[cursor]
          active.classList.add('is-cursor')
          if (typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
        }

        const list = picker.querySelector<HTMLElement>('.lm-picker-list')

        /**
         * Rank one option against the query: name matches always beat
         * description matches, and a name prefix beats a name substring.
         * @param {HTMLElement} option - picker option.
         * @param {string} query - lower-cased full query.
         * @param {string[]} tokens - lower-cased query tokens.
         * @returns {number} 0 = no match, lower is better.
         */
        const scoreOf = (option: HTMLElement, query: string, tokens: string[]) => {
          const name = (option.dataset.skillPick || '').toLowerCase()
          const description = option.querySelector<HTMLElement>('span')
          const text = (description?.textContent || '').toLowerCase()
          if (tokens.length === 0) return 1
          if (!tokens.every((token) => name.includes(token) || text.includes(token))) return 0
          if (name === query) return 1
          if (name.startsWith(query)) return 2
          if (tokens.every((token) => name.includes(token))) return 3
          if (tokens.some((token) => name.includes(token))) return 4
          return 5
        }

        // Live filter + relevance sort: typing narrows the list as you go and
        // keeps the best name match on top, so Enter selects it.
        const applyFilter = () => {
          const query = filter.value.trim().toLowerCase()
          const tokens = query === '' ? [] : query.split(/\s+/)
          /** @type {Array<{ option: HTMLElement, score: number }>} */
          const ranked = []
          for (const option of options) {
            const score = scoreOf(option, query, tokens)
            option.hidden = score === 0
            option.classList.remove('is-cursor')
            if (score !== 0) ranked.push({ option, score })
          }
          ranked.sort(
            (left, right) =>
              left.score - right.score ||
              (left.option.dataset.skillPick || '').localeCompare(right.option.dataset.skillPick || ''),
          )
          if (list !== null) for (const { option } of ranked) list.appendChild(option)
          const empty = picker.querySelector<HTMLElement>('.lm-picker-empty')
          if (empty !== null) empty.hidden = ranked.length !== 0
          cursor = -1
          if (ranked.length > 0) setCursor(0)
        }

        filter.addEventListener('input', applyFilter)
        filter.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setCursor(cursor + 1)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setCursor(cursor <= 0 ? 0 : cursor - 1)
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            const visible = visibleOptions()
            const chosen = cursor >= 0 && cursor < visible.length ? visible[cursor] : visible[0]
            if (chosen !== undefined) chosen.click()
            return
          }
          if (event.key === 'Escape') {
            menu.hidden = true
            trigger.setAttribute('aria-expanded', 'false')
          }
        })
      }

      /**
       * Add/edit one node. A node is either an AGENT instruction (free text) or a
       * SKILL node that pins one installed skill plus optional supplementary text.
       * @param {string|null} nodeId - existing node id, or null to create.
       * @param {{type?: string, name?: string, command?: string, skill?: string, model?: {provider: string, model: string}|null}} [draft] - form state to re-render with.
       */
      function openNodeModal(nodeId: string | null, draft?: ClientNodeDraft) {
        const pipeline = pipelineById(state.selected)
        if (pipeline === undefined) return
        const node = nodeId ? pipeline.nodes.find((candidate) => candidate.id === nodeId) : null
        state.editingNodeId = node ? node.id : null
        const current =
          draft ||
          (node
            ? {
                type: node.type === 'skill' ? 'skill' : 'agent',
                name: node.name,
                command: node.command || '',
                skill: node.skill || '',
                model: node.model || null,
              }
            : { type: 'agent', name: '', command: '', skill: '', model: null })
        const isSkill = current.type === 'skill'

        // The installed-skill catalog backs the selector; an empty catalog falls
        // back to a free-text name so the editor never becomes unusable.
        const skillControl = isSkill ? skillControlMarkup(current.skill, 'lm-field-skill') : ''

        const commandLabel = isSkill ? '补充信息（可选）' : 'Agent 命令'
        const commandPlaceholder = isSkill
          ? '告诉 agent 这次要完成什么、要什么输出… 可以用 {{input}} 引用上游节点输出'
          : '描述任务目标、输入、执行要求和预期输出…'
        const commandHelp = isSkill
          ? '节点会先加载所选 skill，再把这段补充信息作为本次任务的输入。'
          : '这段命令就是该节点的完整指令。需要已有 Skill 或 MCP 工具时，直接在命令里写明名字即可。'

        openModal(
          `<form class="modal"><h2>${node ? '编辑节点' : '添加节点'}</h2>` +
            '<label>节点类型</label>' +
            '<div class="lm-seg" role="group" aria-label="节点类型">' +
            `<button type="button" class="lm-seg-btn${isSkill ? '' : ' active'}" data-node-type="agent" aria-pressed="${isSkill ? 'false' : 'true'}">Agent 指令</button>` +
            `<button type="button" class="lm-seg-btn${isSkill ? ' active' : ''}" data-node-type="skill" aria-pressed="${isSkill ? 'true' : 'false'}">Skill</button>` +
            '</div>' +
            `<input type="hidden" class="lm-field-type" value="${isSkill ? 'skill' : 'agent'}">` +
            `<label>节点名称</label><input class="lm-field-name" required maxlength="40" value="${esc(current.name)}" placeholder="例如：收集行业资讯">` +
            skillControl +
            modelControlMarkup(current.model) +
            `<label>${commandLabel}</label>` +
            `<textarea class="lm-field-command" placeholder="${esc(commandPlaceholder)}">${esc(current.command)}</textarea>` +
            `<p>${esc(commandHelp)}</p>` +
            '<div class="modal-actions">' +
            (node ? '<button type="button" class="danger" data-action="delete-node">删除节点</button>' : '') +
            '<button type="button" data-action="close">取消</button><button class="primary" type="submit">保存</button></div></form>',
          async (form) => {
            const values = readNodeForm(form)
            const name = values.name.trim()
            const command = values.command.trim()
            const skill = values.skill.trim()
            const model =
              values.model && typeof values.model.provider === 'string' && typeof values.model.model === 'string'
                ? { provider: values.model.provider, model: values.model.model }
                : null
            if (name === '') {
              toast('请输入名称')
              return
            }
            if (values.type === 'skill') {
              if (skill === '') {
                toast('请选择或填写一个已安装的 Skill')
                return
              }
            } else if (command === '') {
              toast('请输入 Agent 命令')
              return
            }
            const record =
              values.type === 'skill'
                ? {
                    id: node ? node.id : newId(),
                    name,
                    type: 'skill',
                    skill,
                    command,
                    ...(model === null ? {} : { model }),
                  }
                : { id: node ? node.id : newId(), name, type: 'agent', command, ...(model === null ? {} : { model }) }
            const nodes = node
              ? pipeline.nodes.map((candidate) => (candidate.id === node.id ? record : candidate))
              : pipeline.nodes.concat([record])
            closeModal()
            await savePipeline(Object.assign({}, pipeline, { nodes }))
            toast('已保存')
          },
        )

        const form = overlay.querySelector<HTMLFormElement>('form')
        if (form === null) return

        // The model catalog is shared with the chat composer. If the popup
        // opened before that catalog finished loading, refresh the form once it
        // arrives, keeping whatever the author already typed.
        if (state.modelsAt === 0) {
          const modalForm = form
          void loadModels().then(() => {
            if (disposed || state.models.length === 0) return
            if (overlay.querySelector<HTMLFormElement>('form') !== modalForm) return
            if (state.editingNodeId !== (node ? node.id : null)) return
            openNodeModal(node ? node.id : null, readNodeForm(modalForm))
          })
        }

        // Switching the type keeps whatever the author already typed.
        for (const button of form.querySelectorAll<HTMLElement>('[data-node-type]')) {
          button.addEventListener('click', () => {
            const values = readNodeForm(form)
            if (button.dataset.nodeType === values.type) return
            values.type = button.dataset.nodeType || 'agent'
            if (values.type === 'skill' && state.skills.length === 0 && !state.skillsLoading) {
              void loadSkills().then(() => openNodeModal(state.editingNodeId, values))
              return
            }
            openNodeModal(state.editingNodeId, values)
          })
        }

        // The skill picker: a two-line trigger plus a searchable menu, so long
        // skill descriptions never squeeze the control (the native <select> did).
        wireSkillPicker(form, 'lm-field-skill')
      }

      async function deleteNode() {
        const pipeline = pipelineById(state.selected)
        const nodeId = state.editingNodeId
        closeModal()
        if (pipeline === undefined || !nodeId) return
        await savePipeline(
          Object.assign({}, pipeline, {
            nodes: pipeline.nodes.filter((node) => node.id !== nodeId),
            edges: pipeline.edges.filter((edge) => edge[0] !== nodeId && edge[1] !== nodeId),
          }),
        )
        toast('节点已删除')
      }

      /** Read the database modal's fields into the API payload. */
      function readDbForm(form: HTMLFormElement) {
        const valueOf = (selector: string, fallback = '') => {
          const field = form.querySelector<HTMLInputElement>(selector)
          return field === null ? fallback : field.value
        }
        const checked = (selector: string) => {
          const field = form.querySelector<HTMLInputElement>(selector)
          return field !== null && field.checked === true
        }
        return {
          host: valueOf('.lm-field-db-host').trim(),
          port: Number(valueOf('.lm-field-db-port', '5432')),
          database: valueOf('.lm-field-db-database').trim(),
          user: valueOf('.lm-field-db-user').trim(),
          password: valueOf('.lm-field-db-password'),
          ssl: checked('.lm-field-db-ssl'),
          readFromDb: checked('.lm-field-db-read'),
        }
      }

      /** Client-side validation shared by test and save. */
      function dbValuesError(values: ClientDbValues) {
        if (values.host === '') return '请填写主机'
        if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) return '端口必须是 1–65535 的整数'
        if (values.database === '') return '请填写数据库名'
        if (values.user === '') return '请填写用户名'
        return null
      }

      /** Turn a DB request failure into actionable copy. */
      function dbFailureMessage(error: unknown) {
        const message = errorMessage(error)
        if (
          (error !== null && typeof error === 'object' && 'status' in error && error.status === 404) ||
          /unknown route/i.test(message)
        ) {
          return '宿主半还没有加载数据库功能：请完全退出并重新打开 DeepSeek Harness（只刷新页面无法更新 host 代码），然后重试。'
        }
        return message
      }

      /** Update the inline status line of the database modal. */
      function setDbStatus(form: HTMLFormElement, message: string, kind?: 'ok' | 'error') {
        const status = form.querySelector<HTMLElement>('[data-db-status]')
        if (status === null) return
        status.textContent = message
        status.classList.remove('is-ok', 'is-error')
        if (kind === 'ok') status.classList.add('is-ok')
        if (kind === 'error') status.classList.add('is-error')
      }

      /** Build the database configuration form. */
      function dbFormMarkup(info: ClientApiEnvelope | null, loadError: string | null) {
        const status =
          info !== null && typeof info === 'object' && info.db !== undefined && info.db !== null ? info.db : {}
        const config = status.config !== null && typeof status.config === 'object' ? status.config : {}
        const readFromDb = status.readFromDb === true || config.readFromDb === true
        const connected = status.connected === true
        const error = loadError || (typeof status.error === 'string' ? status.error : '')
        const statusText =
          error !== ''
            ? `连接失败：${error}`
            : connected
              ? `已连接 · 已初始化${readFromDb ? ' · 当前从数据库读取' : ' · 当前读取本地数据'}`
              : status.configured === true
                ? '已保存配置，尚未连接'
                : '尚未配置 PostgreSQL'
        const statusClass = error !== '' ? 'is-error' : connected ? 'is-ok' : ''
        const host = typeof config.host === 'string' && config.host !== '' ? config.host : '127.0.0.1'
        const port = typeof config.port === 'number' ? config.port : 5432
        const database = typeof config.database === 'string' && config.database !== '' ? config.database : 'postgres'
        const user = typeof config.user === 'string' && config.user !== '' ? config.user : 'postgres'
        const passwordPlaceholder = config.hasPassword === true ? '留空则保留已保存密码' : '数据库密码'
        return (
          '<form class="modal"><h2>数据库配置</h2>' +
          '<label class="lm-db-switch"><span><strong>从数据库读取</strong>' +
          '<small>开启后从 PostgreSQL 读取；写操作仍同时保存本地和数据库。</small></span>' +
          `<span class="lm-switch"><input type="checkbox" class="lm-field-db-read" ${readFromDb ? 'checked' : ''}><i></i></span></label>` +
          '<p>将 pipeline、节点与运行记录同步到 PostgreSQL。关闭读取开关时仍使用本地 state.json；开启后从数据库读取。</p>' +
          '<div class="lm-db-grid">' +
          `<div><label>主机</label><input class="lm-field-db-host" value="${esc(host)}" placeholder="127.0.0.1" autocomplete="off"></div>` +
          `<div><label>端口</label><input class="lm-field-db-port" type="number" min="1" max="65535" value="${esc(port)}"></div>` +
          '</div>' +
          `<label>数据库</label><input class="lm-field-db-database" value="${esc(database)}" placeholder="postgres" autocomplete="off">` +
          '<div class="lm-db-grid">' +
          `<div><label>用户</label><input class="lm-field-db-user" value="${esc(user)}" placeholder="postgres" autocomplete="off"></div>` +
          `<div><label>密码</label><input class="lm-field-db-password" type="password" value="" placeholder="${esc(passwordPlaceholder)}" autocomplete="new-password"></div>` +
          '</div>' +
          `<label class="lm-db-ssl"><input type="checkbox" class="lm-field-db-ssl" ${config.ssl === true ? 'checked' : ''}> 使用 SSL（跳过证书校验）</label>` +
          `<p class="lm-db-status ${statusClass}" data-db-status>${esc(statusText)}</p>` +
          '<p class="lm-db-hint">首次保存会自动建表并初始化 schema；数据库为空时会导入当前本地数据。</p>' +
          '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
          '<button type="button" data-action="db-test">测试连接</button>' +
          '<button class="primary" type="submit">保存并初始化</button></div></form>'
        )
      }

      /** Open the database configuration modal (loads current status first). */
      async function openDbModal() {
        let info = null
        let loadError = null
        try {
          info = await api('/db')
        } catch (error) {
          loadError = dbFailureMessage(error)
        }
        openModal(dbFormMarkup(info, loadError), async (form) => {
          const values = readDbForm(form)
          const invalid = dbValuesError(values)
          if (invalid !== null) {
            setDbStatus(form, invalid, 'error')
            return
          }
          const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
          if (submit !== null) submit.disabled = true
          setDbStatus(form, '正在连接并初始化数据库…')
          try {
            const body = await api('/db', { method: 'PUT', body: JSON.stringify(values) })
            await refresh()
            closeModal()
            const imported =
              body.imported !== null && typeof body.imported === 'object'
                ? body.imported
                : { importedPipelines: 0, importedRuns: 0 }
            const parts = ['数据库已连接并初始化']
            if (imported.importedPipelines > 0) parts.push(`导入 ${imported.importedPipelines} 条 pipeline`)
            if (imported.importedRuns > 0) parts.push(`${imported.importedRuns} 条运行记录`)
            if (body.db !== undefined && body.db !== null && body.db.readFromDb === true)
              parts.push('已切换为从数据库读取')
            toast(parts.join(' · '))
          } catch (error) {
            if (submit !== null) submit.disabled = false
            setDbStatus(form, dbFailureMessage(error), 'error')
          }
        })

        const form = overlay.querySelector<HTMLFormElement>('form')
        if (form === null) return
        const testButton = form.querySelector<HTMLButtonElement>('[data-action="db-test"]')
        if (testButton !== null) {
          testButton.addEventListener('click', async () => {
            const values = readDbForm(form)
            const invalid = dbValuesError(values)
            if (invalid !== null) {
              setDbStatus(form, invalid, 'error')
              return
            }
            testButton.disabled = true
            setDbStatus(form, '正在连接并初始化…')
            try {
              await api('/db/test', { method: 'POST', body: JSON.stringify(values) })
              setDbStatus(form, '连接成功，数据库已初始化。', 'ok')
            } catch (error) {
              setDbStatus(form, dbFailureMessage(error), 'error')
            } finally {
              testButton.disabled = false
            }
          })
        }
      }

      // ---------------- v9 Loop modals (CONTRACT §13.7) ----------------

      /** Confirm before starting a Loop run (each group starts real agent sessions). */
      function openLoopRunConfirm(loop: ClientLoop) {
        if (loop.steps.length === 0) {
          toast('请先添加 Pipeline 与门禁步骤')
          return
        }
        if (loop.steps.some((step) => pipelineById(step.pipelineId) === undefined)) {
          toast('有步骤引用的 Pipeline 已不存在，请先编辑 Loop')
          return
        }
        const autoCount = loop.steps.filter((step) => step.gate.autoLoop === true).length
        const manualCount = loop.steps.length - autoCount
        let strategy
        if (autoCount === 0) strategy = '所有门禁都是手动循环：未通过时会停在等待人工，点「↻ 重新循环」继续。'
        else if (manualCount === 0)
          strategy = '所有门禁都开启自动循环：未通过时自动重跑本组 Pipeline，直到通过或达到上限。'
        else strategy = `${autoCount} 组门禁自动循环，${manualCount} 组等待人工确认。`
        openModal(
          '<form class="modal"><h2>开始任务？</h2>' +
            `<p>将按顺序运行「<b>${esc(loop.name)}</b>」的 <b>${loop.steps.length}</b> 组 Pipeline + 门禁，` +
            '每组 Pipeline 与门禁都会在 DeepSeek Harness 的 standard mode 下启动真实 Agent 会话。</p>' +
            `<p>${esc(strategy)}</p>` +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="primary" data-action="confirm-loop-run" data-target-loop="${esc(loop.id)}">开始任务</button>` +
            '</div></form>',
        )
      }

      /** Confirm before stopping the active LoopRun. */
      function openLoopStopConfirm(runId: string) {
        const run = loopRunById(runId)
        const loop = run === null ? undefined : loopById(run.loopId)
        const name =
          loop !== undefined
            ? loop.name
            : run !== null && typeof run.loopName === 'string' && run.loopName !== ''
              ? run.loopName
              : runId
        const elapsed =
          run !== null && typeof run.startedAt === 'number' ? durationText(Date.now() - run.startedAt) : ''
        let currentName = ''
        if (loop !== undefined && run !== null) {
          const currentId = currentStepIdOf(loop, run)
          const currentStep = currentId === null ? undefined : loop.steps.find((step) => step.id === currentId)
          if (currentStep !== undefined) currentName = currentStep.gate.name
        }
        const timing =
          elapsed === ''
            ? ''
            : `<p>已运行 ${esc(elapsed)}${currentName === '' ? '' : `，当前门禁：${esc(currentName)}`}。</p>`
        openModal(
          '<form class="modal"><h2>停止任务？</h2>' +
            `<p>将中止「<b>${esc(name)}</b>」当前正在运行的 Loop。已完成的组会保留，未执行的组不会继续。</p>` +
            timing +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="lm-stop" data-action="confirm-loop-stop" data-target-loop-run="${esc(runId)}">停止任务</button>` +
            '</div></form>',
        )
      }

      /** Confirm a manual re-loop for one waiting group (§13.7). */
      function openLoopRetryConfirm(stepId: string) {
        const loop = state.selectedLoop === null ? undefined : loopById(state.selectedLoop)
        if (loop === undefined) return
        const run = lastLoopRunOf(loop.id)
        if (run === null) return
        const index = loop.steps.findIndex((step) => step.id === stepId)
        if (index < 0) return
        const step = loop.steps[index]
        const pipeline = pipelineById(step.pipelineId)
        const stepState = stepStateOf(run, step.id)
        const reason =
          typeof stepState.gateError === 'string' && stepState.gateError !== ''
            ? stepState.gateError
            : typeof stepState.error === 'string'
              ? stepState.error
              : ''
        openModal(
          '<form class="modal"><h2>重新循环？</h2>' +
            `<p>将从第 ${index + 1} 组重新执行：先运行 Pipeline「<b>${esc(pipeline === undefined ? '已删除的 Pipeline' : pipeline.name)}</b>」，` +
            `再由门禁「<b>${esc(step.gate.name)}</b>」重新判断。</p>` +
            (reason === '' ? '' : `<p>${esc(reason)}</p>`) +
            '<p>人工重新循环不计入自动循环上限。</p>' +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="primary" data-action="confirm-loop-retry" data-target-loop-run="${esc(run.id)}" data-target-step="${esc(step.id)}">重新循环</button>` +
            '</div></form>',
        )
      }

      function openLoopMoreMenu(loop: ClientLoop) {
        openModal(
          `<form class="modal"><h2>${esc(loop.name)}</h2><p>管理这个 Loop</p>` +
            '<div class="modal-actions">' +
            `<button type="button" data-action="toggle-loop-star" data-target-loop="${esc(loop.id)}">${loop.star ? '取消收藏' : '收藏'}</button>` +
            `<button type="button" class="danger" data-action="ask-remove-loop" data-target-loop="${esc(loop.id)}">删除 Loop</button>` +
            '<button type="button" data-action="close">关闭</button></div></form>',
        )
      }

      function openDeleteLoop(loop: ClientLoop) {
        openModal(
          '<form class="modal"><h2>删除 Loop？</h2>' +
            '<p>将删除这个 Loop 及其运行记录。被引用的 Agent Pipeline 不会被删除。</p>' +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="danger" data-action="confirm-remove-loop" data-target-loop="${esc(loop.id)}">确认删除</button></div></form>`,
        )
      }

      function openMoreMenu(pipeline: ClientPipeline) {
        openModal(
          `<form class="modal"><h2>${esc(pipeline.name)}</h2><p>管理这条 Pipeline</p>` +
            '<div class="modal-actions">' +
            `<button type="button" data-action="toggle-star" data-target-pipeline="${esc(pipeline.id)}">${pipeline.star ? '取消收藏' : '收藏'}</button>` +
            `<button type="button" class="danger" data-action="ask-remove" data-target-pipeline="${esc(pipeline.id)}">删除 Pipeline</button>` +
            '<button type="button" data-action="close">关闭</button></div></form>',
        )
      }

      function openDeletePipeline(pipeline: ClientPipeline) {
        openModal(
          '<form class="modal"><h2>删除 Pipeline？</h2><p>将删除此工作流的所有节点、连接与运行记录。</p>' +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="danger" data-action="confirm-remove" data-target-pipeline="${esc(pipeline.id)}">确认删除</button></div></form>`,
        )
      }

      /** Confirm before starting a real DSH run (the run may spawn many agent sessions). */
      function openRunConfirm(pipeline: ClientPipeline) {
        if (pipeline.nodes.length === 0) {
          toast('请先添加节点')
          return
        }
        if (topo(pipeline.nodes, pipeline.edges) === null) {
          toast('图中存在循环依赖')
          return
        }
        const pinnedCount = pipeline.nodes.filter(
          (node) =>
            node.model !== null &&
            typeof node.model === 'object' &&
            typeof node.model.provider === 'string' &&
            typeof node.model.model === 'string',
        ).length
        const modelLine =
          pinnedCount === 0
            ? '所有节点跟随 Harness 默认模型。'
            : `${pinnedCount} 个节点使用指定模型，其余跟随 Harness 默认模型。`
        openModal(
          '<form class="modal"><h2>开始任务？</h2>' +
            `<p>将按依赖顺序执行「<b>${esc(pipeline.name)}</b>」的 <b>${pipeline.nodes.length}</b> 个节点，` +
            '每个节点都会在 DeepSeek Harness 的 standard mode 下启动一次真实 Agent 会话。</p>' +
            `<p>${esc(modelLine)}</p>` +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="primary" data-action="confirm-run" data-target-pipeline="${esc(pipeline.id)}">开始任务</button>` +
            '</div></form>',
        )
      }

      /** Confirm before stopping the active run of one pipeline. */
      function openStopConfirm(runId: string) {
        const run = state.runs.find((candidate) => candidate.id === runId)
        const pipeline = run ? pipelineById(run.pipelineId) : undefined
        const name = pipeline
          ? pipeline.name
          : run && typeof run.pipelineName === 'string' && run.pipelineName !== ''
            ? run.pipelineName
            : runId
        const elapsed = run && typeof run.startedAt === 'number' ? durationText(Date.now() - run.startedAt) : ''
        let currentName = ''
        if (run && pipeline) {
          const runningId = run.order.find(
            (id) => (run.nodeStates && run.nodeStates[id] ? run.nodeStates[id].status : '') === 'running',
          )
          const runningNode = pipeline.nodes.find((node) => node.id === runningId)
          if (runningNode) currentName = runningNode.name
        }
        const timing =
          elapsed === ''
            ? ''
            : `<p>已运行 ${esc(elapsed)}${currentName === '' ? '' : `，当前节点：${esc(currentName)}`}。</p>`
        openModal(
          '<form class="modal"><h2>停止任务？</h2>' +
            `<p>将中止「<b>${esc(name)}</b>」当前正在运行的任务。已完成节点的输出会保留，未执行的节点不会继续。</p>` +
            timing +
            '<div class="modal-actions"><button type="button" data-action="close">取消</button>' +
            `<button type="button" class="lm-stop" data-action="confirm-stop" data-target-run="${esc(runId)}">停止任务</button>` +
            '</div></form>',
        )
      }

      async function removePipeline(pipeline: ClientPipeline) {
        closeModal()
        await mutate(async () => {
          await api(`/pipelines/${pipeline.id}`, { method: 'DELETE' })
          if (state.selected === pipeline.id) state.selected = null
        }, '已删除')
      }

      // ---------------- event wiring ----------------

      function onClick(event: MouseEvent) {
        if (!(event.target instanceof Element)) return
        // A click on a thinking summary toggles the native <details>. Record the
        // resulting state before the next poll re-renders the log.
        const summary =
          event.target && typeof event.target.closest === 'function' ? event.target.closest('summary') : null
        if (
          summary !== null &&
          summary.parentElement !== null &&
          summary.parentElement.classList.contains('lm-think')
        ) {
          const details = summary.parentElement as HTMLDetailsElement
          const thinkKey = details.dataset.thinkKey
          if (typeof thinkKey === 'string' && thinkKey !== '') {
            if (details.open) state.openThinking.delete(thinkKey)
            else state.openThinking.add(thinkKey)
          }
        }
        const target = event.target.closest<HTMLElement>('button,[data-open],[data-open-loop]')
        if (!target || !root.contains(target)) return
        const data = target.dataset
        if (data.db) {
          void openDbModal()
          return
        }
        if (data.nav) {
          state.nav = data.nav as ClientState['nav']
          state.selected = null
          state.selectedLoop = null
          state.loopDraft = null
          state.filter = 'all'
          state.query = ''
          render()
          return
        }
        if (data.open) {
          state.nav = 'all'
          state.selected = data.open
          state.selectedLoop = null
          render()
          return
        }
        if (data.openLoop) {
          state.nav = 'loops'
          state.selected = null
          state.selectedLoop = data.openLoop
          render()
          return
        }
        if (data.loopRun) {
          const loop = loopById(data.loopRun)
          if (loop) openLoopRunConfirm(loop)
          return
        }
        if (data.loopStop) {
          openLoopStopConfirm(data.loopStop)
          return
        }
        if (data.loopMenu) {
          const loop = loopById(data.loopMenu)
          if (loop) openLoopMoreMenu(loop)
          return
        }
        if (data.loopRetry) {
          openLoopRetryConfirm(data.loopRetry)
          return
        }
        if (data.run) {
          const target = pipelineById(data.run)
          if (target) openRunConfirm(target)
          return
        }
        if (data.stop) {
          openStopConfirm(data.stop)
          return
        }
        if (data.menu) {
          const pipeline = pipelineById(data.menu)
          if (pipeline) openMoreMenu(pipeline)
          return
        }
        if (data.node) {
          openNodeModal(data.node)
          return
        }
        if (data.deleteEdge !== undefined) {
          void deleteEdge(Number(data.deleteEdge))
          return
        }
        if (data.deleteRun) {
          void mutate(() => api(`/runs/${data.deleteRun}`, { method: 'DELETE' }), '记录已删除')
          return
        }
        if (data.filter) {
          state.filter = data.filter as ClientState['filter']
          render()
          return
        }
        const pipeline = pipelineById(state.selected)
        switch (data.action) {
          case 'create':
            openPipelineModal(false)
            return
          case 'edit-pipeline':
            openPipelineModal(true)
            return
          case 'back':
            state.selected = null
            render()
            return
          case 'close':
            closeModal()
            return
          case 'add-node':
            openNodeModal(null)
            return
          case 'add-edge':
            void addEdge()
            return
          case 'delete-node':
            void deleteNode()
            return
          case 'toggle-star': {
            closeModal()
            const targetPipeline = data.targetPipeline ? pipelineById(data.targetPipeline) : pipeline
            if (targetPipeline) void patchPipeline(targetPipeline.id, { star: !targetPipeline.star })
            return
          }
          case 'ask-remove': {
            const targetPipeline = data.targetPipeline ? pipelineById(data.targetPipeline) : pipeline
            if (targetPipeline) openDeletePipeline(targetPipeline)
            return
          }
          case 'confirm-remove': {
            const targetPipeline = data.targetPipeline ? pipelineById(data.targetPipeline) : pipeline
            if (targetPipeline) void removePipeline(targetPipeline)
            return
          }
          case 'confirm-run':
            closeModal()
            if (data.targetPipeline) void runPipeline(data.targetPipeline)
            return
          case 'confirm-stop':
            closeModal()
            if (data.targetRun) void stopRun(data.targetRun)
            return
          case 'create-loop':
            openLoopEditor(false, false)
            return
          case 'edit-loop':
            openLoopEditor(true, false)
            return
          case 'edit-loop-add':
            openLoopEditor(true, true)
            return
          case 'loop-back':
            state.selectedLoop = null
            render()
            return
          case 'toggle-loop-star': {
            closeModal()
            const targetLoop = data.targetLoop ? loopById(data.targetLoop) : undefined
            if (targetLoop) void patchLoop(targetLoop.id, { star: !targetLoop.star })
            return
          }
          case 'ask-remove-loop': {
            const targetLoop = data.targetLoop ? loopById(data.targetLoop) : undefined
            if (targetLoop) openDeleteLoop(targetLoop)
            return
          }
          case 'confirm-remove-loop': {
            const targetLoop = data.targetLoop ? loopById(data.targetLoop) : undefined
            if (targetLoop) void removeLoop(targetLoop)
            return
          }
          case 'confirm-loop-run':
            closeModal()
            if (data.targetLoop) void runLoop(data.targetLoop)
            return
          case 'confirm-loop-stop':
            closeModal()
            if (data.targetLoopRun) void stopLoopRun(data.targetLoopRun)
            return
          case 'confirm-loop-retry':
            closeModal()
            if (data.targetLoopRun && data.targetStep) void retryLoopRun(data.targetLoopRun, data.targetStep)
            return
          default:
            return
        }
      }

      function onInput(event: Event) {
        if (!(event.target instanceof HTMLInputElement)) return
        if (!event.target.classList || !event.target.classList.contains('lm-search')) return
        const caret = event.target.selectionStart
        state.query = event.target.value
        render()
        const next = root.querySelector<HTMLInputElement>('.lm-search')
        if (next) {
          next.focus()
          next.setSelectionRange(caret, caret)
        }
      }

      function onChange(event: Event) {
        const element = event.target
        if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return
        // Loop gate「自动循环」switch: reveal/hide the 1–20 iteration limit.
        if (element.classList.contains('lm-field-gate-auto')) {
          const block = typeof element.closest === 'function' ? element.closest('.lm-loop-step') : null
          const max = block === null ? null : block.querySelector<HTMLElement>('.lm-loop-max')
          if (max !== null) max.hidden = !(element instanceof HTMLInputElement && element.checked === true)
          return
        }
        if (!element.classList.contains('lm-sort')) return
        state.sort = element.value === 'name' ? 'name' : 'recent'
        render()
      }

      function onKeyDown(event: KeyboardEvent) {
        if (!(event.target instanceof HTMLElement)) return
        if (event.key === 'Escape') {
          closeModal()
          return
        }
        if (
          event.key === 'Enter' &&
          event.target.matches &&
          (event.target.matches('[data-open]') || event.target.matches('[data-open-loop]'))
        ) {
          event.preventDefault()
          if (event.target.matches('[data-open-loop]')) {
            state.nav = 'loops'
            state.selected = null
            state.selectedLoop = event.target.dataset.openLoop || null
          } else {
            state.nav = 'all'
            state.selected = event.target.dataset.open || null
            state.selectedLoop = null
          }
          render()
        }
      }

      function onScroll() {
        state.scrollTop = scroll.scrollTop
      }

      function onVisibility() {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh()
      }

      root.addEventListener('click', onClick)
      root.addEventListener('input', onInput)
      root.addEventListener('change', onChange)
      root.addEventListener('keydown', onKeyDown)
      scroll.addEventListener('scroll', onScroll, { passive: true })
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

      void refresh()
      void loadSkills()
      void loadModels()

      return function dispose() {
        disposed = true
        if (timer !== null) clearTimeout(timer)
        root.removeEventListener('click', onClick)
        root.removeEventListener('input', onInput)
        root.removeEventListener('change', onChange)
        root.removeEventListener('keydown', onKeyDown)
        scroll.removeEventListener('scroll', onScroll)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        if (state.toastTimer !== null) clearTimeout(state.toastTimer)
        root.innerHTML = ''
      }
    }

    // ------------------------------------------------------------------
    // React mount points for the two host slots
    // ------------------------------------------------------------------

    /** Left-sidebar glyph: a tiny DAG, sized by the host, currentColor. */
    function LoopGlyph(props: ClientSlotOwner) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      return h(
        'svg',
        {
          className: 'lm-glyph',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', { key: 'a', x: 3, y: 4, width: 6, height: 6, rx: 1.5 }),
        h('rect', { key: 'b', x: 15, y: 4, width: 6, height: 6, rx: 1.5 }),
        h('rect', { key: 'c', x: 9, y: 14, width: 6, height: 6, rx: 1.5 }),
        h('path', { key: 'ab', d: 'M9 7h6' }),
        h('path', { key: 'ac', d: 'M6 10v2.5h6V14' }),
        h('path', { key: 'bc', d: 'M18 10v2.5h-6V14' }),
      )
    }

    /** Mount the workbench once per panel mount. */
    function LoopPage() {
      const container = useRef<HTMLElement | null>(null)
      useEffect(() => {
        if (!container.current) return undefined
        return createApp(container.current)
      }, [])
      return h('div', { className: 'lm-root', ref: container })
    }

    /** Inject the scoped stylesheet once per plugin lifetime. */
    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-dsh-loop-manager', '')
      style.textContent = LM_CSS + LM_EXTRA_CSS
      document.head.appendChild(style)
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    /** Client plugin body. */
    function apply(ctx: ClientHostContext) {
      const disposeStyles = installStyles()
      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => disposeStyles, 'dsh-loop-manager: styles')
        } catch {
          // The stylesheet stays until unload; the page itself still works.
        }
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
        return
      }
      // Left sidebar row: the host maps a click to selectPanel(PANEL_ID).
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 5,
            label: () => PANEL_LABEL,
          },
          (owner) =>
            h(LoopGlyph, { size: owner && owner.size ? owner.size : 18, active: owner ? owner.active : false }),
        ),
      )
      // The page itself, selected by the shared id.
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          () => h(LoopPage),
        ),
      )
    }

    return { name: 'dsh-loop-manager', inject: ['slots'], apply }
  },
})
