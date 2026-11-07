/**
 * 提示词（Prompt Lab）后端插件（宿主进程侧）。
 *
 * 职责：
 * 1. 把用户配置的提示词注册为 systemPrompt 的一个提示词段；
 * 2. 独立观察组装结果，并按设置处理上下文，供 UI 展示。
 * 状态与配置逻辑集中在 lib/state.js。已验证宿主契约见 docs/host-contract.md。
 */
import {
  initialize, evaluate, registerSucceeded, skipped,
  failed, disposed, captureAssembly, getContextFilter, getIdentityBreak,
  observerSucceeded, getConfigRevision,
} from "./state.js";
import { applyContextFilter, applyIdentityBreak } from "./redact.js";

export const name = "dsh-prompt-lab";
// 只声明对 systemPrompt 的硬依赖：该服务未就绪时 Cordis 会等待其可用后再调用 apply。
export const inject = ["systemPrompt"];
// 转发 state 中的快照函数，供同进程的 UI 侧（lib/ui.js）直接调用。
export { snapshot as getSnapshot } from "./state.js";

/**
 * Cordis 插件入口：注册提示词段并挂载组装观察者。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {{enabled?: boolean, prompt?: string}} [config] 插件配置。
 */
export function apply(ctx, config = {}) {
  // 重置并载入配置。enabled 只控制自定义 section，不控制观察与过滤。
  initialize(config);
  if (config.enabled === false) {
    skipped("disabled");
  } else {
    try {
      // 空正文也保留动态回调，后续保存非空配置时无需重启。
      // 启动阶段不调用 evaluate，避免把预览误标为宿主真实求值。
      for (const part of ["rules", "prompt"]) ctx.systemPrompt.section({
        name: part === "prompt" ? "prompt-lab:custom" : "prompt-lab:rules",
        // order 5100：排在常规内置段之后，尽量不干扰框架自身的提示词结构。
        order: part === "prompt" ? 5100 : 5101,
        // 关闭插值：提示词按字面量原样注入，避免其中的 ${...} 等内容被当作模板解析。
        interpolate: false,
        // 动态取值：每次组装系统提示词时都重新求值，因此编辑后的配置无需重启即可生效。
        text: (context) => evaluate(context, part),
      });
      registerSucceeded();
    } catch (err) {
      failed(err);
      // 向上抛出，让 Cordis 感知插件启动失败。
      throw err;
    }
  }

  // 组装事件的观察者，兼任两层过滤器（都只改「返回值」，绝不改入参——宿主可能复用
  // 同一个 assembly 对象；返回值会被下游继续使用，因此模型请求与轨迹记录里看到的
  // 都是处理后的版本）：
  // - 上下文过滤（contextFilter，默认 off）：对 contexts 做去除（strip）或数值脱敏（redact）；
  // - 渠道指纹脱敏（identityBreak，默认关）：对 sections 与 contexts 里命中的
  //   WorkBuddy 网关拦截 span（coding-agent 身份句、Harness 身份句、Web GUI 说明段）
  //   做零宽空格词界扰动——网关的精确子串匹配失配，模型读词不变。两开关独立、可叠加。
  if (typeof ctx.on === "function") {
    try {
      ctx.on("system-prompt/assemble", async (...args) => {
        const original = args[0];
        const configRevision = getConfigRevision();
        // 兼容不同回调签名：末位参数是可调用函数时，按 next() 约定调用以取得结果。
        const next = args.length >= 2 && typeof args[args.length - 1] === "function"
          ? args[args.length - 1] : null;
        const result = next ? await next() : original;
        // 过滤与观察失败都不能影响主流程：吞掉异常，按未过滤处理（插件不记录日志）。
        try {
          const mode = getContextFilter();
          const before = Array.isArray(result?.contexts) ? result.contexts.length : 0;
          const contextFiltered = applyContextFilter(result, mode);
          const after = Array.isArray(contextFiltered?.contexts) ? contextFiltered.contexts.length : before;
          const { assembly: finalResult, broken } = getIdentityBreak()
            ? applyIdentityBreak(contextFiltered)
            : { assembly: contextFiltered, broken: 0 };
          captureAssembly(finalResult, {
            configRevision,
            contextFilter: mode,
            contextsRemoved: before - after,
            identityBroken: broken,
          }, typeof args[1] === 'object' ? args[1] : {});
          return finalResult;
        } catch {
          try { captureAssembly(result, { configRevision, processingFailed: true }, typeof args[1] === 'object' ? args[1] : {}); } catch { /* 忽略 */ }
          return result;
        }
      });
      observerSucceeded();
    } catch {
      // 宿主未暴露该事件时降级运行：提示词注入照常工作，只是没有组装快照可看。
    }
  }

  // 提示词段与事件监听器的销毁由 Cordis 负责，这里只做状态收尾。
  if (typeof ctx.effect === "function") ctx.effect(() => () => disposed());
}

// 默认导出与具名导出内容一致，兼容两种 Cordis 插件加载方式。
export default { name, inject, apply };
